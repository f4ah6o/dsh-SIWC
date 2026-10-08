/** Host-owned ChatGPT account records, OAuth callbacks, and model resolution. */
import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialKeyId, credentialKeyScope } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationNotice, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { brandString } from '@deepseek-ai/dsh-brand'
import { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { Config } from './config.js'
import type { ChatGptAdapterHost, ChatGptPreparedCall } from './adapter-contract.js'
import {
  authorizationUrl, exchangeAuthorizationCode, OAuthError, randomOAuthValue,
  randomPkceVerifier, pkceChallenge, refreshGrant, revokeRefreshToken,
} from './oauth.js'
import type { OAuthGrant, OAuthIdentityExpectation } from './oauth.js'
import { officialOpenAiModel, toOpenAiModelInfo, toOpenAiResolvedModelInfo } from './models.js'
import type { ChatGptAccountId, ChatGptAccountView, ChatGptLoginAttemptId, ChatGptLoginAttemptView, ChatGptModelConfig, ChatGptModelView, ChatGptState } from './types.js'
import type {} from '@deepseek-ai/dsh-config-editor'

const CREDENTIAL_SCOPE = 'dsh-chatgpt'
const HOST_KEY = credentialKey(CREDENTIAL_SCOPE, 'host')
const ACCOUNT_ID_PREFIX = 'account-'
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client'
const CATALOG_URL = 'https://api.openai.com/v1/models'
const CALLBACK_PATH = '/auth/callback'
const ACCOUNT_REQUEST_ERROR = 'The ChatGPT account registration is unavailable.'

interface StoredHost {
  readonly version: 1
  readonly hostId: string
}

interface StoredAccount {
  readonly version: 1
  readonly accountId: string
  readonly clientId: string
  readonly subject: string
  /** Incremented by local logout to invalidate callbacks and requests from an older grant. */
  readonly grantGeneration: number
  readonly email?: string
  readonly accessToken?: string
  readonly refreshToken?: string
  readonly idToken?: string
  readonly expiresAt?: number
  readonly scopes?: readonly string[]
  readonly createdAt: number
  readonly status: 'connected' | 'needs-sign-in'
}

interface CatalogModel {
  readonly id: string
  readonly displayName: string
}

interface LoginAttempt {
  readonly id: ChatGptLoginAttemptId
  readonly accountId: ChatGptAccountId
  readonly key: CredentialKey
  readonly state: string
  readonly nonce: string
  readonly verifier: string
  readonly redirectUri: string
  readonly expectedIdentity?: OAuthIdentityExpectation
  readonly expectedGrantGeneration?: number
  readonly controller: AbortController
  readonly server: ReturnType<typeof createServer>
  readonly completion: Promise<void>
  readonly finish: (phase: ChatGptLoginAttemptView['phase'], message?: string) => void
  unregisterFlow: () => void
  authorizationRun: Promise<void>
  readonly publishAuthorizationUrl: (url: string) => void
  readonly rejectAuthorizationUrl: (error: Error) => void
  session?: AuthorizationSession
  committing: boolean
  phase: ChatGptLoginAttemptView['phase']
  message?: string
  readonly createdAt: number
  finishedAt?: number
  timeout: ReturnType<typeof setTimeout>
}

/** Manage account grants without exposing OAuth tokens to the Client. */
export class ChatGptHost implements ChatGptAdapterHost {
  private readonly attempts = new Map<string, LoginAttempt>()
  private readonly catalogs = new Map<string, readonly CatalogModel[]>()
  private readonly catalogLoads = new Map<string, Promise<readonly CatalogModel[]>>()
  private readonly catalogEpochs = new Map<string, number>()
  private readonly accountControllers = new Map<string, AbortController>()
  private activeInMemoryAccountId: ChatGptAccountId | undefined
  private disposed = false

  /** @param ctx - Host context with Credentials, Authorization, and LLM services. @param config - profile settings. */
  constructor(private readonly ctx: Context, private readonly config: Config) {}

  /** Ensure the installation has one durable host identity before it registers an account. */
  async initialize(): Promise<void> {
    await this.ctx.credentials.modifyRecord(HOST_KEY, async current => {
      if (current !== undefined) {
        readHost(current)
        return current
      }
      return { kind: 'grant', payload: { version: 1, hostId: randomUUID() } }
    })
  }

  /** Start a loopback callback and return only the external authorize URL and opaque handle. */
  async beginLogin(accountId?: ChatGptAccountId): Promise<{ attemptId: ChatGptLoginAttemptId; authorizationUrl: string }> {
    this.assertRunning()
    const existing = accountId === undefined ? undefined : await this.readAccount(accountId)
    if (accountId !== undefined && existing === undefined) throw new Error(ACCOUNT_REQUEST_ERROR)
    const selectedAccountId = accountId ?? newAccountId()
    const key = accountKey(selectedAccountId)
    if ([...this.attempts.values()].some(attempt => attempt.key === key && !isTerminal(attempt.phase))) {
      throw new Error('A ChatGPT sign-in is already running for this account.')
    }
    const host = readHost(await this.ctx.credentials.readRecord(HOST_KEY))
    const state = randomOAuthValue()
    const nonce = randomOAuthValue()
    const verifier = randomPkceVerifier()
    const controller = new AbortController()
    let server: ReturnType<typeof createServer>
    server = createServer((request, response) => {
      void this.handleCallback(request, response, this.attemptForServer(server))
    })
    await listenLoopback(server)
    const address = server.address()
    if (address === null || typeof address === 'string') {
      await closeServer(server)
      throw new Error('The ChatGPT sign-in callback did not receive a loopback port.')
    }
    const port = address.port
    const redirectUri = `http://127.0.0.1:${String(port)}${CALLBACK_PATH}`
    let complete!: () => void
    const completion = new Promise<void>(resolve => { complete = resolve })
    let publishAuthorizationUrl!: (url: string) => void
    let rejectAuthorizationUrl!: (error: Error) => void
    const authorizationUrlReady = new Promise<string>((resolve, reject) => {
      publishAuthorizationUrl = resolve
      rejectAuthorizationUrl = reject
    })
    void authorizationUrlReady.catch(() => undefined)
    const attemptId = brandString<ChatGptLoginAttemptId>(`login-${randomUUID()}`)
    let attempt: LoginAttempt
    attempt = {
      id: attemptId,
      accountId: selectedAccountId,
      key,
      state,
      nonce,
      verifier,
      redirectUri,
      ...(existing === undefined ? {} : { expectedIdentity: { clientId: existing.clientId, subject: existing.subject } }),
      ...(existing === undefined ? {} : { expectedGrantGeneration: existing.grantGeneration }),
      controller,
      server,
      completion,
      finish: (phase: ChatGptLoginAttemptView['phase'], message?: string): void => {
        if (isTerminal(attempt.phase)) return
        attempt.phase = phase
        if (message !== undefined) attempt.message = message
        attempt.finishedAt = Date.now()
        clearTimeout(attempt.timeout)
        complete()
      },
      unregisterFlow: () => undefined,
      authorizationRun: Promise.resolve(),
      publishAuthorizationUrl,
      rejectAuthorizationUrl,
      committing: false,
      phase: 'awaiting-browser',
      createdAt: Date.now(),
      timeout: setTimeout(() => {
        void this.stopAttempt(attempt, 'failed', 'ChatGPT sign-in timed out. Start again to continue.')
      }, this.config.loginTimeoutMs.get()),
    }
    attempt.timeout.unref()
    this.attempts.set(String(attemptId), attempt)
    try {
      attempt.unregisterFlow = this.ctx.authorization.registerFlow({
        key,
        label: 'ChatGPT',
        methods: [{ id: 'browser', label: 'Sign in with ChatGPT' }],
        run: async (session: AuthorizationSession): Promise<void> => {
          attempt.session = session
          const onAbort = (): void => {
            if (attempt.committing) return
            void this.stopAttempt(attempt, 'cancelled', 'ChatGPT sign-in was cancelled.')
          }
          session.signal.addEventListener('abort', onAbort, { once: true })
          try {
            session.signal.throwIfAborted()
            const authorize = authorizationUrl({
              clientId: existing?.clientId ?? DYNAMIC_CLIENT_ID,
              hostId: host.hostId,
              redirectUri,
              state,
              nonce,
              codeChallenge: pkceChallenge(verifier),
              newRegistration: existing === undefined,
              ...(existing?.email === undefined ? {} : { loginHint: existing.email }),
            })
            session.notify({ message: 'Continue in your browser to sign in to ChatGPT.', url: authorize })
            await attempt.completion
            if (attempt.phase !== 'complete') throw new Error(attempt.message ?? 'ChatGPT sign-in did not complete.')
          } finally {
            session.signal.removeEventListener('abort', onAbort)
          }
        },
      })
      attempt.authorizationRun = this.ctx.authorization.begin({
        key,
        signal: controller.signal,
        interaction: {
          notify: (notice: AuthorizationNotice): void => {
            if (notice.url !== undefined) attempt.publishAuthorizationUrl(notice.url)
          },
          prompt: async (): Promise<string> => {
            throw new Error('ChatGPT sign-in does not request input through the authorization prompt.')
          },
        },
      }).then(outcome => {
        if (outcome.status === 'cancelled' && attempt.committing) {
          return attempt.completion
        }
        if (outcome.status === 'cancelled' && !isTerminal(attempt.phase)) {
          return this.finishAttempt(attempt, 'cancelled', 'ChatGPT sign-in was cancelled.')
        }
        if (outcome.status === 'authorized' && attempt.phase !== 'complete') {
          return this.finishAttempt(attempt, 'failed', 'ChatGPT authorization ended before its grant was stored.')
        }
      }).catch(async (error: unknown) => {
        const message = safeLoginError(error)
        attempt.rejectAuthorizationUrl(new Error(message))
        if (!isTerminal(attempt.phase)) await this.finishAttempt(attempt, 'failed', message)
      }).finally(() => {
        attempt.unregisterFlow()
      })
    } catch (error: unknown) {
      const message = safeLoginError(error)
      attempt.rejectAuthorizationUrl(new Error(message))
      await this.finishAttempt(attempt, 'failed', message)
    }
    try {
      return { attemptId, authorizationUrl: await authorizationUrlReady }
    } catch (error: unknown) {
      await attempt.authorizationRun
      throw error
    }
  }

  /** Wait for one local callback to complete; used by the headless profile option. */
  async waitForLogin(attemptId: ChatGptLoginAttemptId): Promise<void> {
    const attempt = this.attempts.get(String(attemptId))
    if (attempt === undefined) throw new Error('ChatGPT sign-in attempt is no longer available.')
    await attempt.completion
    await attempt.authorizationRun
    if (attempt.phase !== 'complete') throw new Error(attempt.message ?? 'ChatGPT sign-in did not complete.')
  }

  /** Check whether the profile has any account that can authenticate a request. */
  async hasConnectedAccount(): Promise<boolean> {
    return (await this.accountRecords()).some(account => account.status === 'connected')
  }

  /** Cancel and close one pending loopback callback. */
  async cancelLogin(attemptId: ChatGptLoginAttemptId): Promise<void> {
    const attempt = this.attempts.get(String(attemptId))
    if (attempt === undefined || isTerminal(attempt.phase)) return
    await this.stopAttempt(attempt, 'cancelled', 'ChatGPT sign-in was cancelled.')
    await attempt.authorizationRun
  }

  /** Return a safe view of every account, model catalog, and recent login attempt. */
  async getState(): Promise<ChatGptState> {
    this.pruneAttempts()
    const accounts = await this.accountRecords()
    const connected = accounts.filter(account => account.status === 'connected')
    const active = this.selectActive(connected)
    const views = await Promise.all(accounts.map(async account => this.accountView(account, active?.accountId)))
    return {
      accounts: views,
      ...(active === undefined ? {} : { activeAccountId: accountIdOf(active.accountId) }),
      welcomeAcknowledged: this.config.welcomeAcknowledged.get(),
      loginAttempts: [...this.attempts.values()].sort((left, right) => right.createdAt - left.createdAt).map(attemptView),
      loginPollIntervalMs: this.config.loginPollIntervalMs.get(),
    }
  }

  /** Change the active account through the profile configuration editor. */
  async setActiveAccount(accountId: ChatGptAccountId): Promise<void> {
    const account = await this.readAccount(accountId)
    if (account?.status !== 'connected') throw new Error(ACCOUNT_REQUEST_ERROR)
    await this.persistConfig({ activeAccountId: String(accountId) })
    this.activeInMemoryAccountId = accountId
  }

  /** Revoke and locally disconnect one account while stopping its in-flight model calls. */
  async signOut(accountId: ChatGptAccountId): Promise<{ revocationConfirmed: boolean }> {
    const key = accountKey(accountId)
    const accountController = this.accountControllers.get(String(accountId)) ?? new AbortController()
    this.accountControllers.set(String(accountId), accountController)
    accountController.abort(new Error('ChatGPT account signed out'))
    for (const attempt of this.attempts.values()) {
      if (String(attempt.accountId) !== String(accountId) || isTerminal(attempt.phase)) continue
      await this.stopAttempt(attempt, 'cancelled', 'ChatGPT sign-in was cancelled because the account was disconnected.')
      await attempt.authorizationRun
    }
    let revocationConfirmed = false
    const next = await this.ctx.credentials.modifyRecord(key, async current => {
      if (current === undefined) return undefined
      const account = readAccount(current, String(accountId))
      if (account.status === 'connected' && typeof account.refreshToken === 'string' && account.refreshToken.length > 0) {
        revocationConfirmed = await revokeRefreshToken({
          clientId: account.clientId,
          refreshToken: account.refreshToken,
          requestTimeoutMs: this.config.requestTimeoutMs.get(),
        })
      }
      return {
        kind: 'grant',
        payload: {
          version: 1,
          accountId: account.accountId,
          clientId: account.clientId,
          subject: account.subject,
          grantGeneration: account.grantGeneration + 1,
          ...(account.email === undefined ? {} : { email: account.email }),
          createdAt: account.createdAt,
          status: 'needs-sign-in',
        },
      }
    })
    if (next === undefined) throw new Error(ACCOUNT_REQUEST_ERROR)
    this.invalidateCatalog(String(accountId))
    if (this.config.activeAccountId.get() === String(accountId)
      || String(this.activeInMemoryAccountId) === String(accountId)) {
      this.activeInMemoryAccountId = undefined
      await this.persistConfig({ activeAccountId: undefined })
    }
    return { revocationConfirmed }
  }

  /** Refresh one account's list-visible model catalog and return the updated state. */
  async refreshModels(accountId: ChatGptAccountId): Promise<ChatGptState> {
    const account = await this.readAccount(accountId)
    if (account?.status !== 'connected') throw new Error(ACCOUNT_REQUEST_ERROR)
    const accountSignal = this.accountSignal(account.accountId)
    accountSignal.throwIfAborted()
    this.invalidateCatalog(account.accountId)
    await this.loadCatalog(account)
    accountSignal.throwIfAborted()
    const current = await this.readAccount(accountId)
    if (current?.status !== 'connected' || current.grantGeneration !== account.grantGeneration) {
      throw new LlmError('The ChatGPT account grant changed while refreshing its model catalog', 'CHATGPT_ACCOUNT_CHANGED')
    }
    return await this.getState()
  }

  /** Store or remove one model capability override after checking its exact catalog id. */
  async setModelConfig(accountId: ChatGptAccountId, model: string, update: ChatGptModelConfig | null): Promise<ChatGptState> {
    const account = await this.readAccount(accountId)
    if (account?.status !== 'connected') throw new Error(ACCOUNT_REQUEST_ERROR)
    const catalog = await this.loadCatalog(account)
    if (!catalog.some(row => row.id === model)) throw new Error('Choose an exact model slug from the connected account catalog.')
    const current = [...this.config.modelOverrides.get()]
    const next = current.filter(row => row.model !== model)
    if (update !== null) next.push({ model, ...update })
    await this.persistConfig({ modelOverrides: next })
    return await this.getState()
  }

  /** Persist the once-only welcome acknowledgement in the active profile. */
  async acknowledgeWelcome(): Promise<void> {
    if (!this.config.welcomeAcknowledged.get()) await this.persistConfig({ welcomeAcknowledged: true })
  }

  /** List selectable models from the profile's active account after metadata admission. */
  async listModels(): Promise<readonly import('@deepseek-ai/dsh-llm').LlmModelInfo[]> {
    const account = await this.activeAccount()
    const rows = await this.loadCatalog(account)
    return rows.flatMap(row => {
      const model = this.resolveMetadata(row)
      return model === undefined ? [] : [toOpenAiModelInfo('chatgpt', model)]
    })
  }

  /** Resolve one exact list-visible model slug with official facts or an explicit context override. */
  async resolveModel(model: string, signal?: AbortSignal): Promise<import('@deepseek-ai/dsh-llm').LlmResolvedModelInfo> {
    signal?.throwIfAborted()
    const account = await this.activeAccount()
    return await this.resolveModelForAccount(account, model, signal)
  }

  private async resolveModelForAccount(
    account: StoredAccount,
    model: string,
    signal?: AbortSignal,
  ): Promise<import('@deepseek-ai/dsh-llm').LlmResolvedModelInfo> {
    signal?.throwIfAborted()
    const rows = await this.loadCatalog(account, signal)
    const row = rows.find(candidate => candidate.id === model)
    if (row === undefined) throw new LlmError(`ChatGPT model "${model}" is not list-visible for the active account`, 'UNKNOWN_MODEL')
    const metadata = this.resolveMetadata(row)
    if (metadata === undefined) {
      throw new LlmError(`ChatGPT model "${model}" needs a configured context-window limit`, 'MODEL_CONTEXT_REQUIRED')
    }
    const resolved = toOpenAiResolvedModelInfo('chatgpt', metadata)
    const override = this.config.modelOverrides.get().find(candidate => candidate.model === model)
    if (override === undefined) return resolved
    const reasoningEfforts = override.reasoningEfforts?.map(value => ReasoningEffortId(value))
    const defaultEffort = override.defaultReasoningEffort === undefined
      ? resolved.reasoning?.defaultEffort
      : ReasoningEffortId(override.defaultReasoningEffort)
    return {
      ...resolved,
      ...(override.contextWindow === undefined ? {} : { context: { contextWindow: override.contextWindow } }),
      ...(override.inputModalities === undefined ? {} : { inputModalities: override.inputModalities }),
      ...override.reasoningEfforts === undefined && defaultEffort === undefined ? {} : {
        reasoning: {
          efforts: (reasoningEfforts ?? resolved.reasoning?.efforts.map(effort => effort.id) ?? [])
            .map(id => ({ id, name: String(id) })),
          ...(defaultEffort === undefined ? {} : { defaultEffort }),
        },
      },
    }
  }

  /** Pin an active account token and model metadata for one request. */
  async prepareCall(model: string, signal?: AbortSignal): Promise<ChatGptPreparedCall> {
    signal?.throwIfAborted()
    const account = await this.activeAccount()
    const accountSignal = this.accountSignal(account.accountId)
    const requestSignal = signal === undefined ? accountSignal : AbortSignal.any([signal, accountSignal])
    requestSignal.throwIfAborted()
    const resolved = await this.resolveModelForAccount(account, model, requestSignal)
    const latest = await this.accessGrant(account.accountId, requestSignal)
    requestSignal.throwIfAborted()
    const current = await this.readAccount(accountIdOf(account.accountId))
    if (current?.status !== 'connected' || current.grantGeneration !== account.grantGeneration) {
      throw new LlmError('The ChatGPT account grant changed while preparing the request', 'CHATGPT_ACCOUNT_CHANGED')
    }
    requestSignal.throwIfAborted()
    return {
      accountId: accountIdOf(account.accountId),
      accessToken: connectedGrant(latest).accessToken,
      accountSignal,
      model: resolved,
      requestTimeoutMs: this.config.requestTimeoutMs.get(),
    }
  }

  /** Read an attachment only when an image reaches the API request. */
  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    signal?.throwIfAborted()
    const attachments = this.ctx.get('attachments', false)
    if (attachments === undefined) throw new LlmError('ChatGPT image input requires the attachment service', 'UNSUPPORTED_CONTENT')
    return await attachments.readImage(ref, signal)
  }

  /** Abort callbacks and every pinned account request before Host teardown completes. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const pending = [...this.attempts.values()].filter(attempt => !isTerminal(attempt.phase))
    for (const attempt of pending) {
      await this.stopAttempt(attempt, 'cancelled', 'ChatGPT sign-in stopped because the Host is shutting down.')
    }
    for (const controller of this.accountControllers.values()) controller.abort(new Error('ChatGPT Host is stopping'))
    this.accountControllers.clear()
    await Promise.all(pending.map(async attempt => {
      await attempt.completion
      await attempt.authorizationRun
    }))
  }

  private async handleCallback(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
    attempt: LoginAttempt | undefined,
  ): Promise<void> {
    if (attempt === undefined || attempt.phase !== 'awaiting-browser') {
      writeCallbackResponse(response, 410, 'This ChatGPT sign-in is no longer active. Return to DeepSeek Harness and start again.')
      return
    }
    if (request.method !== 'GET' || request.url === undefined) {
      writeCallbackResponse(response, 405, 'This ChatGPT callback is not available.')
      return
    }
    const url = new URL(request.url, attempt.redirectUri)
    if (url.pathname !== CALLBACK_PATH) {
      writeCallbackResponse(response, 404, 'This ChatGPT callback is not available.')
      return
    }
    const returnedState = url.searchParams.get('state')
    if (returnedState === null || !sameSecret(returnedState, attempt.state)) {
      writeCallbackResponse(response, 400, 'The ChatGPT sign-in response did not match this request. Return to DeepSeek Harness and try again.')
      return
    }
    const oauthError = url.searchParams.get('error')
    if (oauthError !== null) {
      writeCallbackResponse(response, 400, 'ChatGPT did not approve this sign-in. Return to DeepSeek Harness to try again.')
      await this.finishAttempt(attempt, 'failed', 'ChatGPT did not approve this sign-in.')
      return
    }
    const code = url.searchParams.get('code')
    const callbackClientId = url.searchParams.get('client_id')
    if (code === null || code.length === 0 || (attempt.expectedIdentity === undefined && callbackClientId === null)) {
      writeCallbackResponse(response, 400, 'ChatGPT returned an incomplete sign-in response.')
      await this.finishAttempt(attempt, 'failed', 'ChatGPT returned an incomplete sign-in response.')
      return
    }
    const clientId = attempt.expectedIdentity?.clientId ?? callbackClientId
    if (clientId === null || clientId === undefined || clientId.length === 0) {
      writeCallbackResponse(response, 400, 'ChatGPT returned an incomplete sign-in response.')
      await this.finishAttempt(attempt, 'failed', 'ChatGPT returned an incomplete sign-in response.')
      return
    }
    if (attempt.expectedIdentity !== undefined && callbackClientId !== null && callbackClientId !== clientId) {
      writeCallbackResponse(response, 400, 'The ChatGPT account or workspace did not match this registration.')
      await this.finishAttempt(attempt, 'failed', 'The selected ChatGPT account or workspace did not match this registration.')
      return
    }
    attempt.phase = 'exchanging'
    try {
      const completion = await exchangeAuthorizationCode({
        code,
        clientId,
        verifier: attempt.verifier,
        redirectUri: attempt.redirectUri,
        nonce: attempt.nonce,
        ...(attempt.expectedIdentity === undefined ? {} : { expectedIdentity: attempt.expectedIdentity }),
        requestTimeoutMs: this.config.requestTimeoutMs.get(),
        signal: attempt.controller.signal,
      })
      const accountId = attempt.accountId
      await this.storeGrant(accountId, completion.grant, attempt)
      this.invalidateCatalog(String(accountId))
      attempt.finish('complete')
      writeCallbackResponse(response, 200, 'ChatGPT is connected. Return to DeepSeek Harness.')
      await closeServer(attempt.server)
    } catch (error: unknown) {
      const message = safeLoginError(error)
      attempt.finish('failed', message)
      writeCallbackResponse(response, 400, message)
      await closeServer(attempt.server)
    }
  }

  private attemptForServer(server: ReturnType<typeof createServer>): LoginAttempt | undefined {
    for (const attempt of this.attempts.values()) if (attempt.server === server) return attempt
    return undefined
  }

  private async finishAttempt(attempt: LoginAttempt, phase: ChatGptLoginAttemptView['phase'], message?: string): Promise<void> {
    if (!isTerminal(attempt.phase)) attempt.finish(phase, message)
    await closeServer(attempt.server)
  }

  /** Cancel a flow only before its locked credential commit begins. */
  private async stopAttempt(
    attempt: LoginAttempt,
    phase: 'failed' | 'cancelled',
    message: string,
  ): Promise<void> {
    if (isTerminal(attempt.phase)) return
    if (attempt.committing) {
      await attempt.completion
      return
    }
    attempt.finish(phase, message)
    const reason = new Error(message)
    attempt.controller.abort(reason)
    this.ctx.authorization.cancel(attempt.key)
    await closeServer(attempt.server)
  }

  private async storeGrant(
    accountId: ChatGptAccountId,
    grant: OAuthGrant,
    attempt: LoginAttempt,
  ): Promise<void> {
    const key = attempt.key
    attempt.committing = true
    clearTimeout(attempt.timeout)
    const saved = await this.ctx.credentials.modifyRecord(key, async current => {
      attempt.controller.signal.throwIfAborted()
      attempt.session?.signal.throwIfAborted()
      const expected = attempt.expectedIdentity
      if (expected !== undefined) {
        if (current === undefined) throw new Error(ACCOUNT_REQUEST_ERROR)
        const previous = readAccount(current, String(accountId))
        if (previous.clientId !== expected.clientId || previous.subject !== expected.subject
          || previous.grantGeneration !== attempt.expectedGrantGeneration) {
          throw new Error('The saved ChatGPT registration changed before reauthorization completed.')
        }
      } else if (current !== undefined) {
        throw new Error('The new ChatGPT account id is already in use.')
      }
      const previous = current === undefined ? undefined : readAccount(current, String(accountId))
      return accountRecord({
        ...grant,
        accountId: String(accountId),
        grantGeneration: previous?.grantGeneration ?? 0,
        createdAt: previous?.createdAt ?? Date.now(),
        status: 'connected',
      })
    })
    const controller = this.accountControllers.get(String(accountId))
    if (controller?.signal.aborted) this.accountControllers.set(String(accountId), new AbortController())
    if (saved === undefined) throw new Error('The ChatGPT grant was not saved.')
  }

  private async accountRecords(): Promise<StoredAccount[]> {
    const entries = await this.ctx.credentials.listRecords()
    const accounts = await Promise.all(entries
      .filter(entry => credentialKeyScope(entry.key) === CREDENTIAL_SCOPE && credentialKeyId(entry.key).startsWith(ACCOUNT_ID_PREFIX))
      .map(async entry => {
        const record = await this.ctx.credentials.readRecord(entry.key)
        return record === undefined ? undefined : readAccount(record, credentialKeyId(entry.key))
      }))
    return accounts.filter((account): account is StoredAccount => account !== undefined)
      .sort((left, right) => left.createdAt - right.createdAt || left.accountId.localeCompare(right.accountId))
  }

  private async readAccount(accountId: ChatGptAccountId): Promise<StoredAccount | undefined> {
    const key = accountKey(accountId)
    const record = await this.ctx.credentials.readRecord(key)
    return record === undefined ? undefined : readAccount(record, String(accountId))
  }

  private async activeAccount(): Promise<StoredAccount> {
    const accounts = await this.accountRecords()
    const connected = accounts.filter(account => account.status === 'connected')
    const selected = this.selectActive(connected)
    if (selected === undefined) throw new LlmError('Connect a ChatGPT account before using the ChatGPT model provider', 'CHATGPT_SIGN_IN_REQUIRED')
    return selected
  }

  private selectActive(accounts: readonly StoredAccount[]): StoredAccount | undefined {
    const configured = this.config.activeAccountId.get()
    if (configured !== undefined) {
      return accounts.find(account => account.accountId === configured)
    }
    if (this.activeInMemoryAccountId !== undefined) {
      return accounts.find(account => account.accountId === String(this.activeInMemoryAccountId))
    }
    return accounts.length === 1 ? accounts[0] : undefined
  }

  private async accessGrant(accountId: string, signal?: AbortSignal): Promise<StoredAccount> {
    signal?.throwIfAborted()
    let refreshFailure: OAuthError | undefined
    const key = accountKey(accountIdOf(accountId))
    const record = await this.ctx.credentials.modifyRecord(key, async current => {
      if (current === undefined) throw new LlmError('The ChatGPT account registration is missing', 'CHATGPT_ACCOUNT_MISSING')
      const account = readAccount(current, accountId)
      if (account.status !== 'connected') throw new LlmError('Sign in to the ChatGPT account again before making a request', 'CHATGPT_SIGN_IN_REQUIRED')
      if ((account.expiresAt ?? 0) > Date.now() + 30_000) return current
      try {
        const grant = await refreshGrant({
          previous: connectedGrant(account),
          requestTimeoutMs: this.config.requestTimeoutMs.get(),
          ...(signal === undefined ? {} : { signal }),
        })
        return accountRecord({
          ...grant,
          accountId,
          grantGeneration: account.grantGeneration,
          createdAt: account.createdAt,
          status: 'connected',
        })
      } catch (error: unknown) {
        if (error instanceof OAuthError && error.code === 'invalid_grant') {
          refreshFailure = error
          return accountRecord({
            version: 1,
            accountId,
            clientId: account.clientId,
            subject: account.subject,
            grantGeneration: account.grantGeneration,
            ...(account.email === undefined ? {} : { email: account.email }),
            createdAt: account.createdAt,
            status: 'needs-sign-in',
          })
        }
        throw error
      }
    })
    signal?.throwIfAborted()
    if (refreshFailure !== undefined) throw new LlmError('Sign in to the ChatGPT account again before making a request', 'CHATGPT_SIGN_IN_REQUIRED', { cause: refreshFailure })
    if (record === undefined) throw new LlmError('The ChatGPT account registration is missing', 'CHATGPT_ACCOUNT_MISSING')
    const account = readAccount(record, accountId)
    if (account.status !== 'connected' || account.accessToken === undefined) {
      throw new LlmError('Sign in to the ChatGPT account again before making a request', 'CHATGPT_SIGN_IN_REQUIRED')
    }
    return account
  }

  private async loadCatalog(account: StoredAccount, signal?: AbortSignal): Promise<readonly CatalogModel[]> {
    const accountId = account.accountId
    signal?.throwIfAborted()
    const accountSignal = this.accountSignal(accountId)
    accountSignal.throwIfAborted()
    const operationSignal = signal === undefined ? accountSignal : AbortSignal.any([signal, accountSignal])
    const cached = this.catalogs.get(accountId)
    if (cached !== undefined) return cached
    const pending = this.catalogLoads.get(accountId)
    if (pending !== undefined) return await pending
    const epoch = this.catalogEpochs.get(accountId) ?? 0
    const load = (async (): Promise<readonly CatalogModel[]> => {
      const activeGrant = await this.accessGrant(accountId, operationSignal)
      operationSignal.throwIfAborted()
      const timeout = AbortSignal.timeout(this.config.requestTimeoutMs.get())
      const requestSignal = AbortSignal.any([operationSignal, timeout])
      const response = await fetch(CATALOG_URL, {
        headers: { authorization: `Bearer ${activeGrant.accessToken}` },
        signal: requestSignal,
      })
      let body: unknown
      try { body = await response.json() }
      catch { throw new Error('ChatGPT returned an unreadable model catalog.') }
      if (!response.ok) throw new Error(`ChatGPT model catalog request failed with HTTP ${String(response.status)}.`)
      const models = readCatalog(body)
      if (epoch === (this.catalogEpochs.get(accountId) ?? 0) && !accountSignal.aborted) {
        this.catalogs.set(accountId, models)
      }
      return models
    })()
    this.catalogLoads.set(accountId, load)
    try { return await load }
    finally {
      if (this.catalogLoads.get(accountId) === load) this.catalogLoads.delete(accountId)
    }
  }

  private invalidateCatalog(accountId: string): void {
    this.catalogEpochs.set(accountId, (this.catalogEpochs.get(accountId) ?? 0) + 1)
    this.catalogs.delete(accountId)
    this.catalogLoads.delete(accountId)
  }

  private resolveMetadata(row: CatalogModel): import('./models.js').OfficialOpenAiModel | undefined {
    const official = officialOpenAiModel(row.id)
    const override = this.config.modelOverrides.get().find(candidate => candidate.model === row.id)
    const contextWindow = override?.contextWindow ?? official?.contextWindow
    if (contextWindow === undefined) return undefined
    const reasoningEfforts = override?.reasoningEfforts?.map(value => ReasoningEffortId(value)) ?? official?.reasoningEfforts ?? []
    return {
      id: row.id,
      name: row.displayName || official?.name || row.id,
      description: official?.description ?? 'Model available through this ChatGPT account.',
      contextWindow,
      inputModalities: override?.inputModalities ?? official?.inputModalities ?? [],
      reasoningEfforts,
      ...(override?.defaultReasoningEffort === undefined
        ? official?.defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort: official.defaultReasoningEffort }
        : { defaultReasoningEffort: ReasoningEffortId(override.defaultReasoningEffort) }),
    }
  }

  private async accountView(account: StoredAccount, activeId: string | undefined): Promise<ChatGptAccountView> {
    let catalog: readonly CatalogModel[] = []
    if (account.status === 'connected') {
      try { catalog = await this.loadCatalog(account) }
      catch (error: unknown) { this.ctx.logger.warn(`ChatGPT model catalog is unavailable: ${safeLoginError(error)}`) }
    }
    const overrides = new Map(this.config.modelOverrides.get().map(override => [override.model, override]))
    const models: ChatGptModelView[] = catalog.map(row => {
      const official = officialOpenAiModel(row.id)
      const override = overrides.get(row.id)
      return {
        slug: row.id,
        displayName: row.displayName || official?.name || row.id,
        ...(override?.contextWindow === undefined ? official?.contextWindow === undefined ? {} : { contextWindow: official.contextWindow } : { contextWindow: override.contextWindow }),
        ...(override?.inputModalities === undefined ? official?.inputModalities === undefined ? {} : { inputModalities: official.inputModalities } : { inputModalities: override.inputModalities }),
        ...(override?.reasoningEfforts === undefined ? official === undefined ? {} : { reasoningEfforts: official.reasoningEfforts.map(String) } : { reasoningEfforts: override.reasoningEfforts }),
        ...(override?.defaultReasoningEffort !== undefined
          ? { defaultReasoningEffort: override.defaultReasoningEffort }
          : official?.defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort: String(official.defaultReasoningEffort) }),
        usable: override?.contextWindow !== undefined || official !== undefined,
        overridden: override !== undefined,
      }
    })
    return {
      id: accountIdOf(account.accountId),
      label: `ChatGPT account ${account.accountId.slice(-6)}`,
      ...(account.email === undefined ? {} : { email: account.email }),
      active: activeId === account.accountId,
      status: account.status,
      models,
    }
  }

  private accountSignal(accountId: string): AbortSignal {
    let controller = this.accountControllers.get(accountId)
    if (controller === undefined) {
      controller = new AbortController()
      this.accountControllers.set(accountId, controller)
    }
    return controller.signal
  }

  private async persistConfig(change: Record<string, unknown>): Promise<void> {
    const editor = this.ctx.get('configEditor', false)
    if (editor === undefined) throw new Error('The active profile does not expose saved configuration editing.')
    const entry = editor.entries().find(candidate => candidate.fiber?.uid === this.ctx.fiber.uid)
    if (entry === undefined) throw new Error('The ChatGPT plugin profile entry cannot be edited.')
    await editor.edit(entry, current => ({ ...current, ...change }))
  }

  private pruneAttempts(): void {
    const cutoff = Date.now() - 10 * 60_000
    for (const [id, attempt] of this.attempts) {
      if (isTerminal(attempt.phase) && (attempt.finishedAt ?? 0) < cutoff) this.attempts.delete(id)
    }
  }

  private assertRunning(): void {
    if (this.disposed) throw new Error('The ChatGPT Host is stopping.')
  }
}

function accountRecord(account: Omit<StoredAccount, 'version'> | StoredAccount): CredentialRecord {
  return { kind: 'grant', payload: { version: 1, ...account } }
}

function readHost(record: CredentialRecord | undefined): StoredHost {
  const payload = grantPayload(record, 'ChatGPT host identity')
  if (payload.version !== 1 || typeof payload.hostId !== 'string' || payload.hostId.length === 0) {
    throw new Error('The saved ChatGPT host identity is invalid.')
  }
  return { version: 1, hostId: payload.hostId }
}

function readAccount(record: CredentialRecord, accountId: string): StoredAccount {
  const payload = grantPayload(record, 'ChatGPT account')
  if (payload.version !== 1 || payload.accountId !== accountId || typeof payload.clientId !== 'string'
    || typeof payload.subject !== 'string' || typeof payload.createdAt !== 'number'
    || (payload.status !== 'connected' && payload.status !== 'needs-sign-in')) {
    throw new Error('The saved ChatGPT account record is invalid.')
  }
  if (payload.grantGeneration !== undefined
    && (typeof payload.grantGeneration !== 'number' || !Number.isSafeInteger(payload.grantGeneration) || payload.grantGeneration < 0)) {
    throw new Error('The saved ChatGPT account record has an invalid grant generation.')
  }
  if (payload.status === 'connected' && (typeof payload.accessToken !== 'string'
    || typeof payload.refreshToken !== 'string' || typeof payload.idToken !== 'string'
    || typeof payload.expiresAt !== 'number' || !Array.isArray(payload.scopes)
    || !payload.scopes.every(scope => typeof scope === 'string'))) {
    throw new Error('The saved ChatGPT grant is incomplete.')
  }
  return {
    version: 1,
    accountId,
    clientId: payload.clientId,
    subject: payload.subject,
    grantGeneration: payload.grantGeneration === undefined ? 0 : payload.grantGeneration,
    ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
    ...(typeof payload.accessToken === 'string' ? { accessToken: payload.accessToken } : {}),
    ...(typeof payload.refreshToken === 'string' ? { refreshToken: payload.refreshToken } : {}),
    ...(typeof payload.idToken === 'string' ? { idToken: payload.idToken } : {}),
    ...(typeof payload.expiresAt === 'number' ? { expiresAt: payload.expiresAt } : {}),
    ...(Array.isArray(payload.scopes) && payload.scopes.every(scope => typeof scope === 'string')
      ? { scopes: payload.scopes }
      : {}),
    createdAt: payload.createdAt,
    status: payload.status,
  }
}

function grantPayload(record: CredentialRecord | undefined, label: string): Record<string, unknown> {
  if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null || Array.isArray(record.payload)) {
    throw new Error(`The saved ${label} record is invalid.`)
  }
  return record.payload as Record<string, unknown>
}

function accountKey(accountId: ChatGptAccountId): CredentialKey {
  if (!/^account-[0-9a-f-]{36}$/u.test(String(accountId))) throw new Error(ACCOUNT_REQUEST_ERROR)
  return credentialKey(CREDENTIAL_SCOPE, String(accountId))
}

function newAccountId(): ChatGptAccountId {
  return accountIdOf(`${ACCOUNT_ID_PREFIX}${randomUUID()}`)
}

function accountIdOf(value: string): ChatGptAccountId {
  return brandString<ChatGptAccountId>(value)
}

function attemptView(attempt: LoginAttempt): ChatGptLoginAttemptView {
  return {
    id: attempt.id,
    phase: attempt.phase,
    ...(attempt.message === undefined ? {} : { message: attempt.message }),
  }
}

function isTerminal(phase: ChatGptLoginAttemptView['phase']): boolean {
  return phase === 'complete' || phase === 'failed' || phase === 'cancelled'
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function listenLoopback(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
  })
}

function writeCallbackResponse(response: import('node:http').ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  response.end(message)
}

function readCatalog(value: unknown): readonly CatalogModel[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('ChatGPT returned an invalid model catalog.')
  const models = (value as { models?: unknown }).models
  if (!Array.isArray(models)) throw new Error('ChatGPT returned an invalid model catalog.')
  return models.flatMap((candidate): CatalogModel[] => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return []
    const row = candidate as { id?: unknown; display_name?: unknown; visibility?: unknown }
    if (row.visibility !== 'list' || typeof row.id !== 'string' || row.id.length === 0) return []
    return [{ id: row.id, displayName: typeof row.display_name === 'string' ? row.display_name : row.id }]
  })
}

function connectedGrant(account: StoredAccount): OAuthGrant {
  if (account.status !== 'connected' || account.accessToken === undefined || account.refreshToken === undefined
    || account.idToken === undefined || account.expiresAt === undefined || account.scopes === undefined) {
    throw new LlmError('Sign in to the ChatGPT account again before making a request', 'CHATGPT_SIGN_IN_REQUIRED')
  }
  return {
    clientId: account.clientId,
    subject: account.subject,
    ...(account.email === undefined ? {} : { email: account.email }),
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    idToken: account.idToken,
    expiresAt: account.expiresAt,
    scopes: account.scopes,
  }
}

function safeLoginError(error: unknown): string {
  if (error instanceof OAuthError) return error.message
  if (error instanceof Error && error.name === 'AbortError') return 'ChatGPT sign-in was interrupted.'
  return 'ChatGPT sign-in could not be completed. Return to DeepSeek Harness and try again.'
}

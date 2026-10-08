import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { credentialKey, credentialKeyId } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatGptHost } from '../src/host.js'
import type { Config } from '../src/config.js'
import type { ChatGptAccountId, ChatGptModelOverride } from '../src/types.js'

const scopes = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct']
const homes: string[] = []
const contexts: Context[] = []

function mutable<T>(initial: T): { get(): T; set(value: T): void } {
  let value = initial
  return { get: () => value, set: next => { value = next } }
}

function config(activeAccountId: string | undefined): {
  readonly config: Config
  readonly active: ReturnType<typeof mutable<string | undefined>>
  readonly overrides: ReturnType<typeof mutable<ChatGptModelOverride[]>>
  readonly timeouts: ReturnType<typeof mutable<number>>
} {
  const active = mutable(activeAccountId)
  const overrides = mutable<ChatGptModelOverride[]>([])
  const timeouts = mutable(10_000)
  return {
    active,
    overrides,
    timeouts,
    config: {
      activeAccountId: active,
      welcomeAcknowledged: mutable(false),
      authorizeOnStart: mutable(false),
      modelOverrides: overrides,
      requestTimeoutMs: timeouts,
      loginPollIntervalMs: mutable(1_000),
      loginTimeoutMs: mutable(30_000),
    },
  }
}

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-host-'))
  homes.push(path)
  return path
}

async function boot(path: string, selected: string | undefined, savedHostId?: string): Promise<{
  readonly ctx: Context
  readonly host: ChatGptHost
  readonly active: ReturnType<typeof mutable<string | undefined>>
  readonly overrides: ReturnType<typeof mutable<ChatGptModelOverride[]>>
  readonly timeouts: ReturnType<typeof mutable<number>>
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalCredentialProvider, { path: join(path, '.credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  if (savedHostId !== undefined) {
    await ctx.credentials.modifyRecord(credentialKey('dsh-chatgpt', 'host'), async () => ({
      kind: 'grant',
      payload: { version: 1, hostId: savedHostId },
    }))
  }
  const refs = config(selected)
  const host = new ChatGptHost(ctx, refs.config)
  await host.initialize()
  return { ctx, host, active: refs.active, overrides: refs.overrides, timeouts: refs.timeouts }
}

function newAccountId(): ChatGptAccountId {
  return `account-${crypto.randomUUID()}` as ChatGptAccountId
}

async function seedAccount(
  ctx: Context,
  accountId: ChatGptAccountId,
  options: { readonly token: string; readonly expiresAt?: number; readonly createdAt?: number },
): Promise<void> {
  await ctx.credentials.modifyRecord(credentialKey('dsh-chatgpt', accountId), async () => ({
    kind: 'grant',
    payload: {
      version: 1,
      accountId,
      clientId: `client-${accountId}`,
      subject: `subject-${accountId}`,
      grantGeneration: 0,
      accessToken: options.token,
      refreshToken: `refresh-${options.token}`,
      idToken: `id-${options.token}`,
      expiresAt: options.expiresAt ?? Date.now() + 3_600_000,
      scopes,
      createdAt: options.createdAt ?? Date.now(),
      status: 'connected',
    },
  }))
}

function catalogResponse(displayName: string): Response {
  return new Response(JSON.stringify({
    models: [{ slug: 'gpt-6-astra', display_name: displayName, visibility: 'list' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('ChatGPT Host account selection and request pinning', () => {
  it('runs and commits a new registration through the public Authorization flow', async () => {
    const path = await home()
    const { ctx, host } = await boot(path, undefined)
    const ticket = await host.beginLogin()
    const authorize = new URL(ticket.authorizationUrl)
    const hostRecord = await ctx.credentials.readRecord(credentialKey('dsh-chatgpt', 'host'))
    if (hostRecord?.kind !== 'grant') throw new Error('ChatGPT Host did not persist its host identity.')
    const hostId = hostRecord.payload.hostId
    expect(hostId).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu)
    expect(authorize.searchParams.get('ext_agent_host_id')).toBe(hostId)
    const redirectUri = authorize.searchParams.get('redirect_uri')
    const state = authorize.searchParams.get('state')
    const nonce = authorize.searchParams.get('nonce')
    if (redirectUri === null || state === null || nonce === null) {
      throw new Error('ChatGPT authorize request omitted a required callback value')
    }
    const entry = ctx.authorization.list()[0]
    if (entry === undefined) throw new Error('ChatGPT Host did not register its authorization flow.')
    const accountId = credentialKeyId(entry.key)
    expect(accountId).toMatch(/^account-/)
    await expect(ctx.credentials.readRecord(entry.key)).resolves.toBeUndefined()

    const { privateKey, publicKey } = await generateKeyPair('ES256')
    const publicJwk = await exportJWK(publicKey)
    const issuedClientId = 'issued-client-for-new-registration'
    const idToken = await new SignJWT({ nonce, email: 'hiro@example.test' })
      .setProtectedHeader({ alg: 'ES256', kid: 'new-account-key' })
      .setIssuer('https://auth.openai.com')
      .setAudience(issuedClientId)
      .setSubject('subject-new-registration')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const nativeFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://auth.openai.com/.well-known/openid-configuration') {
        return new Response(JSON.stringify({
          issuer: 'https://auth.openai.com',
          jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
          revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
        return new Response(JSON.stringify({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: 3_600,
          scope: scopes.join(' '),
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url === 'https://auth.openai.com/.well-known/jwks.json') {
        return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'new-account-key', alg: 'ES256', use: 'sig' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected OAuth URL: ${url}`)
    })

    const callback = new URL(redirectUri)
    callback.searchParams.set('state', state)
    callback.searchParams.set('code', 'new-registration-code')
    callback.searchParams.set('client_id', issuedClientId)
    const callbackResponse = await nativeFetch(callback)
    expect(callbackResponse.status).toBe(200)
    await host.waitForLogin(ticket.attemptId)

    const saved = await ctx.credentials.readRecord(entry.key)
    expect(saved).toMatchObject({ payload: {
      accountId,
      clientId: issuedClientId,
      subject: 'subject-new-registration',
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      status: 'connected',
    } })
    expect(ctx.authorization.list()).toHaveLength(1)
    const safeState = await host.getState()
    expect(JSON.stringify(safeState)).not.toContain('new-access-token')
    expect(JSON.stringify(safeState)).not.toContain('new-refresh-token')
  })

  it('migrates an existing bare UUID host ID to the SIWC URN without changing its UUID', async () => {
    const path = await home()
    const legacyId = crypto.randomUUID()
    const { ctx, host } = await boot(path, undefined, legacyId)
    const record = await ctx.credentials.readRecord(credentialKey('dsh-chatgpt', 'host'))
    expect(record).toMatchObject({ payload: { version: 1, hostId: `urn:uuid:${legacyId}` } })

    const ticket = await host.beginLogin()
    expect(new URL(ticket.authorizationUrl).searchParams.get('ext_agent_host_id')).toBe(`urn:uuid:${legacyId}`)
    await host.cancelLogin(ticket.attemptId)
  })

  it('returns the new login attempt when separate attempts share a millisecond timestamp', async () => {
    const path = await home()
    const accountId = newAccountId()
    const { ctx, host } = await boot(path, undefined)
    await seedAccount(ctx, accountId, { token: 'timestamp-token' })
    const frozen = vi.spyOn(Date, 'now').mockReturnValue(1234)
    try {
      const first = await host.beginLogin(accountId)
      await host.cancelLogin(first.attemptId)
      const second = await host.beginLogin(accountId)
      expect(second.attemptId).not.toBe(first.attemptId)
      await host.cancelLogin(second.attemptId)
    } finally {
      frozen.mockRestore()
      await host.dispose()
    }
  })

  it('rejects beginLogin when Host disposal cancels a flow before it creates an attempt', async () => {
    const path = await home()
    const { ctx, host } = await boot(path, undefined)
    const originalRead = ctx.credentials.readRecord.bind(ctx.credentials)
    let readStarted!: () => void
    const started = new Promise<void>(resolve => { readStarted = resolve })
    let releaseRead!: () => void
    const release = new Promise<void>(resolve => { releaseRead = resolve })
    const spy = vi.spyOn(ctx.credentials, 'readRecord').mockImplementation(async key => {
      if (credentialKeyId(key).startsWith('account-')) {
        readStarted()
        await release
      }
      return await originalRead(key)
    })
    try {
      const pending = host.beginLogin()
      await started
      await host.dispose()
      releaseRead()
      await expect(pending).rejects.toThrow()
      expect(ctx.authorization.list()).toEqual([])
    } finally {
      releaseRead()
      spy.mockRestore()
    }
  })

  it('does not start a late reauthorization when sign-out races the account lookup', async () => {
    const path = await home()
    const accountId = newAccountId()
    const { ctx, host } = await boot(path, undefined)
    await seedAccount(ctx, accountId, { token: 'signout-race-token' })
    const originalRead = ctx.credentials.readRecord.bind(ctx.credentials)
    let readStarted!: () => void
    const started = new Promise<void>(resolve => { readStarted = resolve })
    let releaseRead!: () => void
    const release = new Promise<void>(resolve => { releaseRead = resolve })
    const spy = vi.spyOn(ctx.credentials, 'readRecord').mockImplementation(async key => {
      if (credentialKeyId(key) === String(accountId)) {
        readStarted()
        await release
      }
      return await originalRead(key)
    })
    vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }))
    try {
      const pending = host.beginLogin(accountId)
      const pendingRejection = expect(pending).rejects.toThrow(/cancelled/u)
      await started
      await host.signOut(accountId)
      releaseRead()
      await pendingRejection
      expect((await host.getState()).loginAttempts).toEqual([])
      const saved = await ctx.credentials.readRecord(credentialKey('dsh-chatgpt', accountId))
      expect(saved).toMatchObject({ payload: { status: 'needs-sign-in', grantGeneration: 1 } })
    } finally {
      releaseRead()
      spy.mockRestore()
      await host.dispose()
    }
  })

  it('retains verified client registration without persisting tokens when plan permission is missing', async () => {
    const path = await home()
    const { ctx, host } = await boot(path, undefined)
    const ticket = await host.beginLogin()
    const authorize = new URL(ticket.authorizationUrl)
    const redirect = authorize.searchParams.get('redirect_uri')
    const state = authorize.searchParams.get('state')
    const nonce = authorize.searchParams.get('nonce')
    if (redirect === null || state === null || nonce === null) throw new Error('ChatGPT authorize request omitted a callback value')
    const entry = ctx.authorization.list()[0]
    if (entry === undefined) throw new Error('ChatGPT Host did not register its authorization flow.')
    const accountId = credentialKeyId(entry.key)
    const issuedClientId = 'issued-client-without-plan-scope'
    const { privateKey, publicKey } = await generateKeyPair('ES256')
    const publicJwk = await exportJWK(publicKey)
    const idToken = await new SignJWT({ nonce, email: 'hiro@example.test', email_verified: true })
      .setProtectedHeader({ alg: 'ES256', kid: 'limited-account-key' })
      .setIssuer('https://auth.openai.com')
      .setAudience(issuedClientId)
      .setSubject('verified-limited-subject')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const nativeFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://auth.openai.com/.well-known/openid-configuration') {
        return new Response(JSON.stringify({
          issuer: 'https://auth.openai.com',
          jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
          revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
        return new Response(JSON.stringify({
          access_token: 'limited-access-token',
          refresh_token: 'limited-refresh-token',
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: 3_600,
          scope: 'openid profile email offline_access resource.invoke',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url === 'https://auth.openai.com/.well-known/jwks.json') {
        return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'limited-account-key', alg: 'ES256', use: 'sig' }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected OAuth URL: ${url}`)
    })

    const callback = new URL(redirect)
    callback.searchParams.set('state', state)
    callback.searchParams.set('code', 'limited-permission-code')
    callback.searchParams.set('client_id', issuedClientId)
    await expect(nativeFetch(callback)).resolves.toMatchObject({ status: 400 })
    await expect(host.waitForLogin(ticket.attemptId)).rejects.toThrow(/permissions needed/u)

    const saved = await ctx.credentials.readRecord(entry.key)
    expect(saved).toMatchObject({ payload: {
      accountId,
      clientId: issuedClientId,
      subject: 'verified-limited-subject',
      email: 'hiro@example.test',
      status: 'needs-sign-in',
    } })
    if (saved?.kind !== 'grant') throw new Error('The incomplete ChatGPT registration was not saved.')
    expect(saved.payload).not.toHaveProperty('accessToken')
    expect(saved.payload).not.toHaveProperty('refreshToken')
    expect(saved.payload).not.toHaveProperty('idToken')
    await expect(host.listModels()).rejects.toMatchObject({ code: 'CHATGPT_SIGN_IN_REQUIRED' })
  })

  it('preserves the previous connected grant when reauthorization omits plan permission', async () => {
    const path = await home()
    const accountId = newAccountId()
    const { ctx, host } = await boot(path, undefined)
    await seedAccount(ctx, accountId, { token: 'original-access-token' })
    const ticket = await host.beginLogin(accountId)
    const authorize = new URL(ticket.authorizationUrl)
    const redirect = authorize.searchParams.get('redirect_uri')
    const state = authorize.searchParams.get('state')
    const nonce = authorize.searchParams.get('nonce')
    const clientId = authorize.searchParams.get('client_id')
    if (redirect === null || state === null || nonce === null || clientId === null) {
      throw new Error('ChatGPT reauthorization URL omitted a required callback value')
    }
    const { privateKey, publicKey } = await generateKeyPair('ES256')
    const publicJwk = await exportJWK(publicKey)
    const idToken = await new SignJWT({ nonce, email: 'hiro@example.test', email_verified: true })
      .setProtectedHeader({ alg: 'ES256', kid: 'reauth-limited-key' })
      .setIssuer('https://auth.openai.com')
      .setAudience(clientId)
      .setSubject(`subject-${accountId}`)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const nativeFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://auth.openai.com/.well-known/openid-configuration') {
        return new Response(JSON.stringify({
          issuer: 'https://auth.openai.com',
          jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
          revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
        return new Response(JSON.stringify({
          access_token: 'limited-reauthorization-access-token',
          refresh_token: 'limited-reauthorization-refresh-token',
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: 3_600,
          scope: 'openid profile email offline_access resource.invoke',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url === 'https://auth.openai.com/.well-known/jwks.json') {
        return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'reauth-limited-key', alg: 'ES256', use: 'sig' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected OAuth URL: ${url}`)
    })

    const callback = new URL(redirect)
    callback.searchParams.set('state', state)
    callback.searchParams.set('code', 'limited-reauthorization-code')
    callback.searchParams.set('client_id', clientId)
    await expect(nativeFetch(callback)).resolves.toMatchObject({ status: 400 })
    await expect(host.waitForLogin(ticket.attemptId)).rejects.toThrow(/permissions needed/u)
    await expect(ctx.credentials.readRecord(credentialKey('dsh-chatgpt', accountId))).resolves.toMatchObject({ payload: {
      status: 'connected',
      accessToken: 'original-access-token',
      refreshToken: 'refresh-original-access-token',
    } })
    const stateView = await host.getState()
    expect(JSON.stringify(stateView)).not.toContain('limited-reauthorization-access-token')
    expect(JSON.stringify(stateView)).not.toContain('limited-reauthorization-refresh-token')
  })

  it('rejects the dynamic-client placeholder instead of saving it as an issued registration', async () => {
    const path = await home()
    const { ctx, host } = await boot(path, undefined)
    const ticket = await host.beginLogin()
    const authorize = new URL(ticket.authorizationUrl)
    const redirect = authorize.searchParams.get('redirect_uri')
    const state = authorize.searchParams.get('state')
    if (redirect === null || state === null) throw new Error('ChatGPT authorize request omitted a callback value')
    const entry = ctx.authorization.list()[0]
    if (entry === undefined) throw new Error('ChatGPT Host did not register its authorization flow.')
    const callback = new URL(redirect)
    callback.searchParams.set('state', state)
    callback.searchParams.set('code', 'unissued-dynamic-client-code')
    callback.searchParams.set('client_id', 'dynamic_agent_client')
    const response = await globalThis.fetch(callback)
    expect(response.status).toBe(400)
    await expect(response.text()).resolves.toMatch(/did not issue a client registration/u)
    await expect(host.waitForLogin(ticket.attemptId)).rejects.toThrow(/did not issue/u)
    await expect(ctx.credentials.readRecord(entry.key)).resolves.toBeUndefined()
  })

  it('re-registers saved account authorization flows after restart and lets public callers cancel them', async () => {
    const path = await home()
    const accountId = newAccountId()
    const first = await boot(path, undefined)
    await seedAccount(first.ctx, accountId, { token: 'persisted-token' })
    await first.host.dispose()
    await first.ctx.fiber.dispose()

    const { ctx, host } = await boot(path, undefined)
    const key = credentialKey('dsh-chatgpt', accountId)
    expect(ctx.authorization.list()).toContainEqual(expect.objectContaining({ key, label: 'ChatGPT' }))
    let publish!: (url: string) => void
    const authorizeReady = new Promise<string>(resolve => { publish = resolve })
    const controller = new AbortController()
    const running = ctx.authorization.begin({
      key,
      signal: controller.signal,
      interaction: {
        notify: notice => { if (notice.url !== undefined) publish(notice.url) },
        prompt: async () => { throw new Error('ChatGPT does not request a prompt value') },
      },
    })
    const authorize = new URL(await authorizeReady)
    expect(authorize.searchParams.get('client_id')).toBe(`client-${accountId}`)
    expect(authorize.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/u)
    controller.abort()
    await expect(running).resolves.toEqual({ status: 'cancelled' })
    expect(ctx.authorization.list()).toContainEqual(expect.objectContaining({ key, label: 'ChatGPT' }))
    await expect(ctx.credentials.readRecord(key)).resolves.toMatchObject({ payload: { status: 'connected', accessToken: 'persisted-token' } })
    await host.dispose()
  })

  it('uses the sole connected account but requires a choice among multiple accounts or a missing saved selection', async () => {
    const path = await home()
    const firstId = newAccountId()
    const secondId = newAccountId()
    const { ctx, host, active } = await boot(path, undefined)
    await seedAccount(ctx, firstId, { token: 'token-first', createdAt: 1 })
    await seedAccount(ctx, secondId, { token: 'token-second', createdAt: 2 })
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization')
      return catalogResponse(authorization === 'Bearer token-first' ? 'First Astra' : 'Second Astra')
    })

    await expect(host.listModels()).rejects.toMatchObject({ code: 'CHATGPT_SIGN_IN_REQUIRED' })

    active.set(String(firstId))
    await expect(host.listModels()).resolves.toMatchObject([{ id: 'gpt-6-astra', name: 'First Astra' }])

    active.set('account-missing')
    await expect(host.listModels()).rejects.toMatchObject({ code: 'CHATGPT_SIGN_IN_REQUIRED' })
  })

  it('keeps the catalog model and token on the account captured before a profile switch', async () => {
    const path = await home()
    const firstId = newAccountId()
    const secondId = newAccountId()
    const { ctx, host, active, overrides, timeouts } = await boot(path, String(firstId))
    await seedAccount(ctx, firstId, { token: 'token-first', createdAt: 1 })
    await seedAccount(ctx, secondId, { token: 'token-second', createdAt: 2 })
    let started!: () => void
    const firstRequestStarted = new Promise<void>(resolve => { started = resolve })
    let release!: () => void
    const firstCatalogGate = new Promise<void>(resolve => { release = resolve })
    overrides.set([{ model: 'gpt-6-astra', contextWindow: 1111 }])
    timeouts.set(11_000)
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization')
      if (authorization === 'Bearer token-first') {
        started()
        await firstCatalogGate
        return catalogResponse('First Astra')
      }
      return catalogResponse('Second Astra')
    })

    const preparedCall = host.prepareCall('gpt-6-astra')
    await firstRequestStarted
    active.set(String(secondId))
    overrides.set([{ model: 'gpt-6-astra', contextWindow: 2222 }])
    timeouts.set(22_000)
    release()
    const call = await preparedCall

    expect(call.accountId).toBe(firstId)
    expect(call.accessToken).toBe('token-first')
    expect(call.model.name).toBe('First Astra')
    expect(call.model.context?.contextWindow).toBe(1111)
    expect(call.requestTimeoutMs).toBe(11_000)

    const nextCall = await host.prepareCall('gpt-6-astra')
    expect(nextCall.accountId).toBe(secondId)
    expect(nextCall.accessToken).toBe('token-second')
    expect(nextCall.model.context?.contextWindow).toBe(2222)
    expect(nextCall.requestTimeoutMs).toBe(22_000)
  })

  it.each(['add', 'remove'] as const)('uses the captured model metadata when an override is %s during catalog lookup', async change => {
    const path = await home()
    const accountId = newAccountId()
    const { ctx, host, overrides } = await boot(path, String(accountId))
    await seedAccount(ctx, accountId, { token: 'metadata-token' })
    const slug = change === 'add' ? 'gpt-6-astra' : 'unseeded-catalog-model'
    if (change === 'remove') overrides.set([{ model: slug, contextWindow: 1111 }])
    let requestStarted!: () => void
    const started = new Promise<void>(resolve => { requestStarted = resolve })
    let releaseCatalog!: () => void
    const release = new Promise<void>(resolve => { releaseCatalog = resolve })
    vi.stubGlobal('fetch', async () => {
      requestStarted()
      await release
      return new Response(JSON.stringify({
        models: [{ slug, display_name: 'Catalog Model', visibility: 'list' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const pending = host.prepareCall(slug)
    await started
    overrides.set(change === 'add' ? [{ model: slug, contextWindow: 2222, inputModalities: ['text'] }] : [])
    releaseCatalog()
    if (change === 'add') {
      await expect(pending).resolves.toMatchObject({
        model: { context: { contextWindow: 1_050_000 }, inputModalities: ['text', 'image'] },
      })
    } else {
      await expect(pending).resolves.toMatchObject({ model: { context: { contextWindow: 1111 } } })
    }
  })

  it('refreshes the server catalog and prevents an older pending lookup from replacing it', async () => {
    const path = await home()
    const accountId = newAccountId()
    const { ctx, host } = await boot(path, undefined)
    await seedAccount(ctx, accountId, { token: 'token-one' })
    let firstStarted!: () => void
    const firstRequestStarted = new Promise<void>(resolve => { firstStarted = resolve })
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    let catalogRequests = 0
    vi.stubGlobal('fetch', async () => {
      catalogRequests++
      if (catalogRequests === 1) {
        firstStarted()
        await firstGate
        return catalogResponse('Old Astra')
      }
      return catalogResponse('Refreshed Astra')
    })

    const oldLookup = host.listModels()
    await firstRequestStarted
    await host.refreshModels(accountId)
    releaseFirst()
    await oldLookup

    await expect(host.listModels()).resolves.toMatchObject([{ id: 'gpt-6-astra', name: 'Refreshed Astra' }])
    expect(catalogRequests).toBe(2)
  })

  it('aborts catalog work on logout and never returns a prepared token afterward', async () => {
    const path = await home()
    const accountId = newAccountId()
    const { ctx, host } = await boot(path, undefined)
    await seedAccount(ctx, accountId, { token: 'token-one' })
    let firstStarted!: () => void
    const firstRequestStarted = new Promise<void>(resolve => { firstStarted = resolve })
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://api.openai.com/v1/models') {
        requestSignal = init?.signal as AbortSignal
        firstStarted()
        await firstGate
        return catalogResponse('Astra')
      }
      if (String(input) === 'https://auth.openai.com/.well-known/openid-configuration') {
        return new Response(JSON.stringify({
          issuer: 'https://auth.openai.com',
          jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
          revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (String(input) === 'https://auth.openai.com/api/accounts/oauth/revoke') return new Response(null, { status: 200 })
      throw new Error(`unexpected URL: ${String(input)}`)
    })

    const pending = host.prepareCall('gpt-6-astra')
    await firstRequestStarted
    await host.signOut(accountId)
    expect(requestSignal?.aborted).toBe(true)
    releaseFirst()
    await expect(pending).rejects.toThrow('ChatGPT account signed out')
  })

  it('does not restore a saved grant when another Host logs out during reauthorization', async () => {
    const path = await home()
    const accountId = newAccountId()
    const loginHost = await boot(path, undefined)
    await seedAccount(loginHost.ctx, accountId, { token: 'token-one' })
    const logoutHost = await boot(path, undefined)
    const ticket = await loginHost.host.beginLogin(accountId)
    const authorize = new URL(ticket.authorizationUrl)
    const redirect = authorize.searchParams.get('redirect_uri')
    const state = authorize.searchParams.get('state')
    const nonce = authorize.searchParams.get('nonce')
    const clientId = authorize.searchParams.get('client_id')
    if (redirect === null || state === null || nonce === null || clientId === null) {
      throw new Error('ChatGPT authorize request omitted a required callback value')
    }
    const { privateKey, publicKey } = await generateKeyPair('ES256')
    const publicJwk = await exportJWK(publicKey)
    const idToken = await new SignJWT({ nonce })
      .setProtectedHeader({ alg: 'ES256', kid: 'reauth-key' })
      .setIssuer('https://auth.openai.com')
      .setAudience(clientId)
      .setSubject(`subject-${accountId}`)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const nativeFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://auth.openai.com/.well-known/openid-configuration') {
        return new Response(JSON.stringify({
          issuer: 'https://auth.openai.com',
          jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
          revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url === 'https://auth.openai.com/api/accounts/oauth/revoke') return new Response(null, { status: 200 })
      if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
        return new Response(JSON.stringify({
          access_token: 'reauthorized-access-token',
          refresh_token: 'reauthorized-refresh-token',
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: 3_600,
          scope: scopes.join(' '),
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url === 'https://auth.openai.com/.well-known/jwks.json') {
        return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'reauth-key', alg: 'ES256', use: 'sig' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected OAuth URL: ${url}`)
    })

    await logoutHost.host.signOut(accountId)
    const callback = new URL(redirect)
    callback.searchParams.set('state', state)
    callback.searchParams.set('code', 'authorization-code')
    callback.searchParams.set('client_id', clientId)
    const callbackResponse = await nativeFetch(callback)
    expect(callbackResponse.status).toBe(400)
    const saved = await logoutHost.ctx.credentials.readRecord(credentialKey('dsh-chatgpt', accountId))
    expect(saved).toMatchObject({ payload: { status: 'needs-sign-in', grantGeneration: 1 } })
    if (saved?.kind !== 'grant') throw new Error('logged-out ChatGPT account record is missing')
    expect(saved.payload).not.toHaveProperty('refreshToken')
  })

  it('keeps cancellation effective while a real Credentials file lock blocks the grant write', async () => {
    const path = await home()
    const accountId = newAccountId()
    const { ctx, host } = await boot(path, String(accountId))
    await seedAccount(ctx, accountId, { token: 'old-access-token' })
    const key = credentialKey('dsh-chatgpt', accountId)
    let releaseLock!: () => void
    let lockEntered!: () => void
    const lockReady = new Promise<void>(resolve => { lockEntered = resolve })
    const lockGate = new Promise<void>(resolve => { releaseLock = resolve })
    const heldWrite = ctx.credentials.modifyRecord(key, async current => {
      lockEntered()
      await lockGate
      return current
    })
    await lockReady

    let queuedWrite!: () => void
    const writeQueued = new Promise<void>(resolve => { queuedWrite = resolve })
    const originalModify = ctx.credentials.modifyRecord.bind(ctx.credentials)
    vi.spyOn(ctx.credentials, 'modifyRecord').mockImplementation(async (recordKey, mutate) => {
      if (recordKey === key) queuedWrite()
      return await originalModify(recordKey, mutate)
    })

    const ticket = await host.beginLogin(accountId)
    const authorize = new URL(ticket.authorizationUrl)
    const redirect = authorize.searchParams.get('redirect_uri')
    const state = authorize.searchParams.get('state')
    const nonce = authorize.searchParams.get('nonce')
    const clientId = authorize.searchParams.get('client_id')
    if (redirect === null || state === null || nonce === null || clientId === null) {
      throw new Error('ChatGPT authorize request omitted a required callback value')
    }
    const { privateKey, publicKey } = await generateKeyPair('ES256')
    const publicJwk = await exportJWK(publicKey)
    const idToken = await new SignJWT({ nonce })
      .setProtectedHeader({ alg: 'ES256', kid: 'queued-write-key' })
      .setIssuer('https://auth.openai.com')
      .setAudience(clientId)
      .setSubject(`subject-${accountId}`)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const nativeFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://auth.openai.com/.well-known/openid-configuration') {
        return new Response(JSON.stringify({
          issuer: 'https://auth.openai.com',
          jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
          revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
        return new Response(JSON.stringify({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: 3_600,
          scope: scopes.join(' '),
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url === 'https://auth.openai.com/.well-known/jwks.json') {
        return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'queued-write-key', alg: 'ES256', use: 'sig' }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected OAuth URL: ${url}`)
    })

    const callback = new URL(redirect)
    callback.searchParams.set('state', state)
    callback.searchParams.set('code', 'authorization-code-waiting-for-lock')
    callback.searchParams.set('client_id', clientId)
    const callbackResponse = nativeFetch(callback)
    await writeQueued

    let cancelSettled!: () => void
    const authorizationSettled = new Promise<void>(resolve => { cancelSettled = resolve })
    const unlisten = ctx.on('authorization/settled', (settledKey, status) => {
      if (settledKey === key && status === 'cancelled') cancelSettled()
    })
    const cancel = host.cancelLogin(ticket.attemptId)
    await authorizationSettled
    releaseLock()
    await heldWrite
    await cancel
    unlisten()
    expect((await callbackResponse).status).toBe(400)
    await expect(ctx.credentials.readRecord(key)).resolves.toMatchObject({ payload: {
      status: 'connected',
      accessToken: 'old-access-token',
      refreshToken: 'refresh-old-access-token',
    } })
  })

  it('serializes concurrent refreshes through the published file-backed Credentials provider', async () => {
    const path = await home()
    const accountId = newAccountId()
    const first = await boot(path, String(accountId))
    await seedAccount(first.ctx, accountId, { token: 'expired-token', expiresAt: 0 })
    const second = await boot(path, String(accountId))
    let refreshCount = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (String(input) === 'https://auth.openai.com/api/accounts/oauth/token') {
        refreshCount++
        await new Promise(resolve => setTimeout(resolve, 40))
        return new Response(JSON.stringify({
          access_token: 'rotated-access-token',
          refresh_token: 'rotated-refresh-token',
          token_type: 'Bearer',
          expires_in: 3_600,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return catalogResponse('Astra')
    })

    const calls = await Promise.all([
      first.host.prepareCall('gpt-6-astra'),
      second.host.prepareCall('gpt-6-astra'),
    ])

    expect(refreshCount).toBe(1)
    expect(calls.map(call => call.accessToken)).toEqual(['rotated-access-token', 'rotated-access-token'])
    await expect(first.ctx.credentials.readRecord(credentialKey('dsh-chatgpt', accountId)))
      .resolves.toMatchObject({ payload: { refreshToken: 'rotated-refresh-token' } })
  })
})

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
import type { ChatGptAccountId } from '../src/types.js'

const scopes = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct']
const homes: string[] = []
const contexts: Context[] = []

function mutable<T>(initial: T): { get(): T; set(value: T): void } {
  let value = initial
  return { get: () => value, set: next => { value = next } }
}

function config(activeAccountId: string | undefined): { readonly config: Config; readonly active: ReturnType<typeof mutable<string | undefined>> } {
  const active = mutable(activeAccountId)
  return {
    active,
    config: {
      activeAccountId: active,
      welcomeAcknowledged: mutable(false),
      authorizeOnStart: mutable(false),
      modelOverrides: mutable([]),
      requestTimeoutMs: mutable(10_000),
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

async function boot(path: string, selected: string | undefined): Promise<{
  readonly ctx: Context
  readonly host: ChatGptHost
  readonly active: ReturnType<typeof mutable<string | undefined>>
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalCredentialProvider, { path: join(path, '.credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  const refs = config(selected)
  const host = new ChatGptHost(ctx, refs.config)
  await host.initialize()
  return { ctx, host, active: refs.active }
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
    models: [{ id: 'gpt-6-astra', display_name: displayName, visibility: 'list' }],
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
    expect(ctx.authorization.list()).toEqual([])
    const safeState = await host.getState()
    expect(JSON.stringify(safeState)).not.toContain('new-access-token')
    expect(JSON.stringify(safeState)).not.toContain('new-refresh-token')
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
    const { ctx, host, active } = await boot(path, String(firstId))
    await seedAccount(ctx, firstId, { token: 'token-first', createdAt: 1 })
    await seedAccount(ctx, secondId, { token: 'token-second', createdAt: 2 })
    let started!: () => void
    const firstRequestStarted = new Promise<void>(resolve => { started = resolve })
    let release!: () => void
    const firstCatalogGate = new Promise<void>(resolve => { release = resolve })
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
    release()
    const call = await preparedCall

    expect(call.accountId).toBe(firstId)
    expect(call.accessToken).toBe('token-first')
    expect(call.model.name).toBe('First Astra')
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

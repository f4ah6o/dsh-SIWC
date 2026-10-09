import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { AppReady } from '@deepseek-ai/dsh-cmdline'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as chatGptPlugin from '../lib/index.js'
import * as chatGptPreflight from '../lib/preflight.js'

const homes: string[] = []
const contexts: Context[] = []

interface TestReadiness extends AppReady {
  /** Commit startup readiness and invoke the current one-shot listeners. */
  commit(): void
}

function createReadiness(): TestReadiness {
  const listeners = new Set<() => void>()
  return {
    onReady(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    commit() {
      const pending = [...listeners]
      for (const listener of pending) {
        listeners.delete(listener)
        listener()
      }
    },
  }
}

async function createPreflightProfile(): Promise<{ ctx: Context; readiness: TestReadiness }> {
  const ctx = new Context()
  contexts.push(ctx)
  const readiness = createReadiness()
  ctx.provide('appReady', readiness)
  await ctx.plugin(Loader)
  ctx.loader.internal = {
    import: async (specifier: string) => {
      if (specifier === '@f12o/dsh-siwc') return chatGptPlugin
      if (specifier === '@f12o/dsh-siwc/preflight') return chatGptPreflight
      throw new Error(`unexpected profile plugin: ${specifier}`)
    },
  } as never
  await ctx.loader.create({ name: '@f12o/dsh-siwc/preflight' })
  await ctx.loader.await()
  return { ctx, readiness }
}

describe('ChatGPT Host Loader integration', () => {
  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('preserves Host metadata through the shipped Loader and owns authorization flow teardown', async () => {
    const bundle = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
    for (const dependency of [
      '@deepseek-ai/dsh-brand',
      '@deepseek-ai/dsh-credentials',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-typert-protocol',
      '@deepseek-ai/schemastery',
    ]) {
      expect(bundle).toContain(`from "${dependency}"`)
    }
    expect(bundle).not.toContain('class TypertRemoteService')
    expect('default' in chatGptPlugin).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(chatGptPlugin) as Record<string, unknown>
    expect(unwrapped).toBe(chatGptPlugin)
    expect(unwrapped.name).toBe('@f12o/dsh-siwc')
    expect(unwrapped.inject).toEqual(['credentials', 'authorization', 'llm'])
    expect(typeof unwrapped.Config).toBe('function')
    expect(typeof unwrapped.apply).toBe('function')

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    ctx.loader.internal = {
      version: 'test',
      import: async (specifier: string) => {
        expect(specifier).toBe('@f12o/dsh-siwc')
        return chatGptPlugin
      },
    } as never
    const entryId = await ctx.loader.create({ name: '@f12o/dsh-siwc' })
    const entry = ctx.loader.resolve(entryId)
    await ctx.loader.await()
    // Cordis publishes FiberState as a const enum, so its runtime package has no enum object.
    expect(entry.fiber?.state).toBe(0)
    expect(ctx.get('chatgptController')).toBeUndefined()

    const home = await mkdtemp(join(tmpdir(), 'dsh-siwc-loader-'))
    homes.push(home)
    await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
    await ctx.plugin(AuthorizationService)
    await ctx.plugin(LlmRuntime)
    await ctx.loader.await()
    const hostFiber = entry.fiber
    if (hostFiber === undefined) throw new Error('The Host plugin entry did not create a Cordis fiber.')
    expect(hostFiber.state).toBe(2)

    const ticket = await ctx.chatgptController.beginLogin({})
    const flow = ctx.authorization.list().find(entry => entry.label === 'ChatGPT')
    expect(flow).toMatchObject({ label: 'ChatGPT', methods: [{ id: 'browser', label: 'Sign in with ChatGPT' }], inFlight: true })
    if (flow === undefined) throw new Error('The ChatGPT Host did not register its authorization flow.')
    expect(await ctx.credentials.readRecord(flow.key)).toBeUndefined()
    await ctx.chatgptController.cancelLogin({ attemptId: ticket.attemptId })
    expect(ctx.authorization.list()).toEqual([])
    await expect(ctx.chatgptController.getState()).resolves.toMatchObject({
      loginAttempts: [{ phase: 'cancelled' }],
    })

    const pending = await ctx.chatgptController.beginLogin({})
    const redirectUri = new URL(pending.authorizationUrl).searchParams.get('redirect_uri')
    if (redirectUri === null) throw new Error('ChatGPT authorization URL omitted its loopback callback.')
    await hostFiber.dispose()
    expect(ctx.authorization.list()).toEqual([])
    await expect(fetch(redirectUri)).rejects.toThrow()
  })

  it('waits for the local browser callback before authorizeOnStart lets profile loading finish', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-siwc-cli-login-'))
    homes.push(home)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
    await ctx.plugin(AuthorizationService)
    await ctx.plugin(LlmRuntime)

    let loggedUrl: string | undefined
    const info = vi.spyOn(ctx.logger, 'info').mockImplementation(message => {
      loggedUrl = String(message).match(/https:\/\/auth\.openai\.com\/api\/accounts\/authorize\?\S+/u)?.[0]
      return ctx.logger
    })
    const apply = chatGptPlugin.apply(ctx, chatGptPlugin.Config({ authorizeOnStart: true }))
    let applySettled = false
    void apply.then(() => { applySettled = true }, () => { applySettled = true })
    await vi.waitFor(() => expect(info).toHaveBeenCalledOnce())
    expect(applySettled).toBe(false)
    if (loggedUrl === undefined) throw new Error('authorizeOnStart did not log its system-browser URL.')

    const authorize = new URL(loggedUrl)
    const redirect = authorize.searchParams.get('redirect_uri')
    const state = authorize.searchParams.get('state')
    const nonce = authorize.searchParams.get('nonce')
    if (redirect === null || state === null || nonce === null) {
      throw new Error('authorizeOnStart omitted required loopback authorization parameters.')
    }
    const { privateKey, publicKey } = await generateKeyPair('ES256')
    const publicJwk = await exportJWK(publicKey)
    const clientId = 'issued-client-for-local-cli'
    const idToken = await new SignJWT({ nonce, email: 'cli-user@example.test', email_verified: true })
      .setProtectedHeader({ alg: 'ES256', kid: 'cli-login-key' })
      .setIssuer('https://auth.openai.com')
      .setAudience(clientId)
      .setSubject('cli-login-subject')
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
          access_token: 'cli-access-token',
          refresh_token: 'cli-refresh-token',
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: 3_600,
          scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url === 'https://auth.openai.com/.well-known/jwks.json') {
        return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'cli-login-key', alg: 'ES256', use: 'sig' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected OAuth URL: ${url}`)
    })

    const callback = new URL(redirect)
    callback.searchParams.set('state', state)
    callback.searchParams.set('code', 'local-cli-authorization-code')
    callback.searchParams.set('client_id', clientId)
    await expect(nativeFetch(callback)).resolves.toMatchObject({ status: 200 })
    await apply
    expect(applySettled).toBe(true)
    await expect(ctx.chatgptController.getState()).resolves.toMatchObject({
      accounts: [{ status: 'connected', email: 'cli-user@example.test' }],
    })
    expect(JSON.stringify(await ctx.chatgptController.getState())).not.toContain('cli-access-token')
  })

  it('fails launcher readiness when an enabled Host entry lacks required services', async () => {
    const { ctx, readiness } = await createPreflightProfile()
    await ctx.loader.create({ name: '@f12o/dsh-siwc' })
    await ctx.loader.await()

    expect(() => readiness.commit()).toThrow('ChatGPT requires services: credentials, authorization, llm')
  })

  it('skips the service check when the Host entry is deleted or disabled', async () => {
    const { ctx, readiness } = await createPreflightProfile()
    const deleted = await ctx.loader.create({ name: '@f12o/dsh-siwc' })
    ctx.loader.remove(deleted)
    await ctx.loader.create({ name: '@f12o/dsh-siwc', disabled: true })
    await ctx.loader.await()

    expect(() => readiness.commit()).not.toThrow()
  })

  it('accepts an enabled Host entry after its real DSH providers activate', async () => {
    const { ctx, readiness } = await createPreflightProfile()
    const entryId = await ctx.loader.create({ name: '@f12o/dsh-siwc' })
    await ctx.loader.await()

    const home = await mkdtemp(join(tmpdir(), 'dsh-siwc-preflight-'))
    homes.push(home)
    await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
    await ctx.plugin(AuthorizationService)
    await ctx.plugin(LlmRuntime)
    await ctx.loader.await()

    const entry = ctx.loader.resolve(entryId)
    expect(entry.fiber?.state).toBe(2)
    expect(() => readiness.commit()).not.toThrow()
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import * as chatGptPlugin from '../lib/index.js'

const homes: string[] = []
const contexts: Context[] = []

describe('ChatGPT Host Loader integration', () => {
  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('preserves Host metadata through the shipped Loader and owns authorization flow teardown', async () => {
    expect('default' in chatGptPlugin).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(chatGptPlugin) as Record<string, unknown>
    expect(unwrapped).toBe(chatGptPlugin)
    expect(unwrapped.name).toBe('@f4ah6o/dsh-chatgpt')
    expect(unwrapped.inject).toEqual(['credentials', 'authorization', 'llm'])
    expect(typeof unwrapped.Config).toBe('function')
    expect(typeof unwrapped.apply).toBe('function')

    const home = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-loader-'))
    homes.push(home)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
    await ctx.plugin(AuthorizationService)
    await ctx.plugin(LlmRuntime)
    const hostFiber = await ctx.plugin(unwrapped as Parameters<Context['plugin']>[0])

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
})

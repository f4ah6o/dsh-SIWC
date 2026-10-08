import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@f4ah6o/dsh-chatgpt/remote', () => ({ TYPERT_REMOTE: {} }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: () => null, Modal: () => null }))

import * as client from '../src/client/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose()
    await ctx.fiber.await()
  }
  vi.restoreAllMocks()
})

describe('ChatGPT Client Loader entry', () => {
  it('keeps namespace dependencies, activates after providers arrive, and disposes registrations', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    ctx.loader.internal = {
      version: 'test',
      import: async (specifier: string) => {
        expect(specifier).toBe('@f4ah6o/dsh-chatgpt')
        return client
      },
    } as never

    const entryId = await ctx.loader.create({ name: '@f4ah6o/dsh-chatgpt' })
    const entry = ctx.loader.resolve(entryId)
    // Cordis publishes FiberState as a const enum, so its runtime package has no enum object.
    expect(entry.fiber?.state).toBe(0)
    expect(Object.keys(entry.fiber?.inject ?? {}).sort()).toEqual(['locale', 'remote', 'sessions', 'slots'])

    let remoteUnmounts = 0
    let localeDisposals = 0
    let slotDisposals = 0
    const remote = {
      $mount: async () => () => { remoteUnmounts++ },
    }
    const locale = {
      register: () => () => { localeDisposals++ },
      bind: () => (key: string) => key,
    }
    const slots = {
      inject: (_name: string, register: () => () => void) => { ctx.effect(() => register()) },
      register: () => () => { slotDisposals++ },
    }
    ctx.provide('remote', remote as never)
    ctx.provide('locale', locale as never)
    ctx.provide('sessions', {} as never)
    ctx.provide('slots', slots as never)

    await ctx.loader.await()
    expect(entry.fiber?.state).toBe(2)
    expect(remoteUnmounts).toBe(0)
    expect(localeDisposals).toBe(0)
    expect(slotDisposals).toBe(0)

    await ctx.fiber.dispose()
    await ctx.fiber.await()
    expect(remoteUnmounts).toBe(1)
    expect(localeDisposals).toBe(3)
    expect(slotDisposals).toBe(2)
  })
})

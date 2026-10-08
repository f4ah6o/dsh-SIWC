// @vitest-environment jsdom

import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement, type ComponentType } from 'react'
import type { ChatGptState } from '../src/types.ts'
import type { ChatGptSettingsInjected, ChatGptKey } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

vi.mock('@f4ah6o/dsh-chatgpt/remote', () => ({ TYPERT_REMOTE: {} }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: () => null, Modal: () => null }))

import * as client from '../src/client/index.ts'

const contexts: Context[] = []

class RemoteRootService extends Service {
  constructor(ctx: Context, private readonly onUnmount: () => void) {
    super(ctx, 'remote')
  }

  async $mount(): Promise<() => void> {
    return this.onUnmount
  }
}

class ChatGptNamespaceService extends Service {
  readonly getState = vi.fn(async () => ({ ok: true as const, value: {
    accounts: [],
    activeAccountId: undefined,
    welcomeAcknowledged: true,
    loginAttempts: [],
    loginPollIntervalMs: 1000,
  } satisfies ChatGptState }))

  constructor(ctx: Context) {
    super(ctx, 'remote.chatgpt')
  }
}

afterEach(async () => {
  cleanup()
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose()
    await ctx.fiber.await()
  }
  vi.restoreAllMocks()
})

describe('ChatGPT Client Loader entry', () => {
  it('waits for the ChatGPT Remote namespace and exposes it to the settings slot', async () => {
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
    expect(Object.keys(entry.fiber?.inject ?? {}).sort()).toEqual(['locale', 'remote', 'remote.chatgpt', 'sessions', 'slots'])

    let remoteUnmounts = 0
    let localeDisposals = 0
    let slotDisposals = 0
    let settingsInject: (() => ChatGptSettingsInjected) | undefined
    let settingsComponent: unknown
    new RemoteRootService(ctx, () => { remoteUnmounts++ })
    const locale = {
      register: () => () => { localeDisposals++ },
      bind: () => (key: string) => key,
    }
    const slots = {
      inject: (_name: string, register: () => () => void) => { ctx.effect(() => register()) },
      register: (options: { readonly id?: string; readonly inject?: () => ChatGptSettingsInjected }, component: unknown) => {
        if (options.id === 'chatgpt') {
          settingsInject = options.inject
          settingsComponent = component
        }
        return () => { slotDisposals++ }
      },
    }
    ctx.provide('locale', locale as never)
    ctx.provide('sessions', {} as never)
    ctx.provide('slots', slots as never)

    await Promise.resolve()
    expect(entry.fiber?.state).toBe(0)
    expect(remoteUnmounts).toBe(0)
    expect(localeDisposals).toBe(0)
    expect(slotDisposals).toBe(0)

    const chatgpt = new ChatGptNamespaceService(ctx)
    await ctx.loader.await()
    expect(entry.fiber?.state).toBe(2)
    expect(remoteUnmounts).toBe(0)
    expect(localeDisposals).toBe(0)
    expect(slotDisposals).toBe(0)

    const injected = settingsInject?.()
    expect(injected).toBeDefined()
    const state = await injected!.remote.getState()
    expect(state).toEqual({ ok: true, value: expect.objectContaining({ accounts: [], welcomeAcknowledged: true }) })
    expect(chatgpt.getState).toHaveBeenCalledOnce()

    const translations: Readonly<Record<string, string>> = en
    render(createElement(settingsComponent as ComponentType<Record<string, unknown>>, {
      ...injected,
      close: () => undefined,
      t: (key: ChatGptKey) => translations[key] ?? key,
    }))
    expect(await screen.findByText(en.noAccounts)).toBeTruthy()

    await ctx.fiber.dispose()
    await ctx.fiber.await()
    expect(remoteUnmounts).toBe(1)
    expect(localeDisposals).toBe(3)
    expect(slotDisposals).toBe(2)
  })
})

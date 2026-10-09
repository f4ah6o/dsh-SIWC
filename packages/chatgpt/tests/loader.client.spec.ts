// @vitest-environment jsdom

import { Context } from '@deepseek-ai/cordis'
import * as Cordis from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement, type ComponentType } from 'react'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type * as GatewayClient from '@deepseek-ai/dsh-api-gateway/client'
import type * as ConnectionClient from '@deepseek-ai/dsh-client-connection/client'
import type * as RegistryClient from '@deepseek-ai/dsh-typert-registry/client'
import type { ChatGptState } from '../src/types.ts'
import type { ChatGptSettingsInjected, ChatGptKey } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: () => null, Modal: () => null }))

import * as client from '../src/client/index.ts'

const contexts: Context[] = []
const nodeRequire = createRequire(import.meta.url)

interface ClientArtifactRegistration {
  id: string
  factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

interface ClientArtifactWindow extends Window {
  __ModuleLoader__?: { load(registration: ClientArtifactRegistration): void }
}

/** Materialize an installed public Client bundle through its documented module-loader handoff. */
function loadClientArtifact(specifier: string): Record<string, unknown> {
  let registration: ClientArtifactRegistration | undefined
  ;(window as ClientArtifactWindow).__ModuleLoader__ = {
    load: (value) => { registration = value },
  }
  const source = readFileSync(nodeRequire.resolve(specifier), 'utf8')
  // This executes the package's generated browser bundle in jsdom, as the shell does when a script registers.
  // oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-call
  new Function(source)()
  if (registration === undefined) throw new Error(`Client bundle did not register: ${specifier}`)
  return registration.factory((name) => {
    if (name === '@deepseek-ai/cordis') return Cordis
    throw new Error(`unexpected Client bundle import: ${name}`)
  })
}

function eventStream(signal: AbortSignal): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'ready', clientId: randomUUID(), host: { home: '/home/test' } }
      await new Promise<void>(resolve => {
        if (signal.aborted) {
          resolve()
          return
        }
        signal.addEventListener('abort', resolve, { once: true })
      })
    },
  }
}

afterEach(async () => {
  cleanup()
  delete (window as ClientArtifactWindow).__ModuleLoader__
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose()
    await ctx.fiber.await()
  }
  vi.restoreAllMocks()
})

describe('ChatGPT Client Loader entry', () => {
  it('mounts its generated Remote before loading the settings consumer', async () => {
    const gateway = loadClientArtifact('@deepseek-ai/dsh-api-gateway/client') as typeof GatewayClient
    const connection = loadClientArtifact('@deepseek-ai/dsh-client-connection/client') as typeof ConnectionClient
    const registry = loadClientArtifact('@deepseek-ai/dsh-typert-registry/client') as typeof RegistryClient
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    ctx.loader.internal = {
      version: 'test',
      import: async (specifier: string) => {
        expect(specifier).toBe('@f12o/dsh-siwc')
        return client
      },
    } as never

    const entryId = await ctx.loader.create({ name: '@f12o/dsh-siwc' })
    const entry = ctx.loader.resolve(entryId)
    // Cordis publishes FiberState as a const enum, so its runtime package has no enum object.
    expect(entry.fiber?.state).toBe(0)
    expect(Object.keys(entry.fiber?.inject ?? {})).toEqual(['remote'])

    const stateSnapshot: ChatGptState = {
      accounts: [],
      activeAccountId: undefined,
      welcomeAcknowledged: true,
      loginAttempts: [],
      loginPollIntervalMs: 1000,
    }
    const endpoints: string[] = []
    const rpc: ClientConnectionRpc = {
      call: async (_channel, endpoint) => {
        endpoints.push(endpoint)
        if (endpoint !== 'chatgpt/getState') throw new Error(`unexpected Remote request: ${endpoint}`)
        return { ok: true, value: stateSnapshot }
      },
      open: (_channel, endpoint, _payload, signal) => {
        if (endpoint !== '$events') throw new Error(`unexpected Remote stream: ${endpoint}`)
        return eventStream(signal)
      },
    }
    connection.installConnection(ctx, { transport: { rpc, ownsHost: true } })
    await ctx.plugin({ inject: [...registry.inject], apply: registry.apply }).await()
    await ctx.plugin({ inject: [...gateway.inject], apply: gateway.apply }).await()

    let localeDisposals = 0
    let slotDisposals = 0
    let settingsInject: (() => ChatGptSettingsInjected) | undefined
    let settingsComponent: unknown
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
    ctx.provide('sessions', { binding: () => undefined } as never)
    ctx.provide('slots', slots as never)

    await ctx.loader.await()
    expect(entry.fiber?.state).toBe(2)
    expect(ctx.get('remote.chatgpt')).toBeDefined()
    expect(localeDisposals).toBe(0)
    expect(slotDisposals).toBe(0)

    const injected = settingsInject?.()
    expect(injected).toBeDefined()
    const response = await injected!.remote.getState()
    expect(response).toEqual({ ok: true, value: expect.objectContaining({ accounts: [], welcomeAcknowledged: true }) })
    expect(endpoints).toEqual(['chatgpt/getState'])

    const translations: Readonly<Record<string, string>> = en
    render(createElement(settingsComponent as ComponentType<Record<string, unknown>>, {
      ...injected,
      close: () => undefined,
      t: (key: ChatGptKey) => translations[key] ?? key,
    }))
    expect(await screen.findByText(en.noAccounts)).toBeTruthy()

    await ctx.fiber.dispose()
    await ctx.fiber.await()
    expect(ctx.get('remote.chatgpt')).toBeUndefined()
    expect(localeDisposals).toBe(3)
    expect(slotDisposals).toBe(2)
  })
})

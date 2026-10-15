import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'
import { afterEach, describe, expect, it } from 'vitest'
import { TYPERT_REMOTE } from '../lib/typert.remote-client.js'

const packageName = '@f12o/dsh-siwc'
const root = import.meta.dirname === undefined ? process.cwd() : `${import.meta.dirname}/../../..`
const methods = [
  'acknowledgeWelcome',
  'beginLogin',
  'cancelLogin',
  'getState',
  'refreshModels',
  'setActiveAccount',
  'setModelConfig',
  'signOut',
] as const
const temporaryRoots: string[] = []

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('standalone Typert artifacts', () => {
  it('recognizes the installed protocol package through the public generate API', () => {
    const result = new WorkspaceTypertGenerator(root).generate([packageName], ['host'])
      .find(artifact => artifact.package === packageName)
    const remote = result?.remote
    expect(remote).toBeDefined()
    expect(remote?.dts).toContain('declare module \'@deepseek-ai/dsh-typert-protocol\'')
    for (const method of methods) {
      expect(remote?.dts).toContain(`${method}:`)
      expect(remote?.js).toContain(`'chatgpt/${method}':`)
    }
    expect(remote?.js.match(/'chatgpt\/[A-Za-z]+':/gu)).toHaveLength(methods.length)
  })

  it('ships the complete tsdown-generated Client contribution and strict codecs', () => {
    expect(TYPERT_REMOTE.package).toBe(packageName)
    expect(TYPERT_REMOTE.descriptors.map(descriptor => descriptor.method).sort()).toEqual([...methods].sort())
    for (const descriptor of TYPERT_REMOTE.descriptors) {
      expect(descriptor.result.create()).toBeDefined()
      for (const parameter of descriptor.parameters) {
        if (parameter.source === 'json') expect(parameter.codec.create()).toBeDefined()
      }
    }
    expect(TYPERT_REMOTE.descriptors.find(descriptor => descriptor.method === 'getState')?.result
      .create().safeParse({ accounts: [], welcomeAcknowledged: false, loginAttempts: [], loginPollIntervalMs: 1000 }).success).toBe(true)
  })

  it('rejects an ambient declaration that only imitates the protocol package', () => {
    const fixture = copyTypertFixture()
    const configPath = join(fixture, 'tsconfig.host.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> }
    }
    config.compilerOptions = {
      baseUrl: '.',
      paths: {
        '@deepseek-ai/dsh-typert-protocol': ['./packages/chatgpt/src/fake-protocol.d.ts'],
      },
    }
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
    writeFileSync(join(fixture, 'packages/chatgpt/src/fake-protocol.d.ts'), `
declare module '@deepseek-ai/dsh-typert-protocol' {
  export class TypertRemoteService {
    constructor(ctx: unknown, serviceKey: string, options?: { readonly namespace?: string })
  }
  export function Remote<This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void
}
`)

    expect(() => new WorkspaceTypertGenerator(fixture, { checkDiagnostics: false })
      .generate([packageName], ['host'])).toThrow('publishes Remote artifacts but has no Remote methods')
  })

  it.each([
    ['non-JSON result', 'acknowledgeWelcome(): Promise<unknown>', 'Remote boundary contains unconstrained unknown data'],
    ['non-final cancellation signal', 'setActiveAccount(signal: AbortSignal, request: ChatGptAccountRequest)', 'Remote cancellation signal must be the final parameter'],
  ])('rejects a genuine Remote with an invalid %s', (_name, signature, diagnostic) => {
    const fixture = copyTypertFixture()
    const sourcePath = join(fixture, 'packages/chatgpt/src/index.ts')
    let source = readFileSync(sourcePath, 'utf8')
    if (signature.startsWith('acknowledgeWelcome')) {
      source = source.replace('acknowledgeWelcome(): Promise<void>', signature)
    } else {
      source = source.replace('setActiveAccount(request: ChatGptAccountRequest)', signature)
    }
    writeFileSync(sourcePath, source)

    expect(() => new WorkspaceTypertGenerator(fixture, { checkDiagnostics: false })
      .generate([packageName], ['host'])).toThrow(diagnostic)
  })
})

function copyTypertFixture(): string {
  const fixture = mkdtempSync(join(tmpdir(), 'dsh-siwc-typert-'))
  temporaryRoots.push(fixture)
  mkdirSync(join(fixture, 'packages'), { recursive: true })
  cpSync(join(root, 'tsconfig.host.json'), join(fixture, 'tsconfig.host.json'))
  cpSync(join(root, 'packages/chatgpt'), join(fixture, 'packages/chatgpt'), {
    recursive: true,
    filter: path => !path.split(/[\\/]/u).some(segment => ['node_modules', 'lib', 'tests'].includes(segment)),
  })
  symlinkSync(join(root, 'packages/chatgpt/node_modules'), join(fixture, 'node_modules'), 'dir')
  return fixture
}

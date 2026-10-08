import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

const hostManifest = JSON.parse(readFileSync(new URL('./packages/chatgpt/package.json', import.meta.url), 'utf8')) as {
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly dependencies?: Readonly<Record<string, string>>
}
const hostNeverBundle = new Set([
  ...Object.keys(hostManifest.peerDependencies ?? {}),
  ...Object.keys(hostManifest.dependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/')),
])

export default defineConfig({
  entry: ['packages/chatgpt/lib/types/index.js', 'packages/chatgpt/lib/types/preflight.js'],
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  outDir: 'packages/chatgpt/lib',
  fixedExtension: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: specifier => hostNeverBundle.has(specifier),
    alwaysBundle: specifier => !hostNeverBundle.has(specifier),
  },
  plugins: [typertPlugin({ mode: 'workspace', faces: ['host'] })],
})

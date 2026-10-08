import { defineConfig } from 'tsdown'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

export default defineConfig({
  entry: ['packages/chatgpt/lib/types/index.js'],
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  outDir: 'packages/chatgpt/lib',
  fixedExtension: false,
  clean: false,
  sourcemap: true,
  plugins: [typertPlugin({ mode: 'workspace', faces: ['host'] })],
})

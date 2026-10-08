import { defineConfig } from 'tsdown'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

export default defineConfig({
  entry: ['lib/types/index.js'],
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  outDir: 'lib',
  fixedExtension: false,
  clean: false,
  sourcemap: true,
  plugins: [typertPlugin({ mode: 'package', faces: ['host'] })],
})

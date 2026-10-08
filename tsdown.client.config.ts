import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve, sep } from 'node:path'
import { defineConfig, type TsdownPlugin } from 'tsdown'
import { transform } from 'lightningcss'

const PLUGIN_ID = '@f4ah6o/dsh-chatgpt'
const CSS_PREFIX = '\0dsh-chatgpt-css:'
const CSS_SUFFIX = '.mjs'
const LOADER_MODULES = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/** Resolve a stylesheet next to its TypeScript source rather than its tsc output. */
function sourceAssetPath(source: string, importer: string): string {
  const marker = `${sep}lib${sep}types${sep}client${sep}`
  const index = importer.lastIndexOf(marker)
  if (index < 0) return resolve(dirname(importer), source)
  const sourceImporter = `${importer.slice(0, index)}${sep}src${sep}client${sep}${importer.slice(index + marker.length)}`
  return resolve(dirname(sourceImporter), source)
}

/** Inline relative SVG assets so extracted styles do not depend on a runtime URL base. */
function inlineSvgAssets(css: string, stylesheet: string, addWatchFile: (file: string) => void): string {
  return css.replace(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]*?))\s*\)/gu, (whole, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined) => {
    const value = (doubleQuoted ?? singleQuoted ?? bare ?? '').trim()
    if (value.length === 0 || /^(?:data:|https?:|\/\/|#)/iu.test(value)) return whole
    const path = value.split(/[?#]/u, 1)[0]
    if (path === undefined || !path.toLowerCase().endsWith('.svg')) return whole
    const asset = resolve(dirname(stylesheet), decodeURIComponent(path))
    if (!existsSync(asset)) throw new Error(`dsh-chatgpt: missing SVG asset ${asset}`)
    addWatchFile(asset)
    const contents = readFileSync(asset).toString('base64')
    return `url("data:image/svg+xml;base64,${contents}")`
  })
}

/** Inject one package-owned stylesheet and return its CSS-module class map. */
function cssModules(): TsdownPlugin {
  return {
    name: 'dsh-chatgpt-css-modules',
    resolveId(source, importer) {
      if (!source.endsWith('.module.css') || importer === undefined) return null
      const file = sourceAssetPath(source, importer)
      if (!existsSync(file)) throw new Error(`dsh-chatgpt: missing stylesheet ${file}`)
      return `${CSS_PREFIX}${file}${CSS_SUFFIX}`
    },
    load(virtualId) {
      if (!virtualId.startsWith(CSS_PREFIX) || !virtualId.endsWith(CSS_SUFFIX)) return null
      const file = virtualId.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
      this.addWatchFile(file)
      const source = inlineSvgAssets(readFileSync(file, 'utf8'), file, asset => this.addWatchFile(asset))
      const { code, exports: cssExports } = transform({
        filename: file,
        code: Buffer.from(source),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classes: Record<string, string> = {}
      for (const [local, entry] of Object.entries(cssExports ?? {})) classes[local] = entry.name
      const tagId = `${PLUGIN_ID}/${basename(file)}`
      const css = JSON.stringify(code.toString())
      const tag = JSON.stringify(tagId)
      return [
        `const css = ${css};`,
        `const tagId = ${tag};`,
        "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
        "  const tag = document.createElement('style');",
        `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classes)};`,
      ].join('\n')
    },
  }
}

export default defineConfig({
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'packages/chatgpt/lib/types/client/index.js' },
  outDir: 'packages/chatgpt/lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: specifier => LOADER_MODULES.has(specifier),
    alwaysBundle: specifier => !LOADER_MODULES.has(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [cssModules()],
  outputOptions: {
    entryFileNames: 'client.js',
    chunkFileNames: 'client.[name].js',
    sourcemapExcludeSources: false,
    banner: () => `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})

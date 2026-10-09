/** Validate the profile services used by the ChatGPT Host at launcher readiness. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-authorization'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'

const CHATGPT_HOST_PACKAGE = '@f12o/dsh-siwc'
const REQUIRED_SERVICES = ['credentials', 'authorization', 'llm'] as const

/** Name shown in Cordis plugin diagnostics. */
export const name = '@f12o/dsh-siwc/preflight'

/** Require the DSH launcher readiness signal and public Loader entry registry. */
export const inject = ['appReady', 'loader']

/** Fail profile startup when an enabled ChatGPT Host row lacks a required service.
 * @param ctx - DSH profile context carrying the launcher readiness signal and Loader.
 * @returns Nothing; the Cordis effect owns the readiness listener.
 */
export function apply(ctx: Context): void {
  const appReady = ctx.get('appReady')
  if (appReady === undefined) throw new Error('ChatGPT preflight requires the DSH launcher appReady service.')
  const loader = ctx.get('loader')
  if (loader === undefined) throw new Error('ChatGPT preflight requires the DSH Loader service.')

  ctx.effect(() => appReady.onReady(() => {
    const hostEntries = [...loader.entries()].filter(entry =>
      entry.options.name === CHATGPT_HOST_PACKAGE && !entry.disabled,
    )
    const missing = [...new Set(hostEntries.flatMap(entry =>
      REQUIRED_SERVICES.filter(service => entry.context.get(service) === undefined),
    ))]
    if (missing.length) throw new Error(`ChatGPT requires services: ${missing.join(', ')}`)
  }), 'ChatGPT profile service validation')
}

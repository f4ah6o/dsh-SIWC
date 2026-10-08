/** Browser Client plugin for ChatGPT plan settings and usage feedback. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@f4ah6o/dsh-chatgpt/remote'
import type { ChatGptLoginAttemptId } from '@f4ah6o/dsh-chatgpt/types'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { TYPERT_REMOTE } from '@f4ah6o/dsh-chatgpt/remote'
import { en, ja, zh, type ChatGptKey } from './locales.ts'
import { ChatGptSettingsSection } from './ChatGptSettingsSection.tsx'
import type { ChatGptSettingsInjected } from './ChatGptSettingsSection.tsx'
import { UsageIndicator } from './UsageIndicator.tsx'
import type { UsageIndicatorInjected } from './UsageIndicator.tsx'
import { ChatGptUsageLimitSource } from './quota.ts'

export type { ChatGptKey } from './locales.ts'
export type { ChatGptSettingsInjected } from './ChatGptSettingsSection.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** ChatGPT plan account settings and composer status. */
    'settings.chatgpt': ChatGptKey
  }
}

const NS = 'settings.chatgpt'

/** Services required from the Client shell before this package mounts. */
export const inject = ['slots', 'locale', 'remote', 'sessions']

/** Mount ChatGPT Remote descriptors and register the account and composer UI.
 * @param ctx - browser Client context.
 * @returns when Remote descriptors and UI registrations are ready.
 */
export async function apply(ctx: Context): Promise<void> {
  const unmountRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  ctx.effect(() => unmountRemote, 'dsh-chatgpt: remote descriptors')

  const attempts = new Set<ChatGptLoginAttemptId>()
  ctx.effect(() => async () => {
    await Promise.all([...attempts].map(async attemptId => {
      try { await ctx.remote.chatgpt.cancelLogin({ attemptId }) }
      catch (_error) { /* Host teardown may already have removed the attempt. */ }
    }))
    attempts.clear()
  }, 'dsh-chatgpt: pending login attempts')

  ctx.effect(() => {
    const offEnglish = ctx.locale.register(NS, 'en', en)
    const offJapanese = ctx.locale.register(NS, 'ja', ja)
    const offChinese = ctx.locale.register(NS, 'zh', zh)
    return () => { offChinese(); offJapanese(); offEnglish() }
  }, 'dsh-chatgpt: locale dictionaries')
  const t = ctx.locale.bind(NS)
  const usageLimits = new Map<SessionBinding, ChatGptUsageLimitSource>()
  ctx.effect(() => () => {
    for (const source of usageLimits.values()) source.dispose()
    usageLimits.clear()
  }, 'dsh-chatgpt: usage notices')

  const settingsInjected = (): ChatGptSettingsInjected => ({
    remote: ctx.remote.chatgpt,
    trackAttempt: id => { attempts.add(id) },
    finishAttempt: id => { attempts.delete(id) },
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'chatgpt',
    order: 20,
    locale: NS,
    label: () => t('nav'),
    inject: settingsInjected,
  }, ChatGptSettingsSection))

  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'chatgpt-usage',
    order: 2,
    locale: NS,
    inject: (sessionId): UsageIndicatorInjected => {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) throw new Error(`dsh-chatgpt: unknown Session "${String(sessionId)}"`)
      let usageLimit = usageLimits.get(binding)
      if (usageLimit === undefined) {
        usageLimit = new ChatGptUsageLimitSource(binding)
        usageLimits.set(binding, usageLimit)
        const source = usageLimit
        binding.ctx.effect(() => () => {
          source.dispose()
          usageLimits.delete(binding)
        }, 'dsh-chatgpt: Session usage notice')
      }
      return { hooks: { usageLimit } }
    },
  }, UsageIndicator))
}

export default apply

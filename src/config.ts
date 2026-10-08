/** Profile configuration and validation for the ChatGPT account plugin. */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ChatGptModelOverride } from './types.ts'

/** Values stored in the profile patch; account tokens live in Credentials instead. */
export interface Config {
  /** Active account selection for this profile. */
  readonly activeAccountId: Volatile<string | undefined>
  /** Whether a Client has acknowledged the first-login welcome view. */
  readonly welcomeAcknowledged: Volatile<boolean>
  /** Start the loopback sign-in flow before a headless task when no account exists. */
  readonly authorizeOnStart: Volatile<boolean>
  /** Per-model capability overrides, also usable from headless profile patches. */
  readonly modelOverrides: Volatile<ChatGptModelOverride[]>
  /** Maximum token/OAuth request duration in milliseconds. */
  readonly requestTimeoutMs: Volatile<number>
  /** Delay between Client snapshots while a sign-in callback is pending. */
  readonly loginPollIntervalMs: Volatile<number>
}

const modelOverride = z.object({
  model: z.string().min(1).required(),
  contextWindow: z.union([z.number().step(1).min(1), z.const(undefined)]),
  inputModalities: z.union([z.array(z.union(['text', 'image'] as const)).min(1), z.const(undefined)]),
  reasoningEfforts: z.union([z.array(z.string().min(1)).min(1), z.const(undefined)]),
  defaultReasoningEffort: z.union([z.string().min(1), z.const(undefined)]),
})

/** Cordis schema for persistent account selection and SIWC capability overrides. */
export const Config: z = z.object({
  activeAccountId: z.string().min(1).volatile(),
  welcomeAcknowledged: z.boolean().default(false).volatile(),
  authorizeOnStart: z.boolean().default(false).volatile(),
  modelOverrides: z.array(modelOverride).default([]).volatile(),
  requestTimeoutMs: z.number().step(1).min(1).max(30_000).default(10_000).volatile(),
  loginPollIntervalMs: z.number().step(1).min(1).max(30_000).default(1_000).volatile(),
})

/** Provider-owned LLM failure construction shared by the Host and its Responses adapter. */
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { BuiltinLlmFailureCode, LlmErrorOptions, ProviderRequestId } from '@deepseek-ai/dsh-llm'

/** Serializable provider facts carried beside one raised failure. */
interface ProviderFailureFacts {
  status?: number
  providerRetryAfterMs?: number
  requestId?: ProviderRequestId
  offloadImages?: number
}

type FromFailure = (
  failure: { message: string; code: string } & ProviderFailureFacts,
  options?: ErrorOptions,
) => LlmError

/**
 * Raise a provider-owned failure code outside DSH's built-in LLM taxonomy.
 *
 * DSH 0.2.2-rc.2 narrows the `LlmError` constructor to built-in codes and adds
 * `LlmError.fromFailure` for any other code. Earlier DSH lines this package
 * supports expose only the constructor, whose runtime validation accepts any
 * non-empty code; `fromFailure` itself delegates to that constructor with the
 * same facts, so both paths raise the same error.
 * @param message - non-empty human-readable failure summary.
 * @param code - provider-owned stable machine code.
 * @param options - optional cause and serializable provider facts.
 * @returns an `LlmError` carrying the supplied code and facts.
 */
export function providerFailure(message: string, code: string, options: LlmErrorOptions = {}): LlmError {
  const fromFailure = (LlmError as typeof LlmError & { fromFailure?: FromFailure }).fromFailure
  if (fromFailure === undefined) return new LlmError(message, code as BuiltinLlmFailureCode, options)
  const { cause, ...facts } = options
  return fromFailure.call(LlmError, { message, code, ...facts }, cause === undefined ? undefined : { cause })
}

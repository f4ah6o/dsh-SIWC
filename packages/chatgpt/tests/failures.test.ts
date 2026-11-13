/** Provider-owned failure construction across supported DSH error APIs. */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { providerFailure } from '../src/failures.js'

const originalFromFailure = LlmError.fromFailure

afterEach(() => {
  Object.defineProperty(LlmError, 'fromFailure', {
    value: originalFromFailure,
    configurable: true,
    writable: true,
  })
})

describe('provider failure compatibility', () => {
  it('retains a provider-owned code and facts on the current DSH line', () => {
    const cause = new Error('upstream')
    const error = providerFailure('provider request failed', 'CHATGPT_TEST_FAILURE', { status: 502, cause })

    expect(error).toBeInstanceOf(LlmError)
    expect(error.code).toBe('CHATGPT_TEST_FAILURE')
    expect(error.failure).toMatchObject({
      message: 'provider request failed',
      code: 'CHATGPT_TEST_FAILURE',
      status: 502,
    })
    expect(error.cause).toBe(cause)
  })

  it('falls back to the legacy constructor when fromFailure is absent', () => {
    Object.defineProperty(LlmError, 'fromFailure', {
      value: undefined,
      configurable: true,
      writable: true,
    })

    const error = providerFailure('provider request failed', 'CHATGPT_TEST_FAILURE')

    expect(error).toBeInstanceOf(LlmError)
    expect(error.code).toBe('CHATGPT_TEST_FAILURE')
    expect(error.failure).toMatchObject({ code: 'CHATGPT_TEST_FAILURE' })
  })
})

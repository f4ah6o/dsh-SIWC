import { describe, expect, it } from 'vitest'
import { en, ja, zh } from '../src/client/locales.ts'

describe('ChatGPT Client locale dictionaries', () => {
  it('keep the same translated key set in English, Japanese, and Chinese', () => {
    const keys = Object.keys(en).sort()
    expect(Object.keys(ja).sort()).toEqual(keys)
    expect(Object.keys(zh).sort()).toEqual(keys)
  })
})

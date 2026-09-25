import { describe, expect, it } from 'vitest'
import { canonicalJson, containsPotentialSecret, digestJson, redactSecrets, redactText } from '../../packages/core/src/index.js'

describe('canonical hashing', () => {
  it('is independent of object key insertion order but preserves array order', () => {
    const left = { z: 1, nested: { b: 2, a: 1 }, values: ['first', 'second'] }
    const right = { values: ['first', 'second'], nested: { a: 1, b: 2 }, z: 1 }
    expect(canonicalJson(left)).toBe(canonicalJson(right))
    expect(digestJson(left)).toBe(digestJson(right))
    expect(digestJson({ ...left, values: ['second', 'first'] })).not.toBe(digestJson(left))
  })

  it('refuses values that cannot be represented deterministically', () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(TypeError)
    expect(() => canonicalJson({ value: 1n })).toThrow(TypeError)
  })
})

describe('secret redaction', () => {
  it('redacts sensitive keys, inline tokens, assignments, and explicitly known secrets', () => {
    const knownSecret = 'locally-provided-sensitive-value'
    const value = {
      authorization: 'Bearer abcdefghijklmnop',
      nested: { DEEPSEEK_API_KEY: 'dsk-abcdefghijklmnop', note: `prefix ${knownSecret} suffix` },
      command: 'DEEPSEEK_API_KEY=dsk-1234567890123456 pnpm demo',
    }
    const redacted = redactSecrets(value, { knownSecrets: [knownSecret] })
    expect(redacted.authorization).toBe('[REDACTED]')
    expect(redacted.nested.DEEPSEEK_API_KEY).toBe('[REDACTED]')
    expect(redacted.nested.note).not.toContain(knownSecret)
    expect(redacted.command).not.toContain('dsk-')
    expect(containsPotentialSecret(value, { knownSecrets: [knownSecret] })).toBe(true)
    expect(containsPotentialSecret(redacted, { knownSecrets: [knownSecret] })).toBe(false)
  })

  it('leaves normal trace and architecture data intact', () => {
    const text = 'trace=abc123 component=queue state=DRAINING'
    expect(redactText(text)).toBe(text)
  })
})

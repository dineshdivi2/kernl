import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findSecretMatches } from '../../packages/runtime/src/policy.js'
import { runCommand, sanitizedChildEnvironment } from '../../packages/runtime/src/process.js'

describe('runtime secret scanning', () => {
  it('reports a location and classification without returning credential material', () => {
    const secret = `sk-${'a'.repeat(24)}`
    const matches = findSecretMatches(`value=${secret}`)

    expect(matches).toEqual(['TOKEN_PATTERN@6'])
    expect(JSON.stringify(matches)).not.toContain(secret)
    expect(JSON.stringify(matches)).not.toContain('sk-')
  })
})

describe('runtime child process isolation', () => {
  it('does not inherit credentials and rejects sensitive overrides', async () => {
    const original = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = `sk-${'x'.repeat(24)}`
    try {
      expect(sanitizedChildEnvironment()).not.toHaveProperty('DEEPSEEK_API_KEY')
      expect(() => sanitizedChildEnvironment({ OPENAI_API_KEY: 'must-not-pass' }))
        .toThrow(/sensitive child environment variable/)
      const result = await runCommand(process.execPath, [
        '-e',
        "process.stdout.write(String(Boolean(process.env.DEEPSEEK_API_KEY)))",
      ], tmpdir())
      expect(result).toMatchObject({ exitCode: 0, stdout: 'false' })
    } finally {
      if (original === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = original
    }
  })

  it('allows loopback verification but denies an external fetch before connection', async () => {
    const guard = fileURLToPath(new URL('../../packages/runtime/assets/deny-external-network.cjs', import.meta.url))
    const result = await runCommand(process.execPath, [
      '--require', guard,
      '-e',
      "fetch('https://example.com').catch(error => { console.error(error.message); process.exitCode = 7 })",
    ], tmpdir())

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('Kernl verification denied external fetch target: example.com')
  })
})

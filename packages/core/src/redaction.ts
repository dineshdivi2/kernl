const SECRET_KEY_PATTERN = /(?:api[-_]?key|authorization|bearer|credential|password|passwd|secret|token|private[-_]?key|client[-_]?secret|access[-_]?key)/i

const INLINE_PATTERNS: RegExp[] = [
  /\b(?:sk|dsk|sk-proj)-[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b(?:DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*=\s*[^\s"']+/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
]

export const REDACTED = '[REDACTED]'

export interface RedactionOptions {
  knownSecrets?: readonly string[]
}

function redactKnownSecrets(text: string, knownSecrets: readonly string[]): string {
  return knownSecrets
    .filter((secret) => secret.length >= 4)
    .sort((left, right) => right.length - left.length)
    .reduce((result, secret) => result.split(secret).join(REDACTED), text)
}

export function redactText(text: string, options: RedactionOptions = {}): string {
  let result = redactKnownSecrets(text, options.knownSecrets ?? [])
  for (const pattern of INLINE_PATTERNS) {
    result = result.replace(pattern, (match) => {
      const assignment = match.match(/^([A-Z0-9_]+\s*=\s*)/)
      return assignment ? `${assignment[1]}${REDACTED}` : REDACTED
    })
  }
  return result
}

export function redactSecrets<T>(value: T, options: RedactionOptions = {}): T {
  const seen = new WeakMap<object, unknown>()

  function visit(current: unknown, key?: string): unknown {
    if (key && SECRET_KEY_PATTERN.test(key)) return REDACTED
    if (typeof current === 'string') return redactText(current, options)
    if (current === null || typeof current !== 'object') return current

    const existing = seen.get(current)
    if (existing !== undefined) return existing

    if (Array.isArray(current)) {
      const output: unknown[] = []
      seen.set(current, output)
      for (const item of current) output.push(visit(item))
      return output
    }

    const output: Record<string, unknown> = {}
    seen.set(current, output)
    for (const [childKey, child] of Object.entries(current)) {
      output[childKey] = visit(child, childKey)
    }
    return output
  }

  return visit(value) as T
}

export function containsPotentialSecret(value: unknown, options: RedactionOptions = {}): boolean {
  const visited = new WeakSet<object>()
  const inspect = (current: unknown, key?: string): boolean => {
    if (key && SECRET_KEY_PATTERN.test(key) && current !== REDACTED && current !== null && current !== '') return true
    if (typeof current === 'string') return redactText(current, options) !== current
    if (current === null || typeof current !== 'object' || visited.has(current)) return false
    visited.add(current)
    if (Array.isArray(current)) return current.some((item) => inspect(item))
    return Object.entries(current).some(([childKey, child]) => inspect(child, childKey))
  }
  return inspect(value)
}

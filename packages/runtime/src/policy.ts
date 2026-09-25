import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import type { AgentMutation, RuntimeTask } from './types.js'

function normalizeRelative(path: string): string {
  const normalized = normalize(path).replaceAll('\\', '/')
  if (isAbsolute(path) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`runtime policy denied path outside task workspace: ${path}`)
  }
  return normalized
}

function matchesScope(path: string, scope: string): boolean {
  const normalizedScope = normalizeRelative(scope).replace(/\/\*\*$/, '')
  return path === normalizedScope || path.startsWith(`${normalizedScope}/`)
}

export function authorizeMutations(task: RuntimeTask, workspace: string, mutations: readonly AgentMutation[]): void {
  if (mutations.length === 0) throw new Error(`task ${task.id} proposed no mutations`)
  for (const mutation of mutations) {
    const path = normalizeRelative(mutation.path)
    if (!task.allowedPaths.some(scope => matchesScope(path, scope))) {
      throw new Error(`runtime policy denied ${path}; allowed scopes: ${task.allowedPaths.join(', ')}`)
    }
    const target = resolve(workspace, path)
    const fromWorkspace = relative(resolve(workspace), target)
    if (fromWorkspace.startsWith('..') || fromWorkspace.split(sep).includes('..')) {
      throw new Error(`runtime policy denied resolved path: ${path}`)
    }
    if (/\b(?:tests?|policies|evidence)\b/i.test(path) && task.forbiddenActions.includes('modify-verification')) {
      throw new Error(`runtime policy denied verification mutation: ${path}`)
    }
  }
}

export function assertChangedPathsAuthorized(task: RuntimeTask, paths: readonly string[]): void {
  for (const raw of paths) {
    const path = normalizeRelative(raw)
    if (!task.allowedPaths.some(scope => matchesScope(path, scope))) {
      throw new Error(`task ${task.id} changed unauthorized path ${path}`)
    }
  }
}

const SECRET_PATTERNS = [
  { label: 'TOKEN_PATTERN', pattern: /(?:sk|dsk|sk-proj)-[A-Za-z0-9_-]{12,}/g },
  { label: 'API_KEY_ASSIGNMENT', pattern: /(?:DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*[=:]\s*[^\s"']+/gi },
  { label: 'PRIVATE_KEY_HEADER', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
] as const

export function findSecretMatches(text: string): string[] {
  // Never return matched text: even a partial credential must not enter an
  // exception, event, SQLite row, or evidence artifact.
  return SECRET_PATTERNS.flatMap(({ label, pattern }) =>
    [...text.matchAll(pattern)].map((match, index) => `${label}@${match.index ?? index}`),
  )
}

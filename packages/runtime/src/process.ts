import { spawn } from 'node:child_process'
import { basename, resolve } from 'node:path'
import type { CommandResult } from './types.js'

const ALLOWED_EXECUTABLES = new Set(['git', 'git.exe', 'node', 'node.exe'])
const SAFE_INHERITED_ENVIRONMENT = new Set([
  'CI',
  'COMSPEC',
  'FORCE_COLOR',
  'LANG',
  'LC_ALL',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'WINDIR',
])

const SENSITIVE_ENVIRONMENT_NAME = /(?:API.?KEY|AUTH|BEARER|COOKIE|CREDENTIAL|PASSWORD|SECRET|SESSION|TOKEN)/i

function assertAllowedExecutable(command: string): void {
  const executable = basename(command).toLowerCase()
  if (!ALLOWED_EXECUTABLES.has(executable)) {
    throw new Error(`runtime policy denied executable: ${executable}`)
  }
}

export function sanitizedChildEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (SAFE_INHERITED_ENVIRONMENT.has(name.toUpperCase()) && value !== undefined) environment[name] = value
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (SENSITIVE_ENVIRONMENT_NAME.test(name)) throw new Error(`runtime policy denied sensitive child environment variable: ${name}`)
    if (name.toUpperCase() === 'NODE_OPTIONS') throw new Error('runtime policy denied caller-supplied NODE_OPTIONS')
    if (value !== undefined) environment[name] = value
  }
  return environment
}

export async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  assertAllowedExecutable(command)
  const started = performance.now()
  const timeoutMs = options.timeoutMs ?? 30_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const result = await new Promise<Omit<CommandResult, 'command' | 'args' | 'cwd' | 'durationMs'>>((resolveResult, reject) => {
      const child = spawn(command, [...args], {
        cwd: resolve(cwd),
        env: sanitizedChildEnvironment(options.env),
        shell: false,
        windowsHide: true,
        signal: controller.signal,
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.on('error', error => reject(error))
      child.on('close', code => resolveResult({ exitCode: code ?? 1, stdout, stderr }))
    })
    return {
      command,
      args: [...args],
      cwd: resolve(cwd),
      durationMs: Math.round(performance.now() - started),
      ...result,
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function requireSuccessful(result: Promise<CommandResult>): Promise<CommandResult> {
  const awaited = await result
  if (awaited.exitCode !== 0) {
    throw new Error(
      `command failed (${awaited.exitCode}): ${awaited.command} ${awaited.args.join(' ')}\n${awaited.stderr || awaited.stdout}`,
    )
  }
  return awaited
}

import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { findSecretMatches } from './policy.js'
import { runCommand } from './process.js'
import type { GateResult, VerificationReport } from './types.js'

export interface GateSpec {
  id: string
  command: string
  timeoutMs?: number
}

/** Deterministic gate-id → failure-fingerprint mapping used by repair drills. */
export const GATE_FAILURE_FINGERPRINTS: Readonly<Record<string, string>> = {
  idempotency: 'duplicate-event-effect',
  'dlq-contract': 'dead-letter-attempts-missing',
}

export function failureFingerprintForGate(gateId: string): string {
  return GATE_FAILURE_FINGERPRINTS[gateId] ?? `${gateId}-failure`
}

async function collectTextFiles(root: string, current = root): Promise<Array<{ path: string; text: string }>> {
  const entries = await readdir(current, { withFileTypes: true })
  const files: Array<{ path: string; text: string }> = []
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue
    const absolute = join(current, entry.name)
    if (entry.isDirectory()) files.push(...await collectTextFiles(root, absolute))
    else files.push({ path: relative(root, absolute).replaceAll('\\', '/'), text: await readFile(absolute, 'utf8') })
  }
  return files
}

/**
 * Catalog-driven deterministic verifier. Gate commands come from catalog
 * manifests and AIR verification blocks; nothing here knows component names.
 */
export class GenericVerifier {
  private readonly projectRoot: string
  /** In-process gates keyed by command marker, e.g. `in-process:<name>`. */
  private readonly inProcessGates: Readonly<Record<string, (cwd: string) => Promise<Omit<GateResult, 'name'>>>>

  constructor(
    projectRoot: string,
    options: { inProcessGates?: Record<string, (cwd: string) => Promise<Omit<GateResult, 'name'>>> } = {},
  ) {
    this.projectRoot = projectRoot
    this.inProcessGates = options.inProcessGates ?? {}
  }

  private translate(command: string): { command: string; args: string[] } {
    const parts = command.trim().split(/\s+/)
    const head = parts[0] ?? ''
    const rest = parts.slice(1)
    if (head === 'tsc') {
      return { command: process.execPath, args: [join(this.projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'), ...rest] }
    }
    if (head === 'node' || head === 'node.exe') {
      const guard = join(this.projectRoot, 'packages', 'runtime', 'assets', 'deny-external-network.cjs')
      return { command: process.execPath, args: ['--require', guard, ...rest] }
    }
    throw new Error(`unsupported gate command executable: ${head}`)
  }

  private async secretGate(cwd: string): Promise<GateResult> {
    const started = performance.now()
    const files = await collectTextFiles(cwd)
    const matches = files.flatMap(file => findSecretMatches(file.text).map(match => `${file.path}: ${match}`))
    return {
      name: 'secret-scan',
      status: matches.length === 0 ? 'passed' : 'failed',
      exitCode: matches.length === 0 ? 0 : 1,
      durationMs: Math.round(performance.now() - started),
      summary: matches.length === 0 ? `scanned ${files.length} source artifacts; no secret pattern found` : `found ${matches.length} possible secrets`,
      stdout: matches.join('\n'),
      stderr: '',
    }
  }

  async runGate(cwd: string, spec: GateSpec): Promise<GateResult> {
    if (spec.command.startsWith('in-process:')) {
      const name = spec.command.slice('in-process:'.length)
      const handler = this.inProcessGates[name]
      if (!handler) throw new Error(`no in-process gate registered for ${name}`)
      const result = await handler(cwd)
      return { name: spec.id, ...result }
    }
    const translated = this.translate(spec.command)
    const result = await runCommand(translated.command, translated.args, cwd, { timeoutMs: spec.timeoutMs ?? 60_000 })
    const passed = result.exitCode === 0
    const fingerprint = passed ? undefined : failureFingerprintForGate(spec.id)
    return {
      name: spec.id,
      status: passed ? 'passed' : 'failed',
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      summary: passed ? `${spec.id} gate passed` : `${spec.id} gate failed with exit code ${result.exitCode}`,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(fingerprint ? { failureFingerprint: fingerprint } : {}),
    }
  }

  async verify(cwd: string, attempt: number, gates: readonly GateSpec[]): Promise<VerificationReport> {
    const startedAt = new Date().toISOString()
    const results: GateResult[] = []
    let failed = false
    for (const spec of gates) {
      if (failed) {
        results.push({
          name: spec.id,
          status: 'failed',
          exitCode: -1,
          durationMs: 0,
          summary: `${spec.id} gate not executed after earlier gate failure`,
          stdout: '',
          stderr: '',
        })
        continue
      }
      const result = await this.runGate(cwd, spec)
      results.push(result)
      if (result.status === 'failed') failed = true
    }
    const secret = await this.secretGate(cwd)
    results.push(secret)
    if (secret.status === 'failed') failed = true
    const report: VerificationReport = {
      attempt,
      status: failed ? 'failed' : 'passed',
      startedAt,
      finishedAt: new Date().toISOString(),
      gates: results,
    }
    report.digest = createHash('sha256').update(JSON.stringify(report)).digest('hex')
    return report
  }
}

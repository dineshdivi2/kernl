import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { findSecretMatches } from './policy.js'
import { runCommand } from './process.js'
import type { GateResult, VerificationReport } from './types.js'

async function commandGate(
  name: GateResult['name'],
  command: string,
  args: string[],
  cwd: string,
  failureFingerprint?: string,
  repairScope?: string[],
): Promise<GateResult> {
  const result = await runCommand(command, args, cwd, { timeoutMs: 60_000 })
  const passed = result.exitCode === 0
  return {
    name,
    status: passed ? 'passed' : 'failed',
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    summary: passed ? `${name} gate passed` : `${name} gate failed with exit code ${result.exitCode}`,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(!passed && failureFingerprint ? { failureFingerprint } : {}),
    ...(!passed && repairScope ? { repairScope } : {}),
  }
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

async function architectureGate(cwd: string): Promise<GateResult> {
  const started = performance.now()
  const [api, worker, queue] = await Promise.all([
    readFile(join(cwd, 'src', 'api.ts'), 'utf8'),
    readFile(join(cwd, 'src', 'worker.ts'), 'utf8'),
    readFile(join(cwd, 'src', 'queue.ts'), 'utf8'),
  ])
  const violations: string[] = []
  if (!api.includes("from './queue.js'")) violations.push('API is not bound to the queue capability')
  if (api.includes('processJob(')) violations.push('API still invokes the worker synchronously')
  if (!worker.includes('subscribe(processEvent)')) violations.push('worker does not consume queue events')
  if (!queue.includes('queueMicrotask')) violations.push('queue does not cross an asynchronous boundary')
  return {
    name: 'architecture-invariants',
    status: violations.length === 0 ? 'passed' : 'failed',
    exitCode: violations.length === 0 ? 0 : 1,
    durationMs: Math.round(performance.now() - started),
    summary: violations.length === 0 ? 'AIR implementation bindings conform to the asynchronous design' : violations.join('; '),
    stdout: '',
    stderr: violations.join('\n'),
  }
}

async function secretGate(cwd: string): Promise<GateResult> {
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

export class DeterministicVerifier {
  constructor(private readonly projectRoot: string) {}

  private nodeArgs(args: string[]): string[] {
    return ['--require', join(this.projectRoot, 'packages', 'runtime', 'assets', 'deny-external-network.cjs'), ...args]
  }

  async verify(cwd: string, attempt: number): Promise<VerificationReport> {
    const startedAt = new Date().toISOString()
    const tsc = join(this.projectRoot, 'node_modules', 'typescript', 'bin', 'tsc')
    const gates: GateResult[] = []
    gates.push(await commandGate('build', process.execPath, this.nodeArgs([tsc, '-p', 'tsconfig.json']), cwd))
    if (gates[0]?.status === 'passed') {
      gates.push(await commandGate('unit', process.execPath, this.nodeArgs(['tests/unit.mjs']), cwd))
      gates.push(await commandGate('contract', process.execPath, this.nodeArgs(['tests/public-contract.mjs']), cwd))
      gates.push(await commandGate(
        'idempotency',
        process.execPath,
        this.nodeArgs(['tests/idempotency.mjs']),
        cwd,
        'duplicate-event-effect',
        ['src/worker.ts'],
      ))
      gates.push(await architectureGate(cwd))
    }
    gates.push(await secretGate(cwd))
    const report: VerificationReport = {
      attempt,
      status: gates.every(gate => gate.status === 'passed') ? 'passed' : 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      gates,
    }
    report.digest = createHash('sha256').update(JSON.stringify(report)).digest('hex')
    return report
  }

  async verifyBaseline(cwd: string): Promise<VerificationReport> {
    const startedAt = new Date().toISOString()
    const tsc = join(this.projectRoot, 'node_modules', 'typescript', 'bin', 'tsc')
    const gates = [
      await commandGate('build', process.execPath, this.nodeArgs([tsc, '-p', 'tsconfig.json']), cwd),
      await commandGate('unit', process.execPath, this.nodeArgs(['tests/unit.mjs']), cwd),
      await commandGate('contract', process.execPath, this.nodeArgs(['tests/public-contract.mjs']), cwd),
    ]
    const report: VerificationReport = {
      attempt: 0,
      status: gates.every(gate => gate.status === 'passed') ? 'passed' : 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      gates,
    }
    report.digest = createHash('sha256').update(JSON.stringify(report)).digest('hex')
    return report
  }
}

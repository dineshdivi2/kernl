import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  KernlLedger,
  TaskClaimAuthorityError,
  compileRepairTask,
  compileTaskDag,
  digestJson,
  parseAir,
  redactText,
  semanticDiff,
  validateAir,
  type CompiledTask,
  type CompiledTaskDag,
  type EventRecord,
  type AirDocument,
} from '@kernl/core'
import { DeterministicAgentAdapter } from './deterministic-agent.js'
import { EvidenceWriter } from './evidence.js'
import { GitWorkspaceManager } from './git-workspaces.js'
import { compileQueueProviderReplacement, runQueueProviderReplacement } from './lifecycle-demo.js'
import { findSecretMatches } from './policy.js'
import { compilePromotedWorkflow, workflowArtifactDigest } from './promotion.js'
import { runPromotedWorkflowReplay } from './workflow-replay.js'
import type { GitTaskResult, RuntimeTask, VerificationReport } from './types.js'
import { DeterministicVerifier } from './verifier.js'

export interface PreparedDemoContext {
  runId: string
  approvalId: string
  baseCommit: string
  candidateCommit: string
  verificationDigest: string
  evidenceCoreDigest: string
  artifactDir: string
  databasePath: string
}

export interface DemoResult extends PreparedDemoContext {
  status: 'AWAITING_APPROVAL' | 'PROMOTED'
  workflowDigest?: string
  evidenceManifestDigest?: string
}

interface PlanEventPayload {
  dag: CompiledTaskDag
}

const DETERMINISTIC_RUN_LIMITS = {
  maximumAgents: 4,
  maximumTasks: 12,
  maximumSteps: 20,
  maximumParallelMutations: 2,
  maximumRepairAttempts: 3,
  maximumModelRequests: 6,
  maximumModelSpendUsd: 0,
  wallTimeSeconds: 300,
} as const

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('expected object payload')
  return value as Record<string, unknown>
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new TypeError(`${label} must be a string array`)
  return value as string[]
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

function nowRunId(): string {
  return `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
}

function projectAirForUi(air: AirDocument) {
  const positions: Record<string, { x: number; y: number }> = {
    api: { x: 40, y: 80 },
    queue: { x: 310, y: 80 },
    worker: { x: 580, y: 80 },
    store: { x: 850, y: 80 },
  }
  return {
    version: air.airVersion,
    components: air.components.map(component => ({
      id: component.id,
      label: component.id,
      kind: component.kind,
      version: component.version,
      lifecycle: component.lifecycle.initialState,
      provides: component.provides.map(capability => `${capability.capability}@${capability.version}`),
      requires: component.requires.map(capability => `${capability.capability}@${capability.version}`),
      position: positions[component.id] ?? { x: 40, y: 220 },
    })),
    bindings: air.bindings.map(binding => ({
      id: binding.id,
      from: binding.consumerId,
      to: binding.providerId,
      capability: binding.capabilityId,
      providerVersion: binding.providerVersion,
    })),
  }
}

function taskKind(task: CompiledTask, repair: boolean): RuntimeTask['kind'] {
  if (repair) return 'worker-repair'
  if (task.componentIds.includes('queue')) return 'queue-contract'
  if (task.componentIds.includes('api')) return 'api-refactor'
  if (task.componentIds.includes('worker')) return 'worker-refactor'
  throw new Error(`deterministic adapter has no implementation for ${task.componentIds.join(', ')}`)
}

function runtimeTask(task: CompiledTask, attempt: number, repair = false): RuntimeTask {
  return {
    id: task.id,
    title: task.title,
    kind: taskKind(task, repair),
    dependencies: task.dependsOn,
    allowedPaths: task.writeScopes,
    architectureNodeIds: task.componentIds,
    contracts: ['jobs-api-v1', 'job-event-v1', 'result-v1'],
    acceptanceGates: ['build', 'unit', 'contract', 'idempotency', 'architecture-invariants', 'secret-scan'],
    forbiddenActions: ['modify-verification', 'weaken-tests', 'change-public-api', 'production-write'],
    attempt,
    maxAttempts: task.maxAttempts,
  }
}

function verificationCommand(projectRoot: string, gateName: VerificationReport['gates'][number]['name']): string {
  const node = JSON.stringify(process.execPath)
  const networkGuard = JSON.stringify(join(projectRoot, 'packages', 'runtime', 'assets', 'deny-external-network.cjs'))
  const guardedNode = `${node} --require ${networkGuard}`
  switch (gateName) {
    case 'build': return `${guardedNode} ${JSON.stringify(join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'))} -p tsconfig.json`
    case 'unit': return `${guardedNode} tests/unit.mjs`
    case 'contract': return `${guardedNode} tests/public-contract.mjs`
    case 'idempotency': return `${guardedNode} tests/idempotency.mjs`
    case 'architecture-invariants': return 'in-process:architectureGate(read-only source inspection)'
    case 'secret-scan': return 'in-process:secretGate(read-only source inspection)'
    default: return `in-process:${gateName}(read-only gate)`
  }
}

function verificationTranscript(projectRoot: string, reports: readonly VerificationReport[]): string {
  const lines = [
    'Kernl deterministic verification transcript',
    'policy.executable_allowlist=node,node.exe',
    'policy.network=each child Node process preloads the loopback-only deny-external-network guard; package-manager commands are not invoked',
  ]
  for (const report of reports) {
    for (const gate of report.gates) {
      lines.push(
        '',
        `[attempt=${report.attempt} gate=${gate.name}]`,
        `command=${verificationCommand(projectRoot, gate.name)}`,
        `exitCode=${gate.exitCode}`,
        `durationMs=${gate.durationMs}`,
        `status=${gate.status}`,
        `stdout=${redactText(gate.stdout).trim() || '<empty>'}`,
        `stderr=${redactText(gate.stderr).trim() || '<empty>'}`,
      )
    }
  }
  return `${lines.join('\n')}\n`
}

function eventPayload<T>(events: readonly EventRecord[], type: string): T {
  const event = [...events].reverse().find(candidate => candidate.type === type)
  if (!event) throw new Error(`missing ${type} event`)
  return event.payload as T
}

function normalizedProjectionFromExport(exported: ReturnType<KernlLedger['exportRun']>) {
  return {
    runId: exported.run.id,
    status: exported.run.status,
    airDigest: exported.run.airDigest,
    sourceCommit: exported.run.sourceCommit,
    tasks: Object.fromEntries(exported.tasks.map(task => [task.id, {
      id: task.id, kind: task.kind, status: task.status, attempt: task.attempt, maxAttempts: task.maxAttempts,
    }])),
    approvals: Object.fromEntries(exported.approvals.map(approval => [approval.id, approval.decision])),
    effects: Object.fromEntries(exported.effects.map(effect => [effect.idempotencyKey, effect])),
    bindings: Object.fromEntries(exported.bindings.map(binding => [binding.id, binding])),
    promotionDigest: exported.promotion?.workflowDigest ?? null,
  }
}

function normalizedReplay(projection: ReturnType<KernlLedger['replayRun']>) {
  return {
    runId: projection.runId,
    status: projection.status,
    airDigest: projection.airDigest,
    sourceCommit: projection.sourceCommit,
    tasks: projection.tasks,
    approvals: projection.approvals,
    effects: projection.effects,
    bindings: projection.bindings,
    promotionDigest: projection.promotion?.workflowDigest ?? null,
  }
}

export class KernlDemoCoordinator {
  readonly projectRoot: string
  readonly databasePath: string
  readonly fixtureDir: string
  readonly airDir: string

  constructor(projectRoot: string, databasePath = join(projectRoot, 'data', 'kernl.sqlite')) {
    this.projectRoot = resolve(projectRoot)
    this.databasePath = resolve(databasePath)
    this.fixtureDir = join(this.projectRoot, 'fixtures', 'job-system-template')
    this.airDir = join(this.projectRoot, 'fixtures', 'air')
  }

  private async openLedger(): Promise<KernlLedger> {
    await mkdir(join(this.projectRoot, 'data'), { recursive: true })
    return new KernlLedger(this.databasePath)
  }

  private recordGitEffects(
    ledger: KernlLedger,
    runId: string,
    task: RuntimeTask,
    agentResult: Awaited<ReturnType<DeterministicAgentAdapter['implement']>>,
    gitResult: GitTaskResult,
  ): void {
    ledger.appendEffectReceipt({
      runId,
      episodeId: `${runId}:implementation`,
      componentId: task.architectureNodeIds.join('+'),
      taskId: task.id,
      effectType: 'GIT_WORKTREE_CREATE',
      resourceIdentity: gitResult.branch,
      idempotencyKey: `${runId}:${task.id}:${task.attempt}:worktree`,
      preconditions: { baseCommit: gitResult.baseCommit, isolated: true },
      result: { branch: gitResult.branch, worktree: gitResult.worktree },
      resultingState: 'COMMITTED',
      recoveryClassification: 'REVERSIBLE',
      recoveryMetadata: { recovery: 'git worktree remove after verifying the exact task worktree' },
      provenance: { adapter: agentResult.adapter, taskId: task.id },
    })
    for (const mutation of agentResult.mutations) {
      ledger.appendEffectReceipt({
        runId,
        episodeId: `${runId}:implementation`,
        componentId: task.architectureNodeIds.join('+'),
        taskId: task.id,
        effectType: 'FILESYSTEM_WRITE',
        resourceIdentity: mutation.path,
        idempotencyKey: `${runId}:${task.id}:${task.attempt}:write:${mutation.path}`,
        preconditions: { baseCommit: gitResult.baseCommit, allowedPaths: task.allowedPaths },
        result: { taskCommit: gitResult.taskCommit, contentDigest: digestJson(mutation.content) },
        resultingState: 'COMMITTED',
        recoveryClassification: 'REVERSIBLE',
        recoveryMetadata: { inverse: `git revert ${gitResult.taskCommit}`, patchRetained: true },
        provenance: { adapter: agentResult.adapter, taskId: task.id, architectureNodeIds: task.architectureNodeIds },
      })
    }
    ledger.appendEffectReceipt({
      runId,
      episodeId: `${runId}:implementation`,
      componentId: task.architectureNodeIds.join('+'),
      taskId: task.id,
      effectType: 'GIT_INTEGRATION',
      resourceIdentity: 'integration/main',
      idempotencyKey: `${runId}:${task.id}:${task.attempt}:merge`,
      preconditions: { baseCommit: gitResult.baseCommit, taskCommit: gitResult.taskCommit },
      result: { integratedCommit: gitResult.integratedCommit, changedPaths: gitResult.changedPaths },
      resultingState: 'COMMITTED',
      recoveryClassification: 'REVERSIBLE',
      recoveryMetadata: { inverse: `git revert -m 1 ${gitResult.integratedCommit}` },
      provenance: { adapter: agentResult.adapter, taskId: task.id },
    })
  }

  async prepareDemo(): Promise<PreparedDemoContext> {
    const invalidRaw = await readJson(join(this.airDir, 'invalid-binding.json'))
    const invalidResult = validateAir(invalidRaw)
    if (invalidResult.success) throw new Error('invalid AIR fixture unexpectedly passed validation')

    const before = parseAir(await readJson(join(this.airDir, 'before.json')))
    const after = parseAir(await readJson(join(this.airDir, 'after.json')))
    const queueV2 = parseAir(await readJson(join(this.airDir, 'queue-v2.json')))
    const diff = semanticDiff(before, after)
    const dag = compileTaskDag(before, after, { maximumParallelImplementations: 2, maximumRepairAttempts: 3 })
    if (dag.tasks.length > DETERMINISTIC_RUN_LIMITS.maximumTasks) {
      throw new Error(`compiled plan exceeds maximumTasks=${DETERMINISTIC_RUN_LIMITS.maximumTasks}`)
    }
    const runStarted = performance.now()
    let stepsUsed = 0
    let modelRequestsUsed = 0
    const consumeStep = (label: string, modelRequest = false): void => {
      if (stepsUsed >= DETERMINISTIC_RUN_LIMITS.maximumSteps) {
        throw new Error(`run exceeded maximumSteps=${DETERMINISTIC_RUN_LIMITS.maximumSteps} before ${label}`)
      }
      if (modelRequest && modelRequestsUsed >= DETERMINISTIC_RUN_LIMITS.maximumModelRequests) {
        throw new Error(`run exceeded maximumModelRequests=${DETERMINISTIC_RUN_LIMITS.maximumModelRequests} before ${label}`)
      }
      if (performance.now() - runStarted > DETERMINISTIC_RUN_LIMITS.wallTimeSeconds * 1_000) {
        throw new Error(`run exceeded wallTimeSeconds=${DETERMINISTIC_RUN_LIMITS.wallTimeSeconds} before ${label}`)
      }
      stepsUsed += 1
      if (modelRequest) modelRequestsUsed += 1
    }
    const assertElapsed = (label: string): void => {
      if (performance.now() - runStarted > DETERMINISTIC_RUN_LIMITS.wallTimeSeconds * 1_000) {
        throw new Error(`run exceeded wallTimeSeconds=${DETERMINISTIC_RUN_LIMITS.wallTimeSeconds} after ${label}`)
      }
    }
    const runId = nowRunId()
    const git = new GitWorkspaceManager(this.projectRoot)
    const verifier = new DeterministicVerifier(this.projectRoot)
    const ledger = await this.openLedger()
    let runCreated = false
    try {
      const beforeStored = ledger.putAir(before)
      const afterStored = ledger.putAir(after)
      const queueV2Stored = ledger.putAir(queueV2)
      ledger.createRun({ id: runId, airDigest: afterStored.digest, sourceCommit: 'PENDING_WORKSPACE', status: 'PLANNING' })
      runCreated = true
      ledger.appendEvent(runId, 'INVALID_AIR_REJECTED_BEFORE_AGENTS', { issues: invalidResult.issues, modelRequests: 0 })
      ledger.appendEvent(runId, 'ARCHITECTURE_CHANGE_ACCEPTED', {
        before, after, beforeDigest: beforeStored.digest, afterDigest: afterStored.digest, diff,
      })
      ledger.appendEvent(runId, 'PLAN_COMPILED', { dag } satisfies PlanEventPayload)
      for (const task of dag.tasks) ledger.putTask(runId, task)
      ledger.setTaskStatus(runId, 'validate:air-change', 'SUCCEEDED')
      const repositoryEffectKey = `${runId}:workspace:create`
      ledger.appendEvent(runId, 'EFFECT_PLANNED', {
        effectType: 'RUN_REPOSITORY_CREATE',
        resourceIdentity: `run-workspace:${runId}`,
        idempotencyKey: repositoryEffectKey,
        fixtureDigest: beforeStored.digest,
      })
      consumeStep('workspace:create')
      const repository = await git.createRunRepository(runId, this.fixtureDir)
      ledger.setRunSourceCommit(runId, repository.baseCommit)
      ledger.appendEffectReceipt({
        runId,
        episodeId: `${runId}:workspace`,
        componentId: 'architecture-control-plane',
        taskId: 'validate:air-change',
        effectType: 'RUN_REPOSITORY_CREATE',
        resourceIdentity: `run-workspace:${runId}`,
        idempotencyKey: repositoryEffectKey,
        preconditions: { fixtureAirDigest: beforeStored.digest, workspaceAbsent: true },
        result: { baseCommit: repository.baseCommit, isolation: 'git-worktree' },
        resultingState: 'COMMITTED',
        recoveryClassification: 'REVERSIBLE',
        recoveryMetadata: { recovery: 'remove uniquely scoped run workspace after verifying runId' },
        provenance: { controller: 'KernlDemoCoordinator', fixture: 'job-system-template' },
      })
      const baseline = await verifier.verifyBaseline(repository.integrationDir)
      assertElapsed('baseline:verify')
      if (baseline.status !== 'passed') throw new Error(`synchronous baseline failed verification: ${JSON.stringify(baseline.gates)}`)
      ledger.setRunStatus(runId, 'RUNNING')
      ledger.appendEvent(runId, 'RUN_WORKSPACE_CREATED', {
        integrationDir: repository.integrationDir,
        baseCommit: repository.baseCommit,
        isolation: 'git-worktree',
      })

      const agent = new DeterministicAgentAdapter()
      const implementations = dag.tasks
        .filter(task => task.kind === 'IMPLEMENT')
        .sort((left, right) => {
          const order = (task: CompiledTask) => task.componentIds.includes('queue') ? 0 : task.componentIds.includes('api') ? 1 : 2
          return order(left) - order(right)
        })
      const commits: GitTaskResult[] = []
      ledger.setTaskStatus(runId, 'integrate:change', 'RUNNING')

      for (const compiled of implementations) {
        const task = runtimeTask(compiled, 1)
        consumeStep(task.id, true)
        ledger.setTaskStatus(runId, compiled.id, 'RUNNING')
        ledger.appendEvent(runId, 'MODEL_REQUEST', {
          adapter: agent.id, simulated: true, taskId: task.id, architectureNodeIds: task.architectureNodeIds,
        }, task.id)
        const result = await agent.implement(task)
        ledger.appendEvent(runId, 'TOOL_PROPOSED', {
          tool: 'authorized_write', paths: result.mutations.map(mutation => mutation.path), authority: task.allowedPaths,
        }, task.id)
        ledger.appendEvent(runId, 'AUTHORIZATION_GRANTED', {
          taskId: task.id, checks: ['path-scope', 'verification-read-only', 'no-production-write'],
        }, task.id)
        ledger.appendEvent(runId, 'EFFECT_PLANNED', {
          taskId: task.id,
          idempotencyKeys: [
            `${runId}:${task.id}:${task.attempt}:worktree`,
            ...result.mutations.map(mutation => `${runId}:${task.id}:${task.attempt}:write:${mutation.path}`),
            `${runId}:${task.id}:${task.attempt}:merge`,
          ],
          mutations: result.mutations.map(mutation => ({ path: mutation.path, digest: digestJson(mutation.content) })),
        }, task.id)
        const gitResult = await git.executeTask(repository, task, result)
        assertElapsed(task.id)
        this.recordGitEffects(ledger, runId, task, result, gitResult)
        ledger.appendEvent(runId, 'TOOL_EXECUTED', {
          tool: 'authorized_write', changedPaths: gitResult.changedPaths, taskCommit: gitResult.taskCommit,
        }, task.id)
        ledger.appendEvent(runId, 'RESULT_OBSERVED', {
          summary: result.summary, integratedCommit: gitResult.integratedCommit,
        }, task.id)
        ledger.setTaskStatus(runId, compiled.id, 'SUCCEEDED')
        commits.push(gitResult)
      }
      ledger.setTaskStatus(runId, 'integrate:change', 'SUCCEEDED')
      consumeStep('integrate:change')

      ledger.setRunStatus(runId, 'VERIFYING')
      ledger.setTaskStatus(runId, 'verify:all-gates', 'RUNNING')
      consumeStep('verify:initial-candidate')
      const firstVerification = await verifier.verify(repository.integrationDir, 1)
      assertElapsed('verify:initial-candidate')
      ledger.appendEvent(runId, 'VERIFICATION_FINISHED', firstVerification, 'verify:all-gates')
      const firstIdempotency = firstVerification.gates.find(gate => gate.name === 'idempotency')
      if (firstVerification.status !== 'failed' || firstIdempotency?.failureFingerprint !== 'duplicate-event-effect') {
        throw new Error('the first candidate did not fail on the intended duplicate-event invariant')
      }
      ledger.setTaskStatus(runId, 'verify:all-gates', 'FAILED')

      const workerCompiled = implementations.find(task => task.componentIds.includes('worker'))
      if (!workerCompiled) throw new Error('compiled plan has no worker implementation task')
      const repairCompiled = compileRepairTask(workerCompiled, 'duplicate-event-effect', 1)
      ledger.putTask(runId, repairCompiled)
      ledger.setTaskStatus(runId, repairCompiled.id, 'RUNNING')
      ledger.setRunStatus(runId, 'RUNNING')
      const repairTask = runtimeTask(repairCompiled, 1, true)
      consumeStep(repairTask.id, true)
      ledger.appendEvent(runId, 'MODEL_REQUEST', {
        adapter: agent.id, simulated: true, taskId: repairTask.id,
        structuredFailure: { fingerprint: 'duplicate-event-effect', repairScope: ['src/worker.ts'] },
      }, repairTask.id)
      const repairResult = await agent.implement(repairTask)
      ledger.appendEvent(runId, 'TOOL_PROPOSED', {
        tool: 'authorized_write', paths: repairResult.mutations.map(mutation => mutation.path), authority: repairTask.allowedPaths,
      }, repairTask.id)
      ledger.appendEvent(runId, 'AUTHORIZATION_GRANTED', {
        taskId: repairTask.id, checks: ['targeted-repair-scope', 'verification-read-only'],
      }, repairTask.id)
      ledger.appendEvent(runId, 'EFFECT_PLANNED', {
        taskId: repairTask.id,
        idempotencyKeys: [
          `${runId}:${repairTask.id}:${repairTask.attempt}:worktree`,
          ...repairResult.mutations.map(mutation => `${runId}:${repairTask.id}:${repairTask.attempt}:write:${mutation.path}`),
          `${runId}:${repairTask.id}:${repairTask.attempt}:merge`,
        ],
        mutations: repairResult.mutations.map(mutation => ({ path: mutation.path, digest: digestJson(mutation.content) })),
      }, repairTask.id)
      const repairGit = await git.executeTask(repository, repairTask, repairResult)
      assertElapsed(repairTask.id)
      this.recordGitEffects(ledger, runId, repairTask, repairResult, repairGit)
      ledger.appendEvent(runId, 'TOOL_EXECUTED', {
        tool: 'authorized_write', changedPaths: repairGit.changedPaths, taskCommit: repairGit.taskCommit,
      }, repairTask.id)
      ledger.appendEvent(runId, 'RESULT_OBSERVED', {
        summary: repairResult.summary, integratedCommit: repairGit.integratedCommit,
      }, repairTask.id)
      ledger.setTaskStatus(runId, repairCompiled.id, 'SUCCEEDED')
      commits.push(repairGit)

      ledger.setRunStatus(runId, 'VERIFYING')
      ledger.setTaskStatus(runId, 'verify:all-gates', 'RUNNING')
      consumeStep('verify:all-gates')
      const finalVerification = await verifier.verify(repository.integrationDir, 2)
      assertElapsed('verify:all-gates')
      ledger.appendEvent(runId, 'VERIFICATION_FINISHED', finalVerification, 'verify:all-gates')
      if (finalVerification.status !== 'passed' || !finalVerification.digest) {
        throw new Error(`repaired candidate failed verification: ${JSON.stringify(finalVerification.gates)}`)
      }
      ledger.setTaskStatus(runId, 'verify:all-gates', 'SUCCEEDED')

      consumeStep(`lifecycle:${queueV2.change.id}`)
      const lifecycle = runQueueProviderReplacement(ledger, runId, after, queueV2)
      if (!lifecycle.duplicateReceiptSuppressed) throw new Error('effect idempotency replay was not suppressed')
      if (lifecycle.plan.replacementAirDigest !== queueV2Stored.digest) {
        throw new Error('persisted replacement AIR digest does not match the lifecycle plan')
      }
      ledger.appendEvent(runId, 'LIFECYCLE_REPLACEMENT_COMPILED', lifecycle.plan)
      ledger.appendEvent(runId, 'RUN_BUDGET_CHECKPOINT', {
        limits: DETERMINISTIC_RUN_LIMITS,
        usage: {
          agentsUsed: 1,
          tasksCompiled: dag.tasks.length,
          stepsUsed,
          modelRequestsUsed,
          modelSpendUsd: 0,
          elapsedMs: Math.round(performance.now() - runStarted),
        },
      })

      const candidateCommit = await git.currentCommit(repository.integrationDir)
      ledger.setRunSourceCommit(runId, candidateCommit)
      ledger.setRunStatus(runId, 'AWAITING_APPROVAL')
      ledger.setTaskStatus(runId, 'approval:promotion', 'BLOCKED')

      const promotionGates = after.approvalGates.filter(gate => gate.when === 'BEFORE_PROMOTION')
      if (promotionGates.length !== 1 || !promotionGates[0]) {
        throw new Error(`AIR must declare exactly one BEFORE_PROMOTION gate; found ${promotionGates.length}`)
      }
      const promotionGate = promotionGates[0]

      const writer = new EvidenceWriter(this.projectRoot, join('artifacts', 'runs', runId))
      const evidenceCoreEffectKey = `${runId}:evidence:core`
      ledger.appendEvent(runId, 'EFFECT_PLANNED', {
        effectType: 'EVIDENCE_CORE_MATERIALIZE',
        resourceIdentity: `evidence-core:${runId}`,
        idempotencyKey: evidenceCoreEffectKey,
      })
      await writer.initialize()
      await writer.json('air-before.json', before)
      await writer.json('air-after.json', after)
      await writer.json('air-queue-v2.json', queueV2)
      await writer.json('invalid-binding-rejection.json', { accepted: false, issues: invalidResult.issues, modelRequests: 0 })
      await writer.json('air-diff.json', diff)
      await writer.json('task-dag.json', dag)
      await writer.json('baseline-verification.json', baseline)
      await writer.json('verification-attempt-1.json', firstVerification)
      await writer.json('verification-report.json', finalVerification)
      await writer.json('lifecycle-trace.json', lifecycle)
      await writer.text('change.patch', await git.diff(repository))
      await writer.json('commits.json', { baseCommit: repository.baseCommit, candidateCommit, tasks: commits })
      await writer.jsonLines('events-preapproval.jsonl', ledger.listEvents(runId))
      await writer.json('effect-ledger-preapproval.json', ledger.listEffects(runId))
      await writer.text('commands.txt', verificationTranscript(this.projectRoot, [baseline, firstVerification, finalVerification]))
      const evidenceCore = { schemaVersion: '1.0', runId, files: writer.entries() }
      const evidenceCoreDigest = digestJson(evidenceCore)
      await writer.json('evidence-core.json', { ...evidenceCore, digest: evidenceCoreDigest })
      ledger.appendEffectReceipt({
        runId,
        episodeId: `${runId}:evidence`,
        componentId: 'verification-plane',
        taskId: 'verify:all-gates',
        effectType: 'EVIDENCE_CORE_MATERIALIZE',
        resourceIdentity: `evidence-core:${runId}`,
        idempotencyKey: evidenceCoreEffectKey,
        preconditions: { verificationDigest: finalVerification.digest, candidateCommit },
        result: { evidenceCoreDigest, files: writer.entries() },
        resultingState: 'COMMITTED',
        recoveryClassification: 'REVERSIBLE',
        recoveryMetadata: { recovery: 'regenerate from the immutable run ledger and candidate commit' },
        provenance: { airDigest: afterStored.digest, evidenceVersion: 'evidence-v1' },
      })
      ledger.appendEvent(runId, 'EVIDENCE_READY', {
        evidenceVersion: 'evidence-v1', evidenceCoreDigest, artifactDir: writer.outputDir,
      })

      const approval = ledger.requestApproval({ runId, gateId: promotionGate.id })
      return {
        runId,
        approvalId: approval.id,
        baseCommit: repository.baseCommit,
        candidateCommit,
        verificationDigest: finalVerification.digest,
        evidenceCoreDigest,
        artifactDir: writer.outputDir,
        databasePath: this.databasePath,
      }
    } catch (error) {
      if (runCreated) {
        try { ledger.setRunStatus(runId, 'FAILED') } catch { /* retain original failure */ }
      }
      throw error
    } finally {
      ledger.close()
    }
  }

  async approveAndPromote(runId: string, actor: string, actorRole: string): Promise<DemoResult> {
    if (!actor.trim()) throw new Error('approval actor is required')
    const ledger = await this.openLedger()
    try {
      const run = ledger.getRun(runId)
      if (run.status !== 'AWAITING_APPROVAL') throw new Error(`run ${runId} is ${run.status}, not awaiting approval`)
      const events = ledger.listEvents(runId)
      const { dag } = eventPayload<PlanEventPayload>(events, 'PLAN_COMPILED')
      const architecture = asRecord(eventPayload(events, 'ARCHITECTURE_CHANGE_ACCEPTED'))
      const after = parseAir(architecture.after)
      const promotionGates = after.approvalGates.filter(gate => gate.when === 'BEFORE_PROMOTION')
      if (promotionGates.length !== 1 || !promotionGates[0]) {
        throw new Error(`AIR must declare exactly one BEFORE_PROMOTION gate; found ${promotionGates.length}`)
      }
      const promotionGate = promotionGates[0]
      const verification = eventPayload<VerificationReport>(events, 'VERIFICATION_FINISHED')
      if (verification.status !== 'passed' || !verification.digest) throw new Error('promotion requires a passing verification digest')
      const evidence = asRecord(eventPayload(events, 'EVIDENCE_READY'))
      const evidenceCoreDigest = String(evidence.evidenceCoreDigest)
      const queueV2 = parseAir(await readJson(join(this.airDir, 'queue-v2.json')))
      const lifecycleReplacement = compileQueueProviderReplacement(after, queueV2)
      const approval = ledger.listApprovals(runId).find(item => item.decision === 'PENDING')
      if (!approval) throw new Error('no pending architect approval exists')
      if (approval.gateId !== promotionGate.id) {
        throw new Error(`pending approval gate ${approval.gateId} does not match AIR gate ${promotionGate.id}`)
      }
      if (actorRole !== promotionGate.requiredRole) {
        throw new Error(`actor role ${actorRole} cannot satisfy required role ${promotionGate.requiredRole}`)
      }
      ledger.appendEvent(runId, 'APPROVAL_AUTHORIZATION_GRANTED', {
        approvalId: approval.id,
        gateId: promotionGate.id,
        requiredRole: promotionGate.requiredRole,
        actor: actor.trim(),
        actorRole,
        authorized: true,
      }, 'approval:promotion')
      const decided = ledger.decideApproval({
        runId,
        approvalId: approval.id,
        decision: 'APPROVED',
        actor: actor.trim(),
        evidenceDigest: evidenceCoreDigest,
      })
      ledger.setTaskStatus(runId, 'approval:promotion', 'SUCCEEDED')
      ledger.setTaskStatus(runId, 'promote:workflow', 'RUNNING')

      const workflow = compilePromotedWorkflow({
        runId,
        dag,
        candidateCommit: run.sourceCommit,
        verificationDigest: verification.digest,
        evidenceVersion: 'evidence-v1',
        evidenceCoreDigest,
        approval: {
          actor: decided.actor ?? actor.trim(),
          decision: 'approved',
          createdAt: decided.decidedAt ?? decided.requestedAt,
        },
        model: { adapter: 'deterministic-v1' },
        lifecycleReplacement: {
          changeId: lifecycleReplacement.changeId,
          componentId: lifecycleReplacement.componentId,
          currentAirVersion: lifecycleReplacement.currentAirVersion,
          currentAirDigest: lifecycleReplacement.currentAirDigest,
          replacementAirVersion: lifecycleReplacement.replacementAirVersion,
          replacementAirDigest: lifecycleReplacement.replacementAirDigest,
        },
      })
      const promotion = ledger.recordPromotion({
        runId,
        airDigest: run.airDigest,
        sourceCommit: run.sourceCommit,
        verificationDigest: verification.digest,
        evidenceDigest: evidenceCoreDigest,
        workflow,
      })
      const exactWorkflowDigest = workflowArtifactDigest(workflow)
      if (promotion.workflowDigest !== exactWorkflowDigest) {
        throw new Error('promotion ledger did not bind the exact workflow artifact')
      }
      const declaredPromotionEffects = after.effects.filter(effect => effect.effectType === 'workflow.promote')
      if (declaredPromotionEffects.length !== 1 || !declaredPromotionEffects[0]) {
        throw new Error(`AIR must declare exactly one workflow.promote effect; found ${declaredPromotionEffects.length}`)
      }
      const declaredPromotionEffect = declaredPromotionEffects[0]
      if (declaredPromotionEffect.recovery !== 'APPROVAL_GATED' || declaredPromotionEffect.approvalGateId !== promotionGate.id) {
        throw new Error('AIR workflow promotion effect is not bound to the approved promotion gate')
      }
      ledger.appendEffectReceipt({
        runId,
        episodeId: `${runId}:promotion`,
        componentId: declaredPromotionEffect.componentId,
        taskId: 'promote:workflow',
        effectType: 'WORKFLOW_PROMOTION',
        resourceIdentity: declaredPromotionEffect.resource,
        idempotencyKey: `${runId}:promote:workflow:${promotion.workflowDigest}`,
        preconditions: {
          airDigest: run.airDigest,
          sourceCommit: run.sourceCommit,
          verificationDigest: verification.digest,
          evidenceCoreDigest,
          approvalId: decided.id,
          approvalGateId: promotionGate.id,
        },
        result: {
          promotionId: promotion.id,
          workflowContentDigest: workflow.contentDigest,
          workflowDigest: promotion.workflowDigest,
        },
        resultingState: 'PROMOTED',
        recoveryClassification: 'APPROVAL_GATED',
        recoveryMetadata: { approvalId: decided.id, decision: decided.decision, actor: decided.actor },
        provenance: {
          airEffectId: declaredPromotionEffect.id,
          airVersion: after.airVersion,
          approvalGateId: promotionGate.id,
          requiredRole: promotionGate.requiredRole,
        },
      })
      ledger.setTaskStatus(runId, 'promote:workflow', 'SUCCEEDED')
      ledger.appendEvent(runId, 'FINALIZED', {
        outcome: 'PROMOTED',
        workflowContentDigest: workflow.contentDigest,
        workflowDigest: promotion.workflowDigest,
        candidateCommit: run.sourceCommit,
      })

      const artifactDir = String(evidence.artifactDir)
      const writer = new EvidenceWriter(this.projectRoot, artifactDir)
      const evidenceFinalizeEffectKey = `${runId}:evidence:finalize`
      ledger.appendEvent(runId, 'EFFECT_PLANNED', {
        effectType: 'EVIDENCE_PACK_FINALIZE',
        resourceIdentity: `evidence-pack:${runId}`,
        idempotencyKey: evidenceFinalizeEffectKey,
      }, 'promote:workflow')
      await writer.indexExisting()
      await writer.json('approval.json', decided)
      await writer.json('promoted-workflow.json', workflow)
      await writer.json('promotion.json', promotion)
      const workflowReplay = await runPromotedWorkflowReplay({
        projectRoot: this.projectRoot,
        workflowArtifactPath: join(writer.outputDir, 'promoted-workflow.json'),
        promotionArtifactPath: join(writer.outputDir, 'promotion.json'),
        beforeAirPath: join(this.airDir, 'before.json'),
        afterAirPath: join(this.airDir, 'after.json'),
        replacementAirPath: join(this.airDir, 'queue-v2.json'),
        fixtureDir: this.fixtureDir,
        outputDir: writer.outputDir,
        replayRunId: `${runId}-promoted-workflow`,
        reportFileName: 'workflow-replay-report.json',
        patchFileName: 'workflow-replay.patch',
        manifestFileName: 'workflow-replay-evidence.json',
      })
      ledger.appendEvent(runId, 'PROMOTED_WORKFLOW_REPLAYED', {
        workflowContentDigest: workflowReplay.workflow.contentDigest,
        workflowDigest: workflowReplay.workflow.artifactDigest,
        reportDigest: workflowReplay.reportDigest,
        status: workflowReplay.status,
        initialFailureFingerprint: workflowReplay.verification.initialFailureFingerprint,
        repairScope: workflowReplay.repair.changedPaths,
        finalStatus: workflowReplay.verification.finalStatus,
      }, 'promote:workflow')
      await writer.indexExisting()

      const exported = ledger.exportRun(runId)
      const replay = ledger.replayRun(runId)
      const directDigest = digestJson(normalizedProjectionFromExport(exported))
      const replayDigest = digestJson(normalizedReplay(replay))
      const effectEvents = exported.events.filter(event => event.type === 'EFFECT_COMMITTED')
      const committedEffectKeys = effectEvents.map(event => String(asRecord(event.payload).idempotencyKey))
      const replayReport = {
        runId,
        status: replay.status,
        ledgerSnapshotPhase: 'BEFORE_EVIDENCE_FINALIZATION_AND_CANONICAL_PUBLICATION',
        directDigest,
        replayDigest,
        stateEquivalent: directDigest === replayDigest,
        eventCount: exported.events.length,
        effectsReexecuted: exported.events.filter(event => event.type === 'EFFECT_REEXECUTED').length,
        effectCount: exported.effects.length,
        duplicateEffects: committedEffectKeys.length - new Set(committedEffectKeys).size,
        idempotencyKeysUnique: new Set(committedEffectKeys).size === committedEffectKeys.length,
      }
      if (!replayReport.stateEquivalent || !replayReport.idempotencyKeysUnique) {
        throw new Error(`replay invariant failed: ${JSON.stringify(replayReport)}`)
      }

      await writer.jsonLines('events.jsonl', ledger.listEvents(runId))
      await writer.json('effect-ledger.json', ledger.listEffects(runId))
      await writer.json('ledger-export.json', exported)
      await writer.json('replay-report.json', replayReport)

      const texts = await Promise.all(writer.entries().map(async entry => ({
        path: entry.path,
        text: await readFile(join(writer.outputDir, entry.path), 'utf8'),
      })))
      const databaseText = (await readFile(this.databasePath)).toString('utf8')
      const secretMatches = [
        ...texts.flatMap(file => findSecretMatches(file.text).map(match => `${file.path}:${match}`)),
        ...findSecretMatches(databaseText).map(match => `data/kernl.sqlite:${match}`),
      ]
      const secretScan = { status: secretMatches.length === 0 ? 'passed' : 'failed', scannedFiles: texts.length + 1, matches: secretMatches }
      await writer.json('secret-scan-report.json', secretScan)
      if (secretMatches.length > 0) throw new Error(`secret scan failed: ${secretMatches.join(', ')}`)

      await writer.indexExisting()
      const manifestResult = await writer.manifest({
        runId,
        airDigest: run.airDigest,
        candidateCommit: run.sourceCommit,
        verificationDigest: verification.digest,
        workflowContentDigest: workflow.contentDigest,
        workflowDigest: promotion.workflowDigest,
        evidenceCoreDigest,
        ledgerSnapshotPhase: 'BEFORE_EVIDENCE_FINALIZATION_AND_CANONICAL_PUBLICATION',
        authoritativeLedger: 'data/kernl.sqlite',
      })
      await writer.verifyFiles()
      ledger.appendEffectReceipt({
        runId,
        episodeId: `${runId}:evidence`,
        componentId: 'verification-plane',
        taskId: 'promote:workflow',
        effectType: 'EVIDENCE_PACK_FINALIZE',
        resourceIdentity: `evidence-pack:${runId}`,
        idempotencyKey: evidenceFinalizeEffectKey,
        preconditions: {
          evidenceCoreDigest,
          workflowDigest: promotion.workflowDigest,
          verificationDigest: verification.digest,
        },
        result: { manifestDigest: manifestResult.digest, files: writer.entries() },
        resultingState: 'COMMITTED',
        recoveryClassification: 'REVERSIBLE',
        recoveryMetadata: { recovery: 'regenerate from the durable ledger and promoted workflow' },
        provenance: { airDigest: run.airDigest, sourceCommit: run.sourceCommit },
      })
      const canonicalArtifactDir = join(this.projectRoot, 'artifacts', 'demo-run')
      const canonicalPublishEffectKey = `${runId}:evidence:publish-canonical`
      ledger.appendEvent(runId, 'EFFECT_PLANNED', {
        effectType: 'EVIDENCE_CANONICAL_PUBLISH',
        resourceIdentity: 'artifacts/demo-run',
        idempotencyKey: canonicalPublishEffectKey,
      }, 'promote:workflow')
      await rm(canonicalArtifactDir, { recursive: true, force: true })
      await cp(writer.outputDir, canonicalArtifactDir, { recursive: true, force: true })
      ledger.appendEffectReceipt({
        runId,
        episodeId: `${runId}:evidence`,
        componentId: 'verification-plane',
        taskId: 'promote:workflow',
        effectType: 'EVIDENCE_CANONICAL_PUBLISH',
        resourceIdentity: 'artifacts/demo-run',
        idempotencyKey: canonicalPublishEffectKey,
        preconditions: { sourceEvidencePack: `artifacts/runs/${runId}`, manifestDigest: manifestResult.digest },
        result: { published: true, manifestDigest: manifestResult.digest },
        resultingState: 'COMMITTED',
        recoveryClassification: 'REVERSIBLE',
        recoveryMetadata: { recovery: `republish from artifacts/runs/${runId}` },
        provenance: { runId, approvalId: approval.id },
      })
      return {
        runId,
        approvalId: approval.id,
        baseCommit: String(asRecord(eventPayload(events, 'RUN_WORKSPACE_CREATED')).baseCommit),
        candidateCommit: run.sourceCommit,
        verificationDigest: verification.digest,
        evidenceCoreDigest,
        artifactDir: canonicalArtifactDir,
        databasePath: this.databasePath,
        status: 'PROMOTED',
        workflowDigest: promotion.workflowDigest,
        evidenceManifestDigest: manifestResult.digest,
      }
    } finally {
      ledger.close()
    }
  }

  async runDemo(approvalActor?: string, approvalRole?: string): Promise<DemoResult> {
    const prepared = await this.prepareDemo()
    if (!approvalActor) return { ...prepared, status: 'AWAITING_APPROVAL' }
    if (!approvalRole) throw new Error('approval role is required when an approval actor is provided')
    return this.approveAndPromote(prepared.runId, approvalActor, approvalRole)
  }

  async replay(runId?: string): Promise<Record<string, unknown>> {
    const ledger = await this.openLedger()
    try {
      const selected = runId ?? this.latestRunId(ledger)
      if (!selected) return { status: 'idle', message: 'No Kernl run exists yet.' }
      const projection = ledger.replayRun(selected)
      const before = digestJson(projection)
      ledger.close()
      const reopened = await this.openLedger()
      try {
        const afterProjection = reopened.replayRun(selected)
        const after = digestJson(afterProjection)
        const replayedEvents = reopened.listEvents(selected)
        const effectEvents = replayedEvents.filter(event => event.type === 'EFFECT_COMMITTED')
        const effectKeys = effectEvents.map(event => String(asRecord(event.payload).idempotencyKey))
        const duplicateEffects = effectKeys.length - new Set(effectKeys).size
        const effectsReexecuted = replayedEvents.filter(event => event.type === 'EFFECT_REEXECUTED').length
        return {
          status: afterProjection.status,
          runId: selected,
          stateDigest: after,
          stableAcrossRestart: before === after,
          eventCount: replayedEvents.length,
          effectCount: effectKeys.length,
          duplicateEffects,
          effectsReexecuted,
          projection: afterProjection,
        }
      } finally {
        reopened.close()
      }
    } finally {
      try { ledger.close() } catch { /* closed during restart check */ }
    }
  }

  private latestRunId(ledger: KernlLedger): string | undefined {
    const row = ledger.database.prepare('SELECT id FROM runs ORDER BY created_at DESC LIMIT 1').get() as { id?: string } | undefined
    return row?.id
  }

  async state(runId?: string): Promise<Record<string, unknown>> {
    const ledger = await this.openLedger()
    try {
      const selected = runId ?? this.latestRunId(ledger)
      if (!selected) {
        return {
          system: { name: 'Kernl', mode: 'deterministic', status: 'idle' },
          architecture: {}, tasks: [], events: [], effects: [], lifecycle: [], bindings: [],
          verification: { attempts: 0, latestGates: [], history: [] }, approval: null, promotion: null, evidence: null,
        }
      }
      const exported = ledger.exportRun(selected)
      const events = exported.events
      const architecture = asRecord(eventPayload(events, 'ARCHITECTURE_CHANGE_ACCEPTED'))
      const verificationHistory = events.filter(event => event.type === 'VERIFICATION_FINISHED').map(event => event.payload as VerificationReport)
      const lifecycleTrace = events.filter(event => event.type === 'LIFECYCLE_STATE_CHANGED').map(event => event.payload)
      const latestLifecycle = lifecycleTrace.at(-1) as { snapshot?: { providers?: Record<string, unknown> } } | undefined
      const latestApproval = exported.approvals.at(-1) ?? null
      const promotion = exported.promotion ?? null
      const evidenceReadyEvent = [...events].reverse().find(event => event.type === 'EVIDENCE_READY')
      const evidenceReady = evidenceReadyEvent ? asRecord(evidenceReadyEvent.payload) : null
      const persistedArtifactDir = evidenceReady && typeof evidenceReady.artifactDir === 'string'
        ? evidenceReady.artifactDir
        : join(this.projectRoot, 'artifacts', 'runs', selected)
      let finalManifestDigest: string | null = null
      try {
        finalManifestDigest = digestJson(await readJson(join(persistedArtifactDir, 'evidence-manifest.json')))
      } catch {
        // A pre-approval run intentionally has no final evidence manifest yet.
      }
      const workflowArtifactPath = join(persistedArtifactDir, 'promoted-workflow.json')
      return {
        system: { name: 'Kernl', mode: 'deterministic', runId: selected, status: exported.run.status },
        architecture: {
          before: projectAirForUi(parseAir(architecture.before)),
          after: projectAirForUi(parseAir(architecture.after)),
          diff: {
            changedNodeIds: (architecture.diff as { directlyAffectedComponentIds?: string[] } | undefined)?.directlyAffectedComponentIds ?? [],
            changedEdgeIds: [],
            summary: 'Convert synchronous API-to-worker execution into a versioned queued worker.',
          },
        },
        tasks: exported.tasks,
        events,
        effects: exported.effects,
        lifecycle: Object.values(latestLifecycle?.snapshot?.providers ?? {}).map(value => {
          const provider = value as Record<string, unknown>
          return {
            ...provider,
            providerId: provider.id,
            acceptsNewBindings: provider.acceptingNewBindings,
          }
        }),
        lifecycleTrace,
        bindings: exported.bindings,
        verification: {
          attempts: verificationHistory.length,
          latestGates: verificationHistory.at(-1)?.gates ?? [],
          history: verificationHistory,
        },
        approval: latestApproval,
        promotion: promotion ? {
          ...promotion,
          candidateCommit: promotion.sourceCommit,
          verificationDigest: promotion.verificationDigest,
          workflowVersion: (promotion.workflow as { workflowVersion?: string }).workflowVersion,
          workflowArtifactPath,
        } : null,
        evidence: {
          artifactDir: persistedArtifactDir,
          canonicalArtifactDir: join(this.projectRoot, 'artifacts', 'demo-run'),
          coreDigest: evidenceReady ? String(evidenceReady.evidenceCoreDigest) : null,
          manifestDigest: finalManifestDigest,
          manifestDigestPersistedInLedger: false,
        },
      }
    } finally {
      ledger.close()
    }
  }

  async validateChange(input: unknown) {
    const result = validateAir(input)
    return result.success ? { valid: true, digest: result.digest, airVersion: result.data.airVersion } : { valid: false, issues: result.issues }
  }

  async compilePlan(input: unknown) {
    const request = asRecord(input)
    const before = parseAir(request.before)
    const after = parseAir(request.after)
    return compileTaskDag(before, after, { maximumParallelImplementations: 2, maximumRepairAttempts: 3 })
  }

  async dshClaimTask(input: unknown) {
    const request = asRecord(input)
    const runId = String(request.runId ?? '')
    const taskId = String(request.taskId ?? '')
    const workerId = String(request.workerId ?? '')
    if (!runId || !taskId || !workerId) throw new Error('runId, taskId, and workerId are required')
    const capabilities = asStringArray(request.capabilities, 'capabilities')
    const writeScopes = asStringArray(request.writeScopes, 'writeScopes')
    const ledger = await this.openLedger()
    try {
      return ledger.claimTask({ runId, taskId, workerId, capabilities, writeScopes })
    } finally {
      ledger.close()
    }
  }

  async dshRecordResult(input: unknown) {
    const request = asRecord(input)
    const runId = String(request.runId ?? '')
    const taskId = String(request.taskId ?? '')
    const workerId = String(request.workerId ?? '')
    if (!runId || !taskId || !workerId) throw new Error('runId, taskId, and workerId are required')
    const result = asRecord(request.result)
    const reportedStatus = String(result.status ?? 'completed').toLowerCase()
    const ledger = await this.openLedger()
    try {
      const task = ledger.getTask(runId, taskId)
      if (task.status !== 'CLAIMED' && task.status !== 'RUNNING') {
        throw new Error(`task ${taskId} is ${task.status}, not claimed or running`)
      }
      if (task.claimedBy !== workerId) {
        throw new TaskClaimAuthorityError(`worker ${workerId} cannot record a result for task ${taskId} claimed by ${task.claimedBy ?? '<unclaimed>'}`, {
          taskId,
          workerId,
          claimedBy: task.claimedBy ?? null,
        })
      }
      const status = reportedStatus === 'completed' || reportedStatus === 'succeeded' ? 'SUCCEEDED' : 'FAILED'
      ledger.appendEvent(runId, 'DSH_AGENT_RESULT_RECORDED', {
        taskId, workerId, result, verified: false, note: 'Agent completion never substitutes for deterministic verification.',
      }, taskId)
      return { task: ledger.setTaskStatus(runId, taskId, status), verified: false }
    } finally {
      ledger.close()
    }
  }

  async dshVerification(input: unknown) {
    const request = asRecord(input)
    const runId = String(request.runId ?? '')
    if (!runId) throw new Error('runId is required')
    const ledger = await this.openLedger()
    try {
      const report = ledger.listEvents(runId, { type: 'VERIFICATION_FINISHED' }).at(-1)?.payload
      return report ? { authoritative: true, report } : { authoritative: true, status: 'not-run' }
    } finally {
      ledger.close()
    }
  }
}

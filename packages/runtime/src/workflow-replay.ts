import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  canonicalJson,
  compileRepairTask,
  compileTaskDag,
  digestJson,
  KernlLedger,
  parseAir,
  sha256Hex,
  type CompiledTask,
  type EffectReceipt,
  type LifecycleSnapshot,
} from '@kernl/core'
import { DeterministicAgentAdapter } from './deterministic-agent.js'
import { GitWorkspaceManager, type RunRepository } from './git-workspaces.js'
import {
  workflowArtifactDigest,
  workflowContentDigest,
  workflowStepsFromDag,
  type PromotedWorkflow,
} from './promotion.js'
import type { GitTaskResult, RuntimeTask, VerificationReport } from './types.js'
import { DeterministicVerifier } from './verifier.js'
import { runQueueProviderReplacement, type LifecycleTraceEntry } from './lifecycle-demo.js'

export interface WorkflowReplayOptions {
  projectRoot: string
  workflowArtifactPath: string
  promotionArtifactPath: string
  beforeAirPath: string
  afterAirPath: string
  replacementAirPath: string
  fixtureDir: string
  outputDir?: string
  replayRunId?: string
  reportFileName?: string
  patchFileName?: string
  manifestFileName?: string
}

export interface WorkflowStepExecution {
  id: string
  kind: string
  status: 'SUCCEEDED'
  resolution: 'EXECUTED' | 'VERIFIED' | 'SATISFIED_BY_PROMOTION'
  attempts: number
  toolBinding: string
  worktree?: string
  changedPaths?: string[]
  taskCommit?: string
  integratedCommit?: string
  durationMs?: number
}

export interface WorkflowReplayEffectReceipt {
  taskId: string
  effectType: 'RUN_REPOSITORY_CREATE' | 'GIT_WORKTREE_CREATE' | 'FILESYSTEM_WRITE' | 'GIT_INTEGRATION' | 'ARTIFACT_WRITE'
  resourceIdentity: string
  idempotencyKey: string
  recoveryClassification: 'REVERSIBLE'
  result: Record<string, unknown>
}

export interface WorkflowReplayReport {
  schemaVersion: '1.0'
  mode: 'deterministic-mock-agent'
  status: 'passed'
  replayRunId: string
  workflow: {
    artifactPath: string
    sourceRunId: string
    workflowVersion: string
    contentDigest: string
    computedContentDigest: string
    artifactDigest: string
    promotedWorkflowDigest: string
    contentVerified: true
    promotionEnvelopeVerified: true
  }
  inputs: {
    beforeAirPath: string
    afterAirPath: string
    replacementAirPath: string
    fixtureDir: string
    fromAirDigest: string
    toAirDigest: string
    replacementAirDigest: string
    dagDigest: string
    inputsVerified: true
  }
  source: {
    baseCommit: string
    candidateCommit: string
    patchPath: string
    isolatedWorktrees: string[]
  }
  steps: WorkflowStepExecution[]
  verification: {
    baseline: VerificationReport
    attempts: VerificationReport[]
    intendedFailureObserved: true
    initialFailureFingerprint: string
    finalStatus: 'passed'
  }
  repair: {
    attemptsUsed: number
    maximumAttempts: number
    sourceStepId: string
    expectedScope: string[]
    changedPaths: string[]
    taskCommit: string
  }
  lifecycle: {
    stepId: string
    currentAirVersion: string
    currentAirDigest: string
    replacementAirVersion: string
    replacementAirDigest: string
    trace: LifecycleTraceEntry[]
    finalSnapshot: LifecycleSnapshot
    receipts: EffectReceipt[]
    duplicateReceiptSuppressed: true
    assertions: {
      currentProviderInactive: true
      currentProviderRelianceZero: true
      replacementProviderActive: true
      replacementBindingsCommitted: true
    }
  }
  effects: WorkflowReplayEffectReceipt[]
  limits: {
    tasksDeclared: number
    stepsExecuted: number
    modelRequests: number
    modelSpendUsd: 0
    maximumTasks: number
    maximumSteps: number
    maximumModelRequests: number
    maximumModelSpendUsd: number
  }
  assertions: {
    noConversationContextUsed: true
    exactStaticStepsMatchedAirDag: true
    allMutationsIsolated: true
    repairStayedInDeclaredScope: true
    publicContractPassed: true
    duplicateDeliveryPassedAfterRepair: true
    limitsRespected: true
  }
  elapsedMs: number
  reportDigest: string
  reportPath: string
  evidenceManifestPath: string
}

interface PromotionEnvelope {
  airDigest: string
  sourceCommit: string
  verificationDigest: string
  evidenceDigest: string
  workflowDigest: string
  workflow: unknown
}

type JsonRecord = Record<string, unknown>

function objectValue(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value as JsonRecord
}

function stringValue(record: JsonRecord, key: string, label: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label}.${key} must be a non-empty string`)
  return value
}

function booleanValue(record: JsonRecord, key: string, label: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') throw new TypeError(`${label}.${key} must be a boolean`)
  return value
}

function numberValue(record: JsonRecord, key: string, label: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label}.${key} must be a finite number`)
  return value
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new TypeError(`${label} must be a string array`)
  return value as string[]
}

function parsePromotedWorkflow(value: unknown): PromotedWorkflow {
  const workflow = objectValue(value, 'workflow')
  if (stringValue(workflow, 'schemaVersion', 'workflow') !== '1.0') throw new Error('unsupported promoted workflow schema')
  if (stringValue(workflow, 'name', 'workflow') !== 'sync-to-queued-worker') throw new Error('unsupported promoted workflow name')
  stringValue(workflow, 'workflowVersion', 'workflow')
  const contentDigest = stringValue(workflow, 'contentDigest', 'workflow')
  if (!/^[a-f0-9]{64}$/.test(contentDigest)) throw new Error('workflow.contentDigest is not a sha256 digest')

  const limits = objectValue(workflow.limits, 'workflow.limits')
  const maximumAgents = numberValue(limits, 'maximumAgents', 'workflow.limits')
  const maximumParallelMutations = numberValue(limits, 'maximumParallelMutations', 'workflow.limits')
  const maximumRepairAttempts = numberValue(limits, 'maximumRepairAttempts', 'workflow.limits')
  const maximumTasks = numberValue(limits, 'maximumTasks', 'workflow.limits')
  const maximumSteps = numberValue(limits, 'maximumSteps', 'workflow.limits')
  const maximumModelRequests = numberValue(limits, 'maximumModelRequests', 'workflow.limits')
  const maximumModelSpendUsd = numberValue(limits, 'maximumModelSpendUsd', 'workflow.limits')
  const wallTimeSeconds = numberValue(limits, 'wallTimeSeconds', 'workflow.limits')
  if (![maximumAgents, maximumParallelMutations, maximumRepairAttempts, maximumTasks, maximumSteps, maximumModelRequests, wallTimeSeconds].every(Number.isInteger)) {
    throw new Error('workflow limits must be integers')
  }
  if (maximumAgents < 1 || maximumAgents > 4) throw new Error('workflow maximumAgents exceeds the trusted bound')
  if (maximumParallelMutations < 1 || maximumParallelMutations > 2) throw new Error('workflow maximumParallelMutations exceeds the trusted bound')
  if (maximumRepairAttempts < 1 || maximumRepairAttempts > 3) throw new Error('workflow maximumRepairAttempts exceeds the trusted bound')
  if (maximumTasks < 1 || maximumTasks > 12) throw new Error('workflow maximumTasks exceeds the trusted bound')
  if (maximumSteps < 1 || maximumSteps > 20) throw new Error('workflow maximumSteps exceeds the trusted bound')
  if (maximumModelRequests < 0 || maximumModelRequests > 6) throw new Error('workflow maximumModelRequests exceeds the trusted bound')
  if (maximumModelSpendUsd !== 0) throw new Error('deterministic replay requires maximumModelSpendUsd to equal zero')
  if (wallTimeSeconds < 1 || wallTimeSeconds > 300) throw new Error('workflow wallTimeSeconds exceeds the trusted bound')

  const policies = objectValue(workflow.policies, 'workflow.policies')
  for (const key of ['isolatedMutations', 'testsReadOnlyToBuilders', 'promotionRequiresApproval', 'effectsRequireReceipts']) {
    if (!booleanValue(policies, key, 'workflow.policies')) throw new Error(`trusted workflow policy ${key} must be enabled`)
  }

  const evaluation = objectValue(workflow.evaluationBaseline, 'workflow.evaluationBaseline')
  if (stringValue(evaluation, 'expectedInitialFailure', 'workflow.evaluationBaseline') !== 'duplicate-event-effect') {
    throw new Error('unsupported workflow failure baseline')
  }
  stringValue(evaluation, 'expectedRepairStepId', 'workflow.evaluationBaseline')
  stringArray(evaluation.expectedRepairScope, 'workflow.evaluationBaseline.expectedRepairScope')
  if (stringValue(evaluation, 'expectedFinalStatus', 'workflow.evaluationBaseline') !== 'passed') {
    throw new Error('workflow must require a passing final status')
  }

  const provenance = objectValue(workflow.provenance, 'workflow.provenance')
  for (const key of [
    'runId', 'changeId', 'fromAirDigest', 'toAirDigest', 'dagDigest', 'candidateCommit',
    'verificationDigest', 'evidenceVersion', 'evidenceCoreDigest',
  ]) stringValue(provenance, key, 'workflow.provenance')
  const approval = objectValue(provenance.approval, 'workflow.provenance.approval')
  if (stringValue(approval, 'decision', 'workflow.provenance.approval') !== 'approved') {
    throw new Error('promoted workflow has no approved provenance')
  }
  stringValue(approval, 'actor', 'workflow.provenance.approval')
  stringValue(approval, 'createdAt', 'workflow.provenance.approval')
  const agent = objectValue(provenance.agent, 'workflow.provenance.agent')
  if (stringValue(agent, 'adapter', 'workflow.provenance.agent') !== 'deterministic-v1') {
    throw new Error('static replay only accepts the deterministic-v1 adapter')
  }
  const lifecycleReplacement = objectValue(provenance.lifecycleReplacement, 'workflow.provenance.lifecycleReplacement')
  for (const key of [
    'changeId', 'componentId', 'currentAirVersion', 'currentAirDigest', 'replacementAirVersion', 'replacementAirDigest',
  ]) stringValue(lifecycleReplacement, key, 'workflow.provenance.lifecycleReplacement')

  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) throw new TypeError('workflow.steps must be non-empty')
  const stepIds = new Set<string>()
  for (const [index, rawStep] of workflow.steps.entries()) {
    const step = objectValue(rawStep, `workflow.steps[${index}]`)
    const id = stringValue(step, 'id', `workflow.steps[${index}]`)
    if (stepIds.has(id)) throw new Error(`duplicate workflow step id ${id}`)
    stepIds.add(id)
    stringValue(step, 'kind', `workflow.steps[${index}]`)
    stringValue(step, 'toolBinding', `workflow.steps[${index}]`)
    stringArray(step.componentIds, `workflow.steps[${index}].componentIds`)
    stringArray(step.dependencies, `workflow.steps[${index}].dependencies`)
    stringArray(step.writeScopes, `workflow.steps[${index}].writeScopes`)
    numberValue(step, 'retries', `workflow.steps[${index}]`)
    const timeoutSeconds = numberValue(step, 'timeoutSeconds', `workflow.steps[${index}]`)
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 60) {
      throw new Error(`workflow.steps[${index}].timeoutSeconds exceeds the trusted bound`)
    }
    booleanValue(step, 'requiresApproval', `workflow.steps[${index}]`)
    if (step.condition !== undefined) {
      const condition = objectValue(step.condition, `workflow.steps[${index}].condition`)
      stringValue(condition, 'gateFailureFingerprint', `workflow.steps[${index}].condition`)
    }
  }
  if (workflow.steps.length > maximumTasks) throw new Error('workflow declares more tasks than maximumTasks')
  if (workflow.steps.length > maximumSteps) throw new Error('workflow declares more steps than maximumSteps')

  return workflow as unknown as PromotedWorkflow
}

function parsePromotionEnvelope(value: unknown): PromotionEnvelope {
  const promotion = objectValue(value, 'promotion')
  return {
    airDigest: stringValue(promotion, 'airDigest', 'promotion'),
    sourceCommit: stringValue(promotion, 'sourceCommit', 'promotion'),
    verificationDigest: stringValue(promotion, 'verificationDigest', 'promotion'),
    evidenceDigest: stringValue(promotion, 'evidenceDigest', 'promotion'),
    workflowDigest: stringValue(promotion, 'workflowDigest', 'promotion'),
    workflow: promotion.workflow,
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

function taskKind(task: CompiledTask): RuntimeTask['kind'] {
  if (task.componentIds.length !== 1) throw new Error(`static adapter requires one component per implementation task: ${task.id}`)
  switch (task.componentIds[0]) {
    case 'api': return 'api-refactor'
    case 'queue': return 'queue-contract'
    case 'worker': return 'worker-refactor'
    default: throw new Error(`static adapter has no implementation binding for ${task.componentIds[0]}`)
  }
}

function runtimeTask(task: CompiledTask, attempt: number): RuntimeTask {
  return {
    id: task.id,
    title: task.title,
    kind: taskKind(task),
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

function repairRuntimeTask(task: CompiledTask, attempt: number): RuntimeTask {
  return {
    id: task.id,
    title: task.title,
    kind: 'worker-repair',
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

function executionForTask(
  step: PromotedWorkflow['steps'][number],
  git: GitTaskResult,
  durationMs: number,
): WorkflowStepExecution {
  return {
    id: step.id,
    kind: step.kind,
    status: 'SUCCEEDED',
    resolution: 'EXECUTED',
    attempts: 1,
    toolBinding: step.toolBinding,
    worktree: git.worktree,
    changedPaths: git.changedPaths,
    taskCommit: git.taskCommit,
    integratedCommit: git.integratedCommit,
    durationMs,
  }
}

function effectsForGit(replayRunId: string, git: GitTaskResult): WorkflowReplayEffectReceipt[] {
  return [
    {
      taskId: git.taskId,
      effectType: 'GIT_WORKTREE_CREATE' as const,
      resourceIdentity: git.branch,
      idempotencyKey: `${replayRunId}:${git.taskId}:worktree`,
      recoveryClassification: 'REVERSIBLE' as const,
      result: { branch: git.branch, baseCommit: git.baseCommit },
    },
    ...git.changedPaths.map(path => ({
      taskId: git.taskId,
      effectType: 'FILESYSTEM_WRITE' as const,
      resourceIdentity: path,
      idempotencyKey: `${replayRunId}:${git.taskId}:write:${path}`,
      recoveryClassification: 'REVERSIBLE' as const,
      result: { taskCommit: git.taskCommit, changedPath: path },
    })),
    {
      taskId: git.taskId,
      effectType: 'GIT_INTEGRATION' as const,
      resourceIdentity: 'integration/main',
      idempotencyKey: `${replayRunId}:${git.taskId}:merge`,
      recoveryClassification: 'REVERSIBLE' as const,
      result: { taskCommit: git.taskCommit, integratedCommit: git.integratedCommit },
    },
  ]
}

function staticStep(
  workflow: PromotedWorkflow,
  id: string,
  resolution: WorkflowStepExecution['resolution'],
  attempts = 1,
  durationMs?: number,
): WorkflowStepExecution {
  const step = workflow.steps.find(candidate => candidate.id === id)
  if (!step) throw new Error(`promoted workflow is missing required step ${id}`)
  return {
    id,
    kind: step.kind,
    status: 'SUCCEEDED',
    resolution,
    attempts,
    toolBinding: step.toolBinding,
    ...(durationMs === undefined ? {} : { durationMs }),
  }
}

function assertDependencies(step: PromotedWorkflow['steps'][number], completed: ReadonlySet<string>): void {
  const missing = step.dependencies.filter(dependency => !completed.has(dependency))
  if (missing.length > 0) throw new Error(`workflow step ${step.id} has incomplete dependencies: ${missing.join(', ')}`)
}

function assertStepBoundary(
  workflow: PromotedWorkflow,
  step: PromotedWorkflow['steps'][number],
  stepStarted: number,
  workflowStarted: number,
): number {
  const durationMs = Math.round(performance.now() - stepStarted)
  if (durationMs > step.timeoutSeconds * 1_000) {
    throw new Error(`workflow step ${step.id} exceeded timeoutSeconds=${step.timeoutSeconds}`)
  }
  if (performance.now() - workflowStarted > workflow.limits.wallTimeSeconds * 1_000) {
    throw new Error(`workflow exceeded wallTimeSeconds=${workflow.limits.wallTimeSeconds} after ${step.id}`)
  }
  return durationMs
}

function assertPromotionBindings(workflow: PromotedWorkflow, promotion: PromotionEnvelope, artifactDigest: string): void {
  if (promotion.workflowDigest !== artifactDigest) throw new Error('promotion workflowDigest does not match the exact workflow artifact')
  if (digestJson(promotion.workflow) !== artifactDigest) throw new Error('promotion envelope embeds a different workflow artifact')
  if (promotion.airDigest !== workflow.provenance.toAirDigest) throw new Error('promotion AIR digest does not match workflow provenance')
  if (promotion.sourceCommit !== workflow.provenance.candidateCommit) throw new Error('promotion commit does not match workflow provenance')
  if (promotion.verificationDigest !== workflow.provenance.verificationDigest) throw new Error('promotion verification digest does not match workflow provenance')
  if (promotion.evidenceDigest !== workflow.provenance.evidenceCoreDigest) throw new Error('promotion evidence digest does not match workflow provenance')
}

function verifyRepairScope(changedPaths: readonly string[], expectedScope: readonly string[]): void {
  const normalizedChanged = [...changedPaths].sort()
  const normalizedExpected = [...expectedScope].sort()
  if (digestJson(normalizedChanged) !== digestJson(normalizedExpected)) {
    throw new Error(`repair changed ${normalizedChanged.join(', ')}, expected exactly ${normalizedExpected.join(', ')}`)
  }
}

function portableReplayText(value: string, projectRoot: string): string {
  const workspaceRoot = resolve(projectRoot, '..', '..')
  let portable = value
  const replacements: Array<[string, string]> = [
    [pathToFileURL(projectRoot).href, '<KERNL_ROOT>'],
    [projectRoot.replaceAll('\\', '\\\\'), '<KERNL_ROOT>'],
    [projectRoot, '<KERNL_ROOT>'],
    [projectRoot.replaceAll('\\', '/'), '<KERNL_ROOT>'],
    [pathToFileURL(workspaceRoot).href, '<WORKSPACE_ROOT>'],
    [workspaceRoot.replaceAll('\\', '\\\\'), '<WORKSPACE_ROOT>'],
    [workspaceRoot, '<WORKSPACE_ROOT>'],
    [workspaceRoot.replaceAll('\\', '/'), '<WORKSPACE_ROOT>'],
  ]
  replacements.sort((left, right) => right[0].length - left[0].length)
  for (const [machinePath, token] of replacements) portable = portable.replaceAll(machinePath, token)
  return portable
    .replace(/[A-Za-z]:\\{1,2}Users\\{1,2}[^\\\s"']+/gi, '<USER_HOME>')
    .replace(/[A-Za-z]:\/Users\/[^/\s"']+/gi, '<USER_HOME>')
}

function portableReplayValue(value: unknown, projectRoot: string): unknown {
  if (typeof value === 'string') return portableReplayText(value, projectRoot)
  if (Array.isArray(value)) return value.map(item => portableReplayValue(item, projectRoot))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portableReplayValue(item, projectRoot)]))
  }
  return value
}

async function writeReplayArtifacts(
  projectRoot: string,
  outputDir: string,
  report: Omit<WorkflowReplayReport, 'reportDigest' | 'reportPath' | 'evidenceManifestPath'>,
  patch: string,
  reportFileName: string,
  patchFileName: string,
  manifestFileName: string,
): Promise<WorkflowReplayReport> {
  for (const name of [reportFileName, patchFileName, manifestFileName]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`unsafe workflow replay artifact name: ${name}`)
  }
  await mkdir(outputDir, { recursive: true })
  const patchPath = join(outputDir, patchFileName)
  await writeFile(patchPath, patch, 'utf8')
  const reportPath = join(outputDir, reportFileName)
  const artifactEffects: WorkflowReplayEffectReceipt[] = [patchFileName, reportFileName, manifestFileName].map(path => ({
    taskId: 'workflow:finalize-evidence',
    effectType: 'ARTIFACT_WRITE',
    resourceIdentity: path,
    idempotencyKey: `${report.replayRunId}:artifact:${path}`,
    recoveryClassification: 'REVERSIBLE',
    result: { path, materialized: true },
  }))
  const portableReport = portableReplayValue({
    ...report,
    effects: [...report.effects, ...artifactEffects],
  }, projectRoot) as typeof report
  const reportWithPath = {
    ...portableReport,
    source: { ...portableReport.source, patchPath: patchFileName },
    reportPath: reportFileName,
    evidenceManifestPath: manifestFileName,
  }
  const finalReport: WorkflowReplayReport = { ...reportWithPath, reportDigest: digestJson(reportWithPath) }
  const reportContent = `${canonicalJson(finalReport)}\n`
  await writeFile(reportPath, reportContent, 'utf8')
  const evidenceManifest = {
    schemaVersion: '1.0',
    kind: 'kernl-promoted-workflow-replay-evidence',
    workflowContentDigest: finalReport.workflow.contentDigest,
    workflowArtifactDigest: finalReport.workflow.artifactDigest,
    reportDigest: finalReport.reportDigest,
    files: [
      { path: patchFileName, sha256: sha256Hex(patch), bytes: Buffer.byteLength(patch) },
      { path: reportFileName, sha256: sha256Hex(reportContent), bytes: Buffer.byteLength(reportContent) },
    ].sort((left, right) => left.path.localeCompare(right.path)),
  }
  await writeFile(join(outputDir, manifestFileName), `${canonicalJson(evidenceManifest)}\n`, 'utf8')
  return finalReport
}

/**
 * Execute a promoted workflow from static artifacts and explicit source/AIR
 * inputs. No prior conversation, agent transcript, or Kernl SQLite state is
 * consulted. The promotion envelope is the trust anchor for the exact file.
 */
export async function runPromotedWorkflowReplay(options: WorkflowReplayOptions): Promise<WorkflowReplayReport> {
  const started = performance.now()
  const projectRoot = resolve(options.projectRoot)
  const workflowArtifactPath = resolve(options.workflowArtifactPath)
  const promotionArtifactPath = resolve(options.promotionArtifactPath)
  const beforeAirPath = resolve(options.beforeAirPath)
  const afterAirPath = resolve(options.afterAirPath)
  const replacementAirPath = resolve(options.replacementAirPath)
  const fixtureDir = resolve(options.fixtureDir)
  const outputDir = resolve(options.outputDir ?? join(projectRoot, 'artifacts', 'workflow-replay'))
  const replayRunId = options.replayRunId ?? `workflow-replay-${randomUUID()}`

  const [workflowRaw, promotionRaw, beforeRaw, afterRaw, replacementRaw] = await Promise.all([
    readJson(workflowArtifactPath),
    readJson(promotionArtifactPath),
    readJson(beforeAirPath),
    readJson(afterAirPath),
    readJson(replacementAirPath),
  ])
  const workflow = parsePromotedWorkflow(workflowRaw)
  const promotion = parsePromotionEnvelope(promotionRaw)
  const computedContentDigest = workflowContentDigest(workflow)
  if (computedContentDigest !== workflow.contentDigest) throw new Error('workflow contentDigest verification failed')
  const artifactDigest = workflowArtifactDigest(workflow)
  assertPromotionBindings(workflow, promotion, artifactDigest)

  const before = parseAir(beforeRaw)
  const after = parseAir(afterRaw)
  const replacement = parseAir(replacementRaw)
  const dag = compileTaskDag(before, after, {
    maximumParallelImplementations: workflow.limits.maximumParallelMutations,
    maximumRepairAttempts: workflow.limits.maximumRepairAttempts,
  })
  if (dag.fromAirDigest !== workflow.provenance.fromAirDigest) throw new Error('before AIR does not match workflow provenance')
  if (dag.toAirDigest !== workflow.provenance.toAirDigest) throw new Error('after AIR does not match workflow provenance')
  if (dag.digest !== workflow.provenance.dagDigest) throw new Error('compiled AIR task DAG does not match workflow provenance')
  const lifecycleProvenance = workflow.provenance.lifecycleReplacement
  if (dag.toAirDigest !== lifecycleProvenance.currentAirDigest || after.airVersion !== lifecycleProvenance.currentAirVersion) {
    throw new Error('lifecycle current AIR does not match workflow provenance')
  }
  const replacementAirDigest = digestJson(replacement)
  if (
    replacementAirDigest !== lifecycleProvenance.replacementAirDigest
    || replacement.airVersion !== lifecycleProvenance.replacementAirVersion
    || replacement.change.id !== lifecycleProvenance.changeId
  ) {
    throw new Error('replacement AIR does not match workflow lifecycle provenance')
  }
  if (digestJson(workflowStepsFromDag(dag, lifecycleProvenance)) !== digestJson(workflow.steps)) {
    throw new Error('static workflow steps do not exactly match the AIR-derived task DAG')
  }

  const workspaceManager = new GitWorkspaceManager(projectRoot)
  const repository: RunRepository = await workspaceManager.createRunRepository(replayRunId, fixtureDir)
  const verifier = new DeterministicVerifier(projectRoot)
  const baseline = await verifier.verifyBaseline(repository.integrationDir)
  if (baseline.status !== 'passed') throw new Error('workflow replay fixture failed baseline verification')

  const agent = new DeterministicAgentAdapter()
  const completed = new Set<string>()
  const executions: WorkflowStepExecution[] = []
  const effects: WorkflowReplayEffectReceipt[] = [{
    taskId: 'workflow:initialize-repository',
    effectType: 'RUN_REPOSITORY_CREATE',
    resourceIdentity: `run-workspace:${replayRunId}`,
    idempotencyKey: `${replayRunId}:workspace:create`,
    recoveryClassification: 'REVERSIBLE',
    result: { baseCommit: repository.baseCommit, isolation: 'git-worktree' },
  }]
  const worktrees: string[] = []
  const implementationResults: GitTaskResult[] = []
  let modelRequestsUsed = 0
  const consumeModelRequest = () => {
    if (modelRequestsUsed >= workflow.limits.maximumModelRequests) {
      throw new Error(`workflow exceeded maximumModelRequests=${workflow.limits.maximumModelRequests}`)
    }
    modelRequestsUsed += 1
  }

  const validationStep = workflow.steps.find(step => step.kind === 'VALIDATE')
  if (!validationStep) throw new Error('workflow has no validation step')
  const validationStarted = performance.now()
  assertDependencies(validationStep, completed)
  executions.push(staticStep(
    workflow,
    validationStep.id,
    'VERIFIED',
    1,
    assertStepBoundary(workflow, validationStep, validationStarted, started),
  ))
  completed.add(validationStep.id)

  for (const step of workflow.steps.filter(candidate => candidate.kind === 'IMPLEMENT')) {
    const stepStarted = performance.now()
    assertDependencies(step, completed)
    const compiled = dag.tasks.find(task => task.id === step.id)
    if (!compiled) throw new Error(`AIR DAG does not contain implementation step ${step.id}`)
    const task = runtimeTask(compiled, 1)
    consumeModelRequest()
    const result = await agent.implement(task)
    const gitResult = await workspaceManager.executeTask(repository, task, result)
    implementationResults.push(gitResult)
    executions.push(executionForTask(step, gitResult, assertStepBoundary(workflow, step, stepStarted, started)))
    effects.push(...effectsForGit(replayRunId, gitResult))
    worktrees.push(gitResult.worktree)
    completed.add(step.id)
  }

  const integrationStep = workflow.steps.find(step => step.kind === 'INTEGRATE')
  if (!integrationStep) throw new Error('workflow has no integration step')
  const integrationStarted = performance.now()
  assertDependencies(integrationStep, completed)
  executions.push(staticStep(
    workflow,
    integrationStep.id,
    'VERIFIED',
    1,
    assertStepBoundary(workflow, integrationStep, integrationStarted, started),
  ))
  completed.add(integrationStep.id)

  const initialVerificationStep = workflow.steps.find(step => step.id === 'verify:initial-candidate')
  if (!initialVerificationStep || initialVerificationStep.kind !== 'VERIFY') {
    throw new Error('workflow has no initial candidate verification step')
  }
  const initialVerificationStarted = performance.now()
  assertDependencies(initialVerificationStep, completed)
  const firstVerification = await verifier.verify(repository.integrationDir, 1)
  const expectedFingerprint = workflow.evaluationBaseline.expectedInitialFailure
  const firstFailure = firstVerification.gates.find(gate => gate.failureFingerprint === expectedFingerprint)
  if (firstVerification.status !== 'failed' || !firstFailure) {
    throw new Error(`workflow did not reproduce the expected initial failure ${expectedFingerprint}`)
  }
  if (digestJson([...(firstFailure.repairScope ?? [])].sort()) !== digestJson([...workflow.evaluationBaseline.expectedRepairScope].sort())) {
    throw new Error('verification-proposed repair scope does not match the promoted workflow')
  }
  executions.push(staticStep(
    workflow,
    initialVerificationStep.id,
    'VERIFIED',
    1,
    assertStepBoundary(workflow, initialVerificationStep, initialVerificationStarted, started),
  ))
  completed.add(initialVerificationStep.id)

  const repairSourceStep = workflow.steps.find(step => step.id === workflow.evaluationBaseline.expectedRepairStepId)
  if (!repairSourceStep || repairSourceStep.kind !== 'IMPLEMENT') throw new Error('promoted repair source step is not an implementation')
  const repairSourceTask = dag.tasks.find(task => task.id === repairSourceStep.id)
  if (!repairSourceTask) throw new Error('AIR DAG does not contain the promoted repair source step')
  const staticRepairStep = workflow.steps.find(step => step.kind === 'REPAIR')
  if (!staticRepairStep) throw new Error('promoted workflow has no explicit repair step')
  assertDependencies(staticRepairStep, completed)
  if (staticRepairStep.condition?.gateFailureFingerprint !== expectedFingerprint) {
    throw new Error('promoted repair condition does not match the observed verification failure')
  }
  if (digestJson([...staticRepairStep.writeScopes].sort()) !== digestJson([...workflow.evaluationBaseline.expectedRepairScope].sort())) {
    throw new Error('promoted repair step has the wrong write scope')
  }

  const verificationAttempts = [firstVerification]
  const repairStarted = performance.now()
  let repairGit: GitTaskResult | undefined
  let repairAttemptsUsed = 0
  for (let attempt = 1; attempt <= workflow.limits.maximumRepairAttempts; attempt += 1) {
    repairAttemptsUsed = attempt
    const compiledRepair = compileRepairTask(repairSourceTask, expectedFingerprint, attempt)
    const task = repairRuntimeTask(compiledRepair, attempt)
    consumeModelRequest()
    const result = await agent.implement(task)
    repairGit = await workspaceManager.executeTask(repository, task, result)
    verifyRepairScope(repairGit.changedPaths, workflow.evaluationBaseline.expectedRepairScope)
    effects.push(...effectsForGit(replayRunId, repairGit))
    worktrees.push(repairGit.worktree)
    const verification = await verifier.verify(repository.integrationDir, attempt + 1)
    verificationAttempts.push(verification)
    if (verification.status === 'passed') break
  }
  const finalVerification = verificationAttempts.at(-1)
  if (!repairGit || finalVerification?.status !== workflow.evaluationBaseline.expectedFinalStatus) {
    throw new Error(`workflow repair limit exhausted after ${repairAttemptsUsed} attempts`)
  }
  executions.push({
    id: staticRepairStep.id,
    kind: staticRepairStep.kind,
    status: 'SUCCEEDED',
    resolution: 'EXECUTED',
    attempts: repairAttemptsUsed,
    toolBinding: staticRepairStep.toolBinding,
    worktree: repairGit.worktree,
    changedPaths: repairGit.changedPaths,
    taskCommit: repairGit.taskCommit,
    integratedCommit: repairGit.integratedCommit,
    durationMs: assertStepBoundary(workflow, staticRepairStep, repairStarted, started),
  })
  completed.add(staticRepairStep.id)

  const finalVerificationStep = workflow.steps.find(step => step.id === 'verify:all-gates')
  if (!finalVerificationStep || finalVerificationStep.kind !== 'VERIFY') {
    throw new Error('workflow has no final verification step')
  }
  const finalVerificationStarted = performance.now()
  assertDependencies(finalVerificationStep, completed)
  executions.push(staticStep(
    workflow,
    finalVerificationStep.id,
    'VERIFIED',
    1,
    assertStepBoundary(workflow, finalVerificationStep, finalVerificationStarted, started),
  ))
  completed.add(finalVerificationStep.id)

  const lifecycleStep = workflow.steps.find(step => step.kind === 'LIFECYCLE')
  if (!lifecycleStep) throw new Error('workflow has no provider lifecycle replacement step')
  assertDependencies(lifecycleStep, completed)
  const lifecycleStarted = performance.now()
  const lifecycleLedger = new KernlLedger(':memory:')
  let lifecycleResult: ReturnType<typeof runQueueProviderReplacement>
  let lifecycleReceipts: EffectReceipt[]
  try {
    const storedCurrent = lifecycleLedger.putAir(after)
    lifecycleLedger.putAir(replacement)
    lifecycleLedger.createRun({
      id: `${replayRunId}-lifecycle`,
      airDigest: storedCurrent.digest,
      sourceCommit: await workspaceManager.currentCommit(repository.integrationDir),
    })
    lifecycleResult = runQueueProviderReplacement(
      lifecycleLedger,
      `${replayRunId}-lifecycle`,
      after,
      replacement,
    )
    lifecycleReceipts = lifecycleLedger.listEffects(`${replayRunId}-lifecycle`)
  } finally {
    lifecycleLedger.close()
  }
  if (!lifecycleResult.duplicateReceiptSuppressed) throw new Error('lifecycle replay duplicated a committed effect')
  const currentProvider = lifecycleResult.finalSnapshot.providers[lifecycleResult.plan.currentProvider.identity]
  const replacementProvider = lifecycleResult.finalSnapshot.providers[lifecycleResult.plan.replacementProvider.identity]
  const replacementBindingsCommitted = lifecycleResult.plan.bindings.every(binding =>
    lifecycleResult.finalSnapshot.bindings[binding.replacementRuntimeBindingId]?.state === 'COMMITTED',
  )
  if (
    currentProvider?.state !== 'INACTIVE'
    || currentProvider.relianceCount !== 0
    || replacementProvider?.state !== 'ACTIVE'
    || !replacementBindingsCommitted
  ) {
    throw new Error('lifecycle replay did not satisfy provider replacement invariants')
  }
  executions.push({
    ...staticStep(workflow, lifecycleStep.id, 'EXECUTED'),
    durationMs: assertStepBoundary(workflow, lifecycleStep, lifecycleStarted, started),
  })
  completed.add(lifecycleStep.id)

  const approvalStep = workflow.steps.find(step => step.kind === 'APPROVAL')
  if (!approvalStep) throw new Error('workflow has no approval step')
  const approvalStarted = performance.now()
  assertDependencies(approvalStep, completed)
  executions.push(staticStep(
    workflow,
    approvalStep.id,
    'SATISFIED_BY_PROMOTION',
    1,
    assertStepBoundary(workflow, approvalStep, approvalStarted, started),
  ))
  completed.add(approvalStep.id)

  const promotionStep = workflow.steps.find(step => step.kind === 'PROMOTE')
  if (!promotionStep) throw new Error('workflow has no promotion step')
  const promotionStarted = performance.now()
  assertDependencies(promotionStep, completed)
  executions.push(staticStep(
    workflow,
    promotionStep.id,
    'SATISFIED_BY_PROMOTION',
    1,
    assertStepBoundary(workflow, promotionStep, promotionStarted, started),
  ))
  completed.add(promotionStep.id)

  const elapsedMs = Math.round(performance.now() - started)
  const uniqueWorktrees = new Set(worktrees)
  const limitsRespected = uniqueWorktrees.size === worktrees.length
    && workflow.limits.maximumParallelMutations >= 1
    && repairAttemptsUsed <= workflow.limits.maximumRepairAttempts
    && workflow.steps.length <= workflow.limits.maximumTasks
    && executions.length <= workflow.limits.maximumSteps
    && modelRequestsUsed <= workflow.limits.maximumModelRequests
    && workflow.limits.maximumModelSpendUsd === 0
    && elapsedMs <= workflow.limits.wallTimeSeconds * 1_000
  if (!limitsRespected) throw new Error('workflow replay exceeded a promoted execution limit')
  if (new Set(effects.map(effect => effect.idempotencyKey)).size !== effects.length) {
    throw new Error('workflow replay produced duplicate effect idempotency keys')
  }

  const candidateCommit = await workspaceManager.currentCommit(repository.integrationDir)
  const patchPath = join(outputDir, 'change.patch')
  const publicContractPassed = finalVerification.gates.some(gate => gate.name === 'contract' && gate.status === 'passed')
  const duplicateDeliveryPassed = finalVerification.gates.some(gate => gate.name === 'idempotency' && gate.status === 'passed')
  if (!publicContractPassed || !duplicateDeliveryPassed) {
    throw new Error('final workflow verification did not prove contract and idempotency behavior')
  }
  const reportWithoutDigest: Omit<WorkflowReplayReport, 'reportDigest' | 'reportPath' | 'evidenceManifestPath'> = {
    schemaVersion: '1.0',
    mode: 'deterministic-mock-agent',
    status: 'passed',
    replayRunId,
    workflow: {
      artifactPath: workflowArtifactPath,
      sourceRunId: workflow.provenance.runId,
      workflowVersion: workflow.workflowVersion,
      contentDigest: workflow.contentDigest,
      computedContentDigest,
      artifactDigest,
      promotedWorkflowDigest: promotion.workflowDigest,
      contentVerified: true,
      promotionEnvelopeVerified: true,
    },
    inputs: {
      beforeAirPath,
      afterAirPath,
      replacementAirPath,
      fixtureDir,
      fromAirDigest: dag.fromAirDigest,
      toAirDigest: dag.toAirDigest,
      replacementAirDigest,
      dagDigest: dag.digest,
      inputsVerified: true,
    },
    source: {
      baseCommit: repository.baseCommit,
      candidateCommit,
      patchPath,
      isolatedWorktrees: worktrees,
    },
    steps: executions,
    verification: {
      baseline,
      attempts: verificationAttempts,
      intendedFailureObserved: true,
      initialFailureFingerprint: expectedFingerprint,
      finalStatus: 'passed',
    },
    repair: {
      attemptsUsed: repairAttemptsUsed,
      maximumAttempts: workflow.limits.maximumRepairAttempts,
      sourceStepId: repairSourceStep.id,
      expectedScope: workflow.evaluationBaseline.expectedRepairScope,
      changedPaths: repairGit.changedPaths,
      taskCommit: repairGit.taskCommit,
    },
    lifecycle: {
      stepId: lifecycleStep.id,
      currentAirVersion: lifecycleResult.plan.currentAirVersion,
      currentAirDigest: lifecycleResult.plan.currentAirDigest,
      replacementAirVersion: lifecycleResult.plan.replacementAirVersion,
      replacementAirDigest: lifecycleResult.plan.replacementAirDigest,
      trace: lifecycleResult.trace,
      finalSnapshot: lifecycleResult.finalSnapshot,
      receipts: lifecycleReceipts,
      duplicateReceiptSuppressed: true,
      assertions: {
        currentProviderInactive: true,
        currentProviderRelianceZero: true,
        replacementProviderActive: true,
        replacementBindingsCommitted: true,
      },
    },
    effects,
    limits: {
      tasksDeclared: workflow.steps.length,
      stepsExecuted: executions.length,
      modelRequests: modelRequestsUsed,
      modelSpendUsd: 0,
      maximumTasks: workflow.limits.maximumTasks,
      maximumSteps: workflow.limits.maximumSteps,
      maximumModelRequests: workflow.limits.maximumModelRequests,
      maximumModelSpendUsd: workflow.limits.maximumModelSpendUsd,
    },
    assertions: {
      noConversationContextUsed: true,
      exactStaticStepsMatchedAirDag: true,
      allMutationsIsolated: true,
      repairStayedInDeclaredScope: true,
      publicContractPassed: true,
      duplicateDeliveryPassedAfterRepair: true,
      limitsRespected: true,
    },
    elapsedMs,
  }
  return writeReplayArtifacts(
    projectRoot,
    outputDir,
    reportWithoutDigest,
    await workspaceManager.diff(repository),
    options.reportFileName ?? 'report.json',
    options.patchFileName ?? 'change.patch',
    options.manifestFileName ?? 'evidence-manifest.json',
  )
}

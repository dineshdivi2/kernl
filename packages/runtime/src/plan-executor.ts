import { cp, mkdir, readFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  addProvider,
  airDigest,
  assertLifecycleInvariants,
  commitBinding,
  createLifecycleSnapshot,
  markCleanupComplete,
  releaseBinding,
  transitionProvider,
  canonicalJson,
  digestJson,
  type AirDocument,
  type CompiledTask,
  type KernlLedger,
  type ParsedCatalog,
  type LifecycleSnapshot,
  parseCatalog,
} from '@kernl/core'
import type { ArchitecturePlan, PlanStep } from '@kernl/core'
import { GitWorkspaceManager, type RunRepository } from './git-workspaces.js'
import { generateFromRecipe, repairFor, scriptedDefectFor } from './recipes.js'
import { GenericVerifier, type GateSpec } from './generic-verifier.js'
import type { AgentMutation, RuntimeTask, GitTaskResult } from './types.js'
import { EvidenceWriter } from './evidence.js'
import { compilePromotedWorkflowV2, type PromotedWorkflowV2 } from './promotion-v2.js'
import { ChatCompletionClient, assertNoProviderSecrets, parseMutationProposal, type ProviderSelection } from './providers.js'
import { authorizeMutations } from './policy.js'
import {executionFingerprint} from './execution-fingerprint.js'

export interface PlanRunContext {
  runId: string
  plan: ArchitecturePlan
  fromAir: AirDocument
  toAir: AirDocument
  catalog: ParsedCatalog
  fixtureDir: string
  agent?: ProviderSelection & { maximumRequests: number; maximumOutputTokens: number }
}

export function loadPlanRunContext(ledger: KernlLedger, runId: string): PlanRunContext {
  const stored = ledger.getRunInputs<Omit<PlanRunContext, 'catalog'> & { catalog: ParsedCatalog['catalog'] }>(runId)
  return { ...stored, catalog: parseCatalog(stored.catalog) }
}

export interface PlanRunOutcome {
  status: 'AWAITING_APPROVAL' | 'PROMOTED' | 'FAILED'
  runId: string
  completedStepIds: string[]
  repairAttemptsUsed: number
  verificationAttempts: number
  error?: string
}

const IMPLEMENTING_TYPES = new Set(['GENERATE_COMPONENT', 'MODIFY_COMPONENT'])

/** A cross-component gate's name does not determine the owner of its failure. */
export function repairAuthority(plan:ArchitecturePlan,step:PlanStep,fingerprint:string,live:boolean):{scopes:string[];componentId:string} {
  const builders=plan.steps.filter(s=>IMPLEMENTING_TYPES.has(s.type))
  let scopes:string[]
  if(plan.expectedInitialFailure?.fingerprint===fingerprint) scopes=[...plan.expectedInitialFailure.repairScope]
  else {
    try {scopes=repairFor(fingerprint).map(file=>file.path)}
    catch(error) {
      if(!live)throw error
      scopes=builders.filter(s=>step.type==='VERIFY_SYSTEM'||s.componentIds.some(id=>step.componentIds.includes(id))).flatMap(s=>s.writeScopes)
    }
  }
  scopes=[...new Set(scopes)].sort()
  const plannedScopes=builders.flatMap(s=>s.writeScopes)
  if(!scopes.length||scopes.some(scope=>!plannedScopes.includes(scope)))throw new Error('repair scope is outside the compiled implementation authority')
  const owners=builders.filter(s=>s.writeScopes.some(scope=>scopes.includes(scope))).flatMap(s=>s.componentIds)
  return {scopes,componentId:[...new Set(owners)].join('+')}
}

interface ExecutorState {
  completed: Set<string>
  failed: Set<string>
  repairAttemptsUsed: number
  verificationAttempts: number
}

function kindForStep(step: PlanStep, repair: boolean): CompiledTask['kind'] {
  if (repair) return 'REPAIR'
  switch (step.type) {
    case 'VALIDATE_AIR': return 'VALIDATE'
    case 'GENERATE_COMPONENT':
    case 'MODIFY_COMPONENT': return 'IMPLEMENT'
    case 'UPDATE_BINDING':
    case 'UPDATE_CONTRACT':
    case 'TRANSITION_PROVIDER': return 'INTEGRATE'
    case 'VERIFY_COMPONENT':
    case 'VERIFY_SYSTEM': return 'VERIFY'
    case 'REQUEST_APPROVAL': return 'APPROVAL'
    case 'PROMOTE': return 'PROMOTE'
    case 'REPLAY_ASSERT': return 'VALIDATE'
    case 'REPAIR': return 'REPAIR'
  }
}

function stepToCompiledTask(step: PlanStep, repair: boolean, ctx:PlanRunContext): CompiledTask {
  return {
    id: step.id,
    kind: kindForStep(step, repair),
    title: step.title,
    componentIds: step.componentIds,
    dependsOn: step.dependsOn,
    writeScopes: step.writeScopes,
    deterministic: !IMPLEMENTING_TYPES.has(step.type) && step.type !== 'REPAIR',
    requiresApproval: step.requiresApproval,
    maxAttempts: step.maxAttempts,
    provenance: {
      changeId: ctx.plan.changeId,
      fromAirVersion: ctx.fromAir.airVersion,
      toAirVersion: ctx.toAir.airVersion,
      fromAirDigest: airDigest(ctx.fromAir),
      toAirDigest: airDigest(ctx.toAir),
      affectedBy: step.componentIds,
    },
  }
}

function runtimeTaskFor(step: PlanStep, repair: boolean): RuntimeTask {
  return {
    id: step.id,
    title: step.title,
    kind: repair ? 'worker-repair' : 'worker-refactor',
    dependencies: step.dependsOn,
    allowedPaths: step.writeScopes,
    architectureNodeIds: step.componentIds,
    contracts: [],
    acceptanceGates: ['build', 'unit', 'contract', 'idempotency', 'secret-scan'],
    forbiddenActions: ['modify-verification', 'weaken-tests', 'change-public-api', 'production-write'],
    attempt: 1,
    maxAttempts: step.maxAttempts,
  }
}

function repairStepFor(stepId: string, componentId: string, scopes: readonly string[], fingerprint: string, attempt: number): PlanStep {
  return {
    id: `repair:${stepId}:${attempt}`,
    type: 'REPAIR',
    title: `Scoped repair of ${componentId} after ${fingerprint}`,
    componentIds: [componentId],
    // Repairs are authorized directly after the failing verification; the
    // failed task itself is not a satisfiable dependency.
    dependsOn: [],
    writeScopes: [...scopes],
    requiredCapabilities: ['task:repair'],
    catalogRefs: [],
    timeoutMs: 60_000,
    maxAttempts: 1,
    deterministic: false,
    requiresApproval: false,
    repairCondition: { fingerprint, scopeHint: [...scopes] },
    assertions: ['repair-limited-to-authorized-scope'],
  }
}

export interface PromotionResultV2 {
  promotionId: string
  workflowDigest: string
  workflow: PromotedWorkflowV2
  evidenceManifestDigest: string
  artifactDir: string
}

/**
 * Executes an ArchitecturePlan step by step against the durable ledger.
 * Every mutating step is claimed, authorized, and integrated in an isolated
 * Git worktree. Verification failures compile scoped REPAIR steps from the
 * same plan vocabulary. Approval suspends the run durably; re-entering run()
 * after the approval decision resumes at PROMOTE. Completed steps are always
 * skipped, so interrupted runs resume from persisted state alone.
 */
export class ArchitecturePlanExecutor {
  private readonly projectRoot: string
  private readonly ledger: KernlLedger
  private readonly git: GitWorkspaceManager
  private readonly verifier: GenericVerifier
  private readonly checkpoint: ((phase: string) => void) | undefined
  private guard: () => void = () => undefined
  private readonly client: ChatCompletionClient

  constructor(projectRoot: string, ledger: KernlLedger, options: { verifier?: GenericVerifier; checkpoint?: (phase: string) => void; client?: ChatCompletionClient } = {}) {
    this.projectRoot = projectRoot
    this.ledger = ledger
    this.git = new GitWorkspaceManager(projectRoot)
    this.verifier = options.verifier ?? new GenericVerifier(projectRoot)
    this.checkpoint = options.checkpoint
    this.client = options.client ?? new ChatCompletionClient()
  }

  private recipeMutations(step: PlanStep): AgentMutation[] {
    const ref = step.catalogRefs[0]
    if (!ref) throw new Error(`step ${step.id} has no catalog recipe reference`)
    const manifest = {
      component: { id: ref.id, version: ref.version },
      generation: { template: ref.recipe, inputs: {}, generates: [], modifies: [] },
    }
    const files = generateFromRecipe(ref.recipe, { componentId: step.componentIds[0] ?? ref.id, manifest })
    return files.map(file => ({ path: file.path, content: file.content }))
  }

  private async ensureRepository(ctx: PlanRunContext): Promise<RunRepository> {
    const effectKey = `${ctx.runId}:workspace:create`
    const existing = this.ledger.listEffects(ctx.runId).find(effect => effect.idempotencyKey === effectKey)
    if (existing) {
      const runRoot = this.git.runRepositoryPath(ctx.runId)
      return {
        runRoot,
        integrationDir: join(runRoot, 'integration'),
        baseCommit: String((existing.result as { baseCommit?: string }).baseCommit ?? ''),
      }
    }
    this.ledger.appendEvent(ctx.runId, 'EFFECT_PLANNED', {
      effectType: 'RUN_REPOSITORY_CREATE',
      resourceIdentity: `run-workspace:${ctx.runId}`,
      idempotencyKey: effectKey,
    })
    await mkdir(join(this.projectRoot, 'data'), { recursive: true })
    this.ledger.planOperation(ctx.runId, effectKey, { fixture: ctx.fixtureDir, airDigest: airDigest(ctx.fromAir) })
    const repository = await this.git.createRunRepository(ctx.runId, ctx.fixtureDir, true)
    this.ledger.commitOperation(ctx.runId, effectKey, repository)
    this.ledger.appendEffectReceipt({
      runId: ctx.runId,
      episodeId: `${ctx.runId}:workspace`,
      componentId: 'architecture-control-plane',
      taskId: 'validate:air-change',
      effectType: 'RUN_REPOSITORY_CREATE',
      resourceIdentity: `run-workspace:${ctx.runId}`,
      idempotencyKey: effectKey,
      preconditions: { fixtureAirDigest: airDigest(ctx.fromAir), workspaceAbsent: true },
      result: { baseCommit: repository.baseCommit, isolation: 'git-worktree' },
      resultingState: 'COMMITTED',
      recoveryClassification: 'REVERSIBLE',
      recoveryMetadata: { recovery: 'remove uniquely scoped run workspace after verifying runId' },
      provenance: { controller: 'ArchitecturePlanExecutor', fixture: ctx.fixtureDir },
    })
    this.ledger.setRunSourceCommit(ctx.runId, repository.baseCommit)
    return repository
  }

  private async executeMutating(ctx: PlanRunContext, repository: RunRepository, step: PlanStep, repair: boolean, fingerprint?: string): Promise<void> {
    const attempt = 1
    const task = runtimeTaskFor(step, repair)
    const workerId = `${ctx.agent?.provider ?? 'deterministic'}-agent-${step.componentIds[0] ?? 'generic'}`
    this.ledger.putTask(ctx.runId, stepToCompiledTask(step, repair,ctx), 'PENDING', attempt)
    const claim = this.ledger.claimTask({
      runId: ctx.runId,
      taskId: step.id,
      workerId,
      capabilities: [`task:${repair ? 'repair' : 'implement'}`],
      writeScopes: step.writeScopes,
    })
    if (!claim.claimed) throw new Error(`could not claim ${step.id}: ${claim.reason}`)
    this.ledger.setTaskStatus(ctx.runId, step.id, 'RUNNING', attempt)

    const operationKey = `implementation:${step.id}:${attempt}`
    const existingOperation = this.ledger.operation<GitTaskResult>(ctx.runId, operationKey)
    const intent = existingOperation?.intent as { baseCommit: string; mutations: AgentMutation[] } | undefined
    let mutations: AgentMutation[]
    if (intent) mutations = intent.mutations
    else if (ctx.agent) {
      const requests = this.ledger.listEvents(ctx.runId).filter(event=>event.type==='MODEL_REQUEST' && !(event.payload as {simulated?:boolean}).simulated).length
      if (!Number.isInteger(ctx.agent.maximumRequests) || ctx.agent.maximumRequests<1 || requests >= Math.min(10,ctx.agent.maximumRequests,ctx.plan.budgets.maximumModelRequests)) throw new Error('durable model request limit exhausted')
      const sources: Record<string,string> = {}
      for (const name of await readdir(join(repository.integrationDir,'src'))) {
        if (name.endsWith('.ts')) sources[`src/${name}`] = await readFile(join(repository.integrationDir,'src',name),'utf8')
      }
      const priorFailure = [...this.ledger.listEvents(ctx.runId)].reverse().find(event=>event.type==='VERIFICATION_FINISHED' && (event.payload as {status:string}).status==='failed')?.payload
      const prompt = JSON.stringify({task:step,fromAir:ctx.fromAir,toAir:ctx.toAir,sources,repair,priorFailure,
        referenceImplementation: repair ? undefined : this.recipeMutations(step)})
      assertNoProviderSecrets(prompt)
      this.guard()
      // Reserve before sending. An uncertain network request is never silently retried.
      this.ledger.appendEvent(ctx.runId,'MODEL_REQUEST',{adapter:ctx.agent.provider,simulated:false,model:ctx.agent.model,taskId:step.id,requestOrdinal:requests+1,promptDigest:digestJson(prompt)},step.id)
      const response = await this.client.complete(ctx.agent,
        'Implement only the requested architecture task in this small trusted local TypeScript fixture. Return JSON with exactly summary:string and mutations:[{path,content}]. Full file contents, only declared write scopes. Preserve exports and public behavior. Do not modify tests, execute commands, read secrets, add dependencies, or access network/filesystem at runtime. The reference implementation is a starting point, not verification authority. Fix only this task; other DAG tasks implement their own components.',
        prompt,ctx.agent.maximumOutputTokens)
      this.guard()
      mutations = parseMutationProposal(response.content).mutations
      this.ledger.appendEvent(ctx.runId,'MODEL_OBSERVATION',response.provenance,step.id)
    } else if (repair && fingerprint) {
      mutations = repairFor(fingerprint).map(file => ({ path: file.path, content: file.content }))
    } else if (isScriptedDefectStep(ctx.plan, step)) {
      const defectFingerprint = ctx.plan.expectedInitialFailure?.fingerprint ?? ''
      mutations = scriptedDefectFor(defectFingerprint).map(file => ({ path: file.path, content: file.content }))
      this.ledger.appendEvent(ctx.runId, 'SCRIPTED_DEFECT_APPLIED', {
        taskId: step.id,
        fingerprint: defectFingerprint,
        note: 'Deterministic adapter applies the planned honest first-candidate defect.',
      }, step.id)
    } else {
      mutations = this.recipeMutations(step)
    }

    if (!intent && !ctx.agent) this.ledger.appendEvent(ctx.runId, 'MODEL_REQUEST', {
      adapter: 'deterministic-recipe-v2', simulated: true, taskId: step.id, architectureNodeIds: step.componentIds,
    }, step.id)
    this.ledger.appendEvent(ctx.runId, 'TOOL_PROPOSED', {
      tool: 'authorized_write', paths: mutations.map(mutation => mutation.path), authority: step.writeScopes,
    }, step.id)
    assertNoProviderSecrets(JSON.stringify(mutations))
    authorizeMutations(task,repository.integrationDir,mutations)
    this.ledger.appendEvent(ctx.runId, 'AUTHORIZATION_GRANTED', {
      taskId: step.id, checks: ['path-scope', 'verification-read-only', 'no-production-write'],
    }, step.id)

    const frozenIntent = intent ?? { baseCommit: await this.git.currentCommit(repository.integrationDir), mutations }
    this.ledger.planOperation(ctx.runId, operationKey, frozenIntent)
    const gitResult = existingOperation?.result ?? await this.git.executeTask(repository, task,
      { adapter: 'deterministic', taskId: step.id, summary: step.title, mutations: frozenIntent.mutations },
      { recover: true, baseCommit: frozenIntent.baseCommit, ...(this.checkpoint ? {checkpoint:this.checkpoint} : {}), guard: this.guard })
    this.ledger.commitOperation(ctx.runId, operationKey, gitResult)
    const receiptBase = {
      runId: ctx.runId,
      episodeId: `${ctx.runId}:implementation`,
      componentId: step.componentIds.join('+'),
      taskId: step.id,
      provenance: { adapter: ctx.agent?.provider ?? 'deterministic-recipe-v2', taskId: step.id },
    }
    this.ledger.appendEffectReceipt({
      ...receiptBase,
      effectType: 'GIT_WORKTREE_CREATE',
      resourceIdentity: gitResult.branch,
      idempotencyKey: `${ctx.runId}:${step.id}:${attempt}:worktree`,
      preconditions: { baseCommit: gitResult.baseCommit, isolated: true },
      result: { branch: gitResult.branch, worktree: gitResult.worktree },
      resultingState: 'COMMITTED',
      recoveryClassification: 'REVERSIBLE',
      recoveryMetadata: { recovery: 'git worktree remove after verifying the exact task worktree' },
    })
    for (const mutation of frozenIntent.mutations) {
      this.ledger.appendEffectReceipt({
        ...receiptBase,
        effectType: 'FILESYSTEM_WRITE',
        resourceIdentity: mutation.path,
        idempotencyKey: `${ctx.runId}:${step.id}:${attempt}:write:${mutation.path}`,
        preconditions: { baseCommit: gitResult.baseCommit, allowedPaths: step.writeScopes },
        result: { taskCommit: gitResult.taskCommit, contentDigest: digestJson(mutation.content) },
        resultingState: 'COMMITTED',
        recoveryClassification: 'REVERSIBLE',
        recoveryMetadata: { inverse: `git revert ${gitResult.taskCommit}`, patchRetained: true },
      })
    }
    this.ledger.appendEffectReceipt({
      ...receiptBase,
      effectType: 'GIT_INTEGRATION',
      resourceIdentity: 'integration/main',
      idempotencyKey: `${ctx.runId}:${step.id}:${attempt}:merge`,
      preconditions: { baseCommit: gitResult.baseCommit, taskCommit: gitResult.taskCommit },
      result: { integratedCommit: gitResult.integratedCommit, changedPaths: gitResult.changedPaths },
      resultingState: 'COMMITTED',
      recoveryClassification: 'REVERSIBLE',
      recoveryMetadata: { inverse: `git revert -m 1 ${gitResult.integratedCommit}` },
    })
    this.ledger.appendEvent(ctx.runId, 'TOOL_EXECUTED', {
      tool: 'authorized_write', changedPaths: gitResult.changedPaths, taskCommit: gitResult.taskCommit,
    }, step.id)
    this.ledger.setRunSourceCommit(ctx.runId, gitResult.integratedCommit)
    this.ledger.setTaskStatus(ctx.runId, step.id, 'SUCCEEDED', attempt)
  }

  private async executeTransition(ctx: PlanRunContext, step: PlanStep): Promise<void> {
    const componentId = step.componentIds[0]
    if (!componentId) throw new Error(`transition step ${step.id} has no component`)
    const match = /transition:.+:(.+)-to-(.+)$/.exec(step.id)
    if (!match?.[1] || !match[2]) throw new Error(`cannot parse transition versions from ${step.id}`)
    const fromVersion = match[1]
    const toVersion = match[2]
    const oldProviderId = `${componentId}@${fromVersion}`
    const newProviderId = `${componentId}@${toVersion}`

    const oldBindings = ctx.fromAir.bindings.filter(binding => binding.providerId === componentId && binding.providerVersion === fromVersion)
    const newBindings = ctx.toAir.bindings.filter(binding => binding.providerId === componentId && binding.providerVersion === toVersion)

    let snapshot: LifecycleSnapshot = createLifecycleSnapshot([{ id: oldProviderId, version: fromVersion, state: 'PENDING' }])
    const trace: Array<{ step: string; snapshot: LifecycleSnapshot }> = []
    const record = (label: string): void => {
      trace.push({ step: label, snapshot: structuredClone(snapshot) })
      this.ledger.appendEvent(ctx.runId, 'LIFECYCLE_STATE_CHANGED', { step: label, snapshot: structuredClone(snapshot) })
    }

    snapshot = transitionProvider(snapshot, oldProviderId, 'LOADING')
    record(`${oldProviderId}: LOADING`)
    snapshot = transitionProvider(snapshot, oldProviderId, 'ACTIVE')
    record(`${oldProviderId}: ACTIVE`)
    for (const binding of oldBindings) {
      snapshot = commitBinding(snapshot, {
        id: `${binding.id}@${binding.providerVersion}`,
        consumerId: binding.consumerId,
        requirementId: binding.requirementId,
        providerId: oldProviderId,
        providerVersion: fromVersion,
      })
    }
    record(`${oldProviderId}: consumers committed (${oldBindings.length})`)

    snapshot = addProvider(snapshot, { id: newProviderId, version: toVersion })
    record(`${newProviderId}: PENDING`)
    snapshot = transitionProvider(snapshot, newProviderId, 'LOADING')
    record(`${newProviderId}: LOADING`)
    snapshot = transitionProvider(snapshot, newProviderId, 'ACTIVE')
    record(`${newProviderId}: ACTIVE`)

    snapshot = transitionProvider(snapshot, oldProviderId, 'RETIRING')
    record(`${oldProviderId}: RETIRING (rejects new bindings)`)
    let rejectedNewBinding = false
    try {
      snapshot = commitBinding(snapshot, {
        id: `${ctx.runId}:late-binding`,
        consumerId: 'late-consumer',
        requirementId: 'late-requirement',
        providerId: oldProviderId,
        providerVersion: fromVersion,
      })
    } catch {
      rejectedNewBinding = true
    }
    if (!rejectedNewBinding) throw new Error('retiring provider accepted a new binding')

    const rebound: string[] = []
    for (const binding of newBindings) {
      // Release the exact prior commitment first: the ledger enforces one
      // committed provider per (consumer, requirement), so rebinding is a
      // single atomic-looking release followed by the new commitment.
      await Promise.resolve()
      snapshot = releaseBinding(snapshot, `${binding.id}@${fromVersion}`)
      record(`${binding.consumerId} released ${binding.id}@${fromVersion}`)
      const runtimeId = `${binding.id}@${toVersion}`
      snapshot = commitBinding(snapshot, {
        id: runtimeId,
        consumerId: binding.consumerId,
        requirementId: binding.requirementId,
        providerId: newProviderId,
        providerVersion: toVersion,
      })
      rebound.push(runtimeId)
      record(`${binding.consumerId} rebound exactly once -> ${runtimeId}`)
    }

    const oldProvider = snapshot.providers[oldProviderId]
    if (!oldProvider || oldProvider.relianceCount !== 0) throw new Error(`provider ${oldProviderId} reliance did not reach zero`)
    snapshot = transitionProvider(snapshot, oldProviderId, 'DRAINING')
    record(`${oldProviderId}: DRAINING`)
    const cleanupReceipt = this.ledger.appendEffectReceipt({
      runId: ctx.runId,
      episodeId: `${ctx.runId}:lifecycle`,
      componentId,
      taskId: step.id,
      effectType: 'provider.cleanup',
      resourceIdentity: oldProviderId,
      idempotencyKey: `${ctx.runId}:${step.id}:cleanup`,
      preconditions: { state: 'DRAINING', relianceCount: 0 },
      result: { cleanedUp: true, cleanupComplete: true },
      resultingState: 'CLEANUP_COMPLETE',
      recoveryClassification: 'COMPENSATABLE',
      recoveryMetadata: { recovery: 'cleanup is idempotent; repeat observation returns the original receipt' },
      provenance: { transitionStep: step.id },
    })
    snapshot = markCleanupComplete(snapshot, oldProviderId, {
      id: cleanupReceipt.receipt.id,
      effectType: cleanupReceipt.receipt.effectType,
      resourceIdentity: cleanupReceipt.receipt.resourceIdentity,
      idempotencyKey: cleanupReceipt.receipt.idempotencyKey,
      result: cleanupReceipt.receipt.result,
      resultingState: cleanupReceipt.receipt.resultingState,
      recoveryClassification: cleanupReceipt.receipt.recoveryClassification,
      committedAt: cleanupReceipt.receipt.committedAt,
    })
    record(`${oldProviderId}: cleanup complete`)
    snapshot = transitionProvider(snapshot, oldProviderId, 'INACTIVE')
    record(`${oldProviderId}: INACTIVE`)
    assertLifecycleInvariants(snapshot)

    this.ledger.appendEffectReceipt({
      runId: ctx.runId,
      episodeId: `${ctx.runId}:lifecycle`,
      componentId,
      taskId: step.id,
      effectType: 'PROVIDER_TRANSITION',
      resourceIdentity: `${oldProviderId}->${newProviderId}`,
      idempotencyKey: `${ctx.runId}:${step.id}`,
      preconditions: { fromVersion, toVersion },
      result: { trace, rebound, rejectedNewBinding },
      resultingState: 'COMMITTED',
      recoveryClassification: 'COMPENSATABLE',
      recoveryMetadata: { recovery: 'transition replays are suppressed by the idempotency key' },
      provenance: { transitionStep: step.id },
    })
  }

  private async materializeEvidenceCore(ctx: PlanRunContext): Promise<string> {
    const writer = new EvidenceWriter(this.projectRoot, join('artifacts', 'runs', ctx.runId))
    await writer.initialize()
    await writer.json('plan.json', ctx.plan)
    await writer.json('air-before.json', ctx.fromAir)
    await writer.json('air-after.json', ctx.toAir)
    await writer.json('catalog.json', ctx.catalog.catalog)
    await writer.json('execution-bindings.json',await executionFingerprint(this.projectRoot,ctx.fixtureDir,ctx.catalog.digest))
    const repository = await this.ensureRepository(ctx)
    await writer.text('candidate.patch', await this.git.diff(repository))
    await writer.json('source.json', {baselineCommit:repository.baseCommit,candidateCommit:this.ledger.getRun(ctx.runId).sourceCommit})
    await writer.json('verification.json', [...this.ledger.listEvents(ctx.runId)].reverse().find(event=>event.type==='VERIFICATION_FINISHED')?.payload)
    await writer.jsonLines('events-preapproval.jsonl', this.ledger.listEvents(ctx.runId))
    await writer.json('effect-ledger-preapproval.json', this.ledger.listEffects(ctx.runId))
    const core = { schemaVersion: '2.0', runId: ctx.runId, files: writer.entries() }
    const digest = digestJson(core)
    await writer.json('evidence-core.json', { ...core, digest })
    return digest
  }

  private async executeVerification(ctx: PlanRunContext, repository: RunRepository, step: PlanStep, state: ExecutorState): Promise<void> {
    state.verificationAttempts += 1
    const attempt = state.verificationAttempts
    const gates: GateSpec[] = []
    if (step.type === 'VERIFY_COMPONENT') {
      const ref = step.catalogRefs[0]
      if (ref) {
        const manifest = ctx.catalog.byTypeVersion.get(`${ref.type}:${ref.id}@${ref.version}`)
        for (const gate of manifest?.verification.gates ?? []) {
          gates.push({ id: gate.id, command: gate.command, timeoutMs: gate.timeoutMs })
        }
      }
    } else {
      for (const gate of ctx.toAir.verification.gates) {
        gates.push({ id: gate.id, command: gate.command, timeoutMs: gate.timeoutMs })
      }
    }
    this.ledger.setRunStatus(ctx.runId, 'VERIFYING')
    this.ledger.setTaskStatus(ctx.runId, step.id, 'RUNNING')
    const report = await this.verifier.verify(repository.integrationDir, attempt, gates)
    Object.assign(report, { candidateCommit: await this.git.currentCommit(repository.integrationDir) })
    report.digest = digestJson({ ...report, digest: undefined })
    this.ledger.appendEvent(ctx.runId, 'VERIFICATION_FINISHED', report, step.id)
    this.ledger.setRunStatus(ctx.runId, 'RUNNING')

    if (report.status === 'passed') {
      this.ledger.setTaskStatus(ctx.runId, step.id, 'SUCCEEDED')
      return
    }

    const failedGate = report.gates.find(gate => gate.status === 'failed' && gate.failureFingerprint)
    const fingerprint = failedGate?.failureFingerprint
    if (!fingerprint || state.repairAttemptsUsed >= ctx.plan.budgets.maximumRepairAttempts) {
      this.ledger.setTaskStatus(ctx.runId, step.id, 'FAILED')
      this.ledger.setRunStatus(ctx.runId, 'FAILED')
      throw new Error(`verification failed without repair budget: ${failedGate?.name ?? 'unknown gate'}`)
    }

    state.repairAttemptsUsed += 1
    const {scopes,componentId}=repairAuthority(ctx.plan,step,fingerprint,Boolean(ctx.agent))
    const repair = repairStepFor(step.id, componentId, scopes, fingerprint, state.repairAttemptsUsed)
    this.ledger.appendEvent(ctx.runId, 'REPAIR_TASK_COMPILED', {
      repairStepId: repair.id, fingerprint, scopes, failedGate: failedGate?.name,
    }, step.id)
    await this.executeMutating(ctx, repository, repair, true, fingerprint)
    this.ledger.appendEvent(ctx.runId, 'REPAIR_APPLIED', { repairStepId: repair.id, scopes }, step.id)
    await this.executeVerification(ctx, repository, step, state)
  }

  /** Execute the plan. Resumable: completed steps are skipped on re-entry. */
  async run(ctx: PlanRunContext): Promise<PlanRunOutcome> {
    this.ledger.freezeRunInputs(ctx.runId, { ...ctx, catalog: ctx.catalog.catalog })
    const owner = randomUUID()
    const epoch = this.ledger.acquireExecution(ctx.runId, owner)
    this.guard = () => this.ledger.renewExecution(ctx.runId,owner,epoch)
    let leaseLost = false
    const renew = setInterval(() => { try { this.ledger.renewExecution(ctx.runId,owner,epoch) } catch { leaseLost=true } },10_000)
    const completed = new Set<string>()
    const failed = new Set<string>()
    const previousEvents = this.ledger.listEvents(ctx.runId)
    const state: ExecutorState = { completed, failed,
      repairAttemptsUsed: previousEvents.filter(event => event.type === 'REPAIR_TASK_COMPILED').length,
      verificationAttempts: previousEvents.filter(event => event.type === 'VERIFICATION_FINISHED').length }

    try {
      const existingRun = this.ledger.getRun(ctx.runId)
      if (existingRun.status === 'CANCELLED') throw new Error('cancelled run cannot execute')
      if (existingRun.status === 'PROMOTED') {
        if (!this.ledger.listEffects(ctx.runId).some(effect=>effect.effectType==='EVIDENCE_CANONICAL_PUBLISH')) {
          const approval=this.ledger.listApprovals(ctx.runId).find(a=>a.decision==='APPROVED')
          await promotePlanRun(this.projectRoot,this.ledger,ctx,approval?.evidenceDigest??'')
        }
        return {status:'PROMOTED',runId:ctx.runId,completedStepIds:this.ledger.listTasks(ctx.runId).filter(t=>t.status==='SUCCEEDED').map(t=>t.id),repairAttemptsUsed:state.repairAttemptsUsed,verificationAttempts:state.verificationAttempts}
      }
      if (existingRun.status === 'PLANNING') {
        this.ledger.appendEvent(ctx.runId, 'PLAN_COMPILED', { planDigest: ctx.plan.digest, steps: ctx.plan.steps.length })
        this.ledger.setRunStatus(ctx.runId, 'RUNNING')
      }
      for (const task of this.ledger.listTasks(ctx.runId)) {
        if (task.status === 'SUCCEEDED') completed.add(task.id)
        if (task.status === 'FAILED') failed.add(task.id)
      }

      const repository = await this.ensureRepository(ctx)
      if (!previousEvents.some(event => event.type === 'BASELINE_VERIFICATION_FINISHED' && (event.payload as { status: string }).status === 'passed')) {
        const baseline = await this.verifier.verify(repository.integrationDir, 0, [
          { id: 'build', command: 'tsc -p tsconfig.json' },
          { id: 'unit', command: 'node tests/unit.mjs' },
          { id: 'contract', command: 'node tests/public-contract.mjs' },
        ])
        this.ledger.appendEvent(ctx.runId, 'BASELINE_VERIFICATION_FINISHED', baseline)
        if (baseline.status !== 'passed') throw new Error('fixture baseline failed verification')
        completed.add('baseline:verify')
      }

      for (const step of ctx.plan.steps) {
        if (leaseLost) throw new Error('execution lease lost')
        this.ledger.renewExecution(ctx.runId,owner,epoch)
        if (completed.has(step.id)) continue
        if (step.type !== 'PROMOTE' && step.type !== 'REQUEST_APPROVAL' && step.type !== 'REPLAY_ASSERT' && Date.now()-Date.parse(existingRun.createdAt)>ctx.plan.budgets.wallTimeSeconds*1000) throw new Error('run execution wall-time budget exhausted')
        const signal = await this.executeStep(ctx, repository, step, state, completed, failed)
        if (signal === 'suspend') {
          return {
            status: 'AWAITING_APPROVAL',
            runId: ctx.runId,
            completedStepIds: [...completed].sort(),
            repairAttemptsUsed: state.repairAttemptsUsed,
            verificationAttempts: state.verificationAttempts,
          }
        }
      }
      const status = this.ledger.getRun(ctx.runId).status
      return {
        status: status === 'PROMOTED' ? 'PROMOTED' : 'FAILED',
        runId: ctx.runId,
        completedStepIds: [...completed].sort(),
        repairAttemptsUsed: state.repairAttemptsUsed,
        verificationAttempts: state.verificationAttempts,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!['PROMOTED', 'CANCELLED'].includes(this.ledger.getRun(ctx.runId).status)) {
        this.ledger.appendEvent(ctx.runId, 'RUN_EXECUTION_FAILED', { message })
        this.ledger.setRunStatus(ctx.runId, 'FAILED')
      }
      return {
        status: 'FAILED',
        runId: ctx.runId,
        completedStepIds: [...completed].sort(),
        repairAttemptsUsed: state.repairAttemptsUsed,
        verificationAttempts: state.verificationAttempts,
        error: message,
      }
    } finally {
      clearInterval(renew)
      this.ledger.releaseExecution(ctx.runId,owner,epoch)
    }
  }

  private async executeStep(
    ctx: PlanRunContext,
    repository: RunRepository,
    step: PlanStep,
    state: ExecutorState,
    completed: Set<string>,
    failed: Set<string>,
  ): Promise<'continue' | 'suspend'> {
    for (const dependency of step.dependsOn) {
      if (!completed.has(dependency)) {
        const dependencyStep = ctx.plan.steps.find(candidate => candidate.id === dependency)
        if (!dependencyStep) throw new Error(`step ${step.id} depends on unknown ${dependency}`)
        await this.executeStep(ctx, repository, dependencyStep, state, completed, failed)
      }
      if (failed.has(dependency)) throw new Error(`dependency ${dependency} failed; cannot run ${step.id}`)
    }
    if (completed.has(step.id)) return 'continue'

    if (!IMPLEMENTING_TYPES.has(step.type) && step.type !== 'REPAIR') {
      this.ledger.putTask(ctx.runId, stepToCompiledTask(step, false,ctx), 'PENDING')
    }

    switch (step.type) {
      case 'VALIDATE_AIR': {
        this.ledger.appendEvent(ctx.runId, 'ARCHITECTURE_CHANGE_ACCEPTED', {
          from: { version: ctx.fromAir.airVersion, digest: airDigest(ctx.fromAir) },
          to: { version: ctx.toAir.airVersion, digest: airDigest(ctx.toAir) },
          planDigest: ctx.plan.digest,
        })
        break
      }
      case 'GENERATE_COMPONENT':
      case 'MODIFY_COMPONENT': {
        await this.executeMutating(ctx, repository, step, false)
        break
      }
      case 'UPDATE_BINDING': {
        for (const binding of ctx.toAir.bindings) {
          this.ledger.putBinding({
            id: `${binding.id}@${binding.providerVersion}`,
            runId: ctx.runId,
            consumerId: binding.consumerId,
            requirementId: binding.requirementId,
            providerId: binding.providerId,
            providerVersion: binding.providerVersion,
            state: 'COMMITTED',
            relianceCount: 1,
          })
        }
        break
      }
      case 'UPDATE_CONTRACT': {
        this.ledger.appendEvent(ctx.runId, 'CONTRACTS_UPDATED', {
          contracts: ctx.toAir.contracts.map(contract => ({ id: contract.id, version: contract.version, kind: contract.kind })),
        })
        break
      }
      case 'TRANSITION_PROVIDER': {
        await this.executeTransition(ctx, step)
        break
      }
      case 'VERIFY_COMPONENT':
      case 'VERIFY_SYSTEM': {
        await this.executeVerification(ctx, repository, step, state)
        break
      }
      case 'REPAIR': {
        throw new Error(`standalone repair step ${step.id} must run through verification failure handling`)
      }
      case 'REQUEST_APPROVAL': {
        const promotionGate = ctx.toAir.approvalGates.find(gate => gate.when === 'BEFORE_PROMOTION')
        if (!promotionGate) throw new Error('AIR declares no BEFORE_PROMOTION gate')
        const existing = this.ledger.listApprovals(ctx.runId).find(approval => approval.gateId === promotionGate.id)
        if (!existing) {
          // Materialize the immutable pre-approval evidence pack; the approval
          // and promotion bind to exactly this digest.
          const evidenceCoreDigest = await this.materializeEvidenceCore(ctx)
          this.ledger.appendEvent(ctx.runId, 'EVIDENCE_READY', {
            evidenceVersion: 'evidence-v2',
            evidenceCoreDigest,
            artifactDir: join(this.projectRoot, 'artifacts', 'runs', ctx.runId),
          })
          const requested = this.ledger.requestApproval({ runId: ctx.runId, gateId: promotionGate.id })
          this.ledger.setRunStatus(ctx.runId, 'AWAITING_APPROVAL')
          this.ledger.setTaskStatus(ctx.runId, step.id, 'BLOCKED')
          completed.add(step.id)
          return 'suspend'
        }
        if (existing.decision === 'PENDING') {
          this.ledger.setRunStatus(ctx.runId, 'AWAITING_APPROVAL')
          this.ledger.setTaskStatus(ctx.runId, step.id, 'BLOCKED')
          completed.add(step.id)
          return 'suspend'
        }
        break
      }
      case 'PROMOTE': {
        const approval = this.ledger.listApprovals(ctx.runId).find(entry => entry.decision === 'APPROVED')
        if (!approval) throw new Error('promotion requires an approved gate')
        await promotePlanRun(this.projectRoot, this.ledger, ctx, approval.evidenceDigest ?? '')
        break
      }
      case 'REPLAY_ASSERT': {
        const projection = this.ledger.replayRun(ctx.runId)
        const effects = this.ledger.listEffects(ctx.runId)
        const keys = effects.map(effect => effect.idempotencyKey)
        const duplicates = keys.length - new Set(keys).size
        if (duplicates !== 0 || projection.status !== 'PROMOTED') {
          throw new Error(`replay assertion failed: duplicates=${duplicates} status=${projection.status}`)
        }
        this.ledger.appendEvent(ctx.runId, 'REPLAY_ASSERTED', {
          effectCount: keys.length, duplicates, status: projection.status,
        })
        break
      }
    }
    this.ledger.setTaskStatus(ctx.runId, step.id, 'SUCCEEDED')
    completed.add(step.id)
    return 'continue'
  }
}

function isScriptedDefectStep(plan: ArchitecturePlan, step: PlanStep): boolean {
  if (!plan.expectedInitialFailure) return false
  return step.id === plan.expectedInitialFailure.repairStepId
}

/**
 * Promote an executed plan run: bind the approval, evidence, AIR digest, and
 * candidate commit into a generic static workflow and durable promotion record.
 */
export async function promotePlanRun(
  projectRoot: string,
  ledger: KernlLedger,
  ctx: PlanRunContext,
  evidenceCoreDigest: string,
): Promise<PromotionResultV2> {
  const run = ledger.getRun(ctx.runId)
  const events = ledger.listEvents(ctx.runId)
  const verification = [...events].reverse().find(event => event.type === 'VERIFICATION_FINISHED')
  if (!verification) throw new Error('promotion requires a verification report')
  const report = verification.payload as { status: string; digest?: string; candidateCommit?: string }
  if (report.status !== 'passed' || !report.digest) throw new Error('promotion requires a passing verification digest')

  const approval = ledger.listApprovals(ctx.runId).find(entry => entry.decision === 'APPROVED')
  if (!approval) throw new Error('promotion requires an approved gate')
  const git = new GitWorkspaceManager(projectRoot)
  const head = await git.currentCommit(join(git.runRepositoryPath(ctx.runId), 'integration'))
  await git.assertClean(join(git.runRepositoryPath(ctx.runId),'integration'))
  if (head !== run.sourceCommit || head !== report.candidateCommit) throw new Error('promotion candidate differs from the exact verified Git commit')

  const writer = new EvidenceWriter(projectRoot, join('artifacts', 'runs', ctx.runId))
  await writer.initialize()
  const core = JSON.parse(await readFile(join(writer.outputDir, 'evidence-core.json'), 'utf8')) as {
    schemaVersion: string; runId: string; files: Array<{path: string; sha256: string; bytes: number}>; digest: string
  }
  const { digest: sealedDigest, ...sealed } = core
  if (digestJson(sealed) !== sealedDigest || sealedDigest !== evidenceCoreDigest || approval.evidenceDigest !== sealedDigest) {
    throw new Error('promotion evidence does not match the immutable approved core')
  }
  await writer.indexExisting()
  for (const file of core.files) {
    const actual = writer.entries().find(entry => entry.path === file.path)
    if (!actual || actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw new Error(`approved evidence changed: ${file.path}`)
  }
  const boundDigest = sealedDigest

  const workflow = (ledger.getPromotion(ctx.runId)?.workflow as PromotedWorkflowV2|undefined) ?? compilePromotedWorkflowV2({
    runId: ctx.runId,
    plan: ctx.plan,
    candidateCommit: run.sourceCommit,
    verificationDigest: report.digest,
    evidenceCoreDigest: boundDigest,
    approval: { actor: approval.actor ?? 'local-architect', decision: 'approved', createdAt: approval.decidedAt ?? approval.requestedAt },
    model: { adapter: ctx.agent?.provider ?? 'deterministic-recipe-v2', ...(ctx.agent ? {model:ctx.agent.model} : {}) },
    executionBindings:JSON.parse(await readFile(join(writer.outputDir,'execution-bindings.json'),'utf8')),
  })
  const promotion = ledger.getPromotion(ctx.runId) ?? ledger.recordPromotion({
    runId: ctx.runId,
    airDigest: run.airDigest,
    sourceCommit: run.sourceCommit,
    verificationDigest: report.digest,
    evidenceDigest: boundDigest,
    workflow,
  })
  ledger.appendEffectReceipt({
    runId: ctx.runId,
    episodeId: `${ctx.runId}:promotion`,
    componentId: 'architecture-control-plane',
    taskId: 'promote:workflow',
    effectType: 'WORKFLOW_PROMOTION',
    resourceIdentity: 'kernl/workflows',
    idempotencyKey: `${ctx.runId}:promote:workflow:${promotion.workflowDigest}`,
    preconditions: { airDigest: run.airDigest, sourceCommit: run.sourceCommit, verificationDigest: report.digest, evidenceCoreDigest: boundDigest },
    result: { promotionId: promotion.id, workflowDigest: promotion.workflowDigest },
    resultingState: 'PROMOTED',
    recoveryClassification: 'APPROVAL_GATED',
    recoveryMetadata: { approvalId: approval.id, actor: approval.actor },
    provenance: { planDigest: ctx.plan.digest },
  })

  const publicationKey='publication:evidence-v2'
  const publication=ledger.operation(ctx.runId,publicationKey)
  const snapshot=(publication?.intent??{events:ledger.listEvents(ctx.runId),effects:ledger.listEffects(ctx.runId)}) as {events:unknown[];effects:unknown[]}
  ledger.planOperation(ctx.runId,publicationKey,snapshot)
  await writer.json('approval.json', approval)
  await writer.json('promoted-workflow.json', workflow)
  await writer.json('promotion.json', promotion)
  await writer.jsonLines('events.jsonl', snapshot.events)
  await writer.json('effect-ledger.json', snapshot.effects)
  await writer.indexExisting()
  const manifest = await writer.manifest({
    schemaVersion: '2.0',
    runId: ctx.runId,
    planDigest: ctx.plan.digest,
    airDigest: run.airDigest,
    candidateCommit: run.sourceCommit,
    verificationDigest: report.digest,
    workflowDigest: promotion.workflowDigest,
    evidenceCoreDigest: boundDigest,
  },approval.decidedAt??approval.requestedAt)
  await writer.verifyFiles()

  const canonicalDir = join(projectRoot, 'artifacts', 'alpha-v2', `${ctx.plan.changeId}-${ctx.runId.slice(-8)}`)
  await mkdir(join(projectRoot, 'artifacts', 'alpha-v2'), { recursive: true })
  await cp(writer.outputDir, canonicalDir, { recursive: true })
  ledger.commitOperation(ctx.runId,publicationKey,{manifestDigest:manifest.digest,canonicalDir})
  ledger.appendEffectReceipt({
    runId: ctx.runId,
    episodeId: `${ctx.runId}:evidence`,
    componentId: 'verification-plane',
    taskId: 'promote:workflow',
    effectType: 'EVIDENCE_CANONICAL_PUBLISH',
    resourceIdentity: canonicalDir,
    idempotencyKey: `${ctx.runId}:evidence:publish`,
    preconditions: { manifestDigest: manifest.digest },
    result: { published: true, canonicalDir },
    resultingState: 'COMMITTED',
    recoveryClassification: 'REVERSIBLE',
    recoveryMetadata: { recovery: `republish from artifacts/runs/${ctx.runId}` },
    provenance: { planDigest: ctx.plan.digest },
  })
  ledger.setRunStatus(ctx.runId, 'PROMOTED')

  return {
    promotionId: promotion.id,
    workflowDigest: promotion.workflowDigest,
    workflow,
    evidenceManifestDigest: manifest.digest,
    artifactDir: canonicalDir,
  }
}

export function planRunCanonicalJson(value: unknown): string {
  return canonicalJson(value)
}

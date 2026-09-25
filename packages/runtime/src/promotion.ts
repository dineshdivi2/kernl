import { digestJson } from '@kernl/core'
import type { CompiledTaskDag } from '@kernl/core'

export interface PromotedWorkflowInput {
  runId: string
  dag: CompiledTaskDag
  candidateCommit: string
  verificationDigest: string
  evidenceVersion: string
  evidenceCoreDigest: string
  approval: { actor: string; decision: 'approved'; createdAt: string }
  model: { adapter: string; model?: string; dshSessionId?: string }
  lifecycleReplacement: {
    changeId: string
    componentId: string
    currentAirVersion: string
    currentAirDigest: string
    replacementAirVersion: string
    replacementAirDigest: string
  }
}

export interface PromotedWorkflow {
  schemaVersion: '1.0'
  workflowVersion: string
  name: 'sync-to-queued-worker'
  inputs: Record<string, { type: string; required: boolean }>
  outputs: Record<string, { type: string }>
  limits: {
    maximumAgents: number
    maximumParallelMutations: number
    maximumRepairAttempts: number
    maximumTasks: number
    maximumSteps: number
    maximumModelRequests: number
    maximumModelSpendUsd: number
    wallTimeSeconds: number
  }
  steps: Array<{
    id: string
    kind: string
    componentIds: string[]
    dependencies: string[]
    toolBinding: string
    writeScopes: string[]
    retries: number
    requiresApproval: boolean
    timeoutSeconds: number
    condition?: { gateFailureFingerprint: string }
  }>
  policies: {
    isolatedMutations: true
    testsReadOnlyToBuilders: true
    promotionRequiresApproval: true
    effectsRequireReceipts: true
  }
  assertions: string[]
  evaluationBaseline: {
    expectedInitialFailure: 'duplicate-event-effect'
    expectedRepairStepId: 'implement:worker'
    expectedRepairScope: string[]
    expectedFinalStatus: 'passed'
  }
  provenance: {
    runId: string
    changeId: string
    fromAirDigest: string
    toAirDigest: string
    dagDigest: string
    candidateCommit: string
    verificationDigest: string
    evidenceVersion: string
    evidenceCoreDigest: string
    lifecycleReplacement: PromotedWorkflowInput['lifecycleReplacement']
    approval: PromotedWorkflowInput['approval']
    agent: PromotedWorkflowInput['model']
  }
  /** Digest of every workflow field except this digest field. */
  contentDigest: string
}

export type PromotedWorkflowContent = Omit<PromotedWorkflow, 'contentDigest'>

/** Recomputable digest of the workflow's semantic content (no self-reference). */
export function workflowContentDigest(workflow: PromotedWorkflow | PromotedWorkflowContent): string {
  const { contentDigest: _contentDigest, ...content } = workflow as PromotedWorkflow
  return digestJson(content)
}

/** Digest of the exact serialized workflow value stored by the promotion ledger. */
export function workflowArtifactDigest(workflow: PromotedWorkflow): string {
  return digestJson(workflow)
}

export function workflowStepsFromDag(
  dag: CompiledTaskDag,
  lifecycleReplacement: PromotedWorkflowInput['lifecycleReplacement'],
): PromotedWorkflow['steps'] {
  const projected = dag.tasks.map(task => ({
    id: task.id,
    kind: task.kind,
    componentIds: task.componentIds,
    dependencies: task.dependsOn,
    toolBinding: task.deterministic ? `kernl.${task.kind.toLowerCase()}` : 'agent.implement_scoped_task',
    writeScopes: task.writeScopes,
    retries: task.kind === 'IMPLEMENT' || task.kind === 'REPAIR' ? task.maxAttempts - 1 : 0,
    requiresApproval: task.requiresApproval,
    timeoutSeconds: task.kind === 'IMPLEMENT' ? 60 : 30,
  }))
  const verificationIndex = projected.findIndex(step => step.kind === 'VERIFY')
  const worker = projected.find(step => step.kind === 'IMPLEMENT' && step.componentIds.includes('worker'))
  if (verificationIndex < 0 || !worker) throw new Error('sync-to-queued workflow requires verify and worker implementation steps')
  const verification = projected[verificationIndex]
  if (!verification) throw new Error('workflow verification step projection failed')
  const initialVerification = {
    ...verification,
    id: 'verify:initial-candidate',
    requiresApproval: false,
    timeoutSeconds: 60,
  }
  const repair = {
    id: 'repair:duplicate-event-effect',
    kind: 'REPAIR',
    componentIds: [...worker.componentIds],
    dependencies: [initialVerification.id],
    toolBinding: 'agent.repair_scoped_task',
    writeScopes: [...worker.writeScopes],
    retries: Math.max(0, worker.retries - 1),
    requiresApproval: false,
    timeoutSeconds: 60,
    condition: { gateFailureFingerprint: 'duplicate-event-effect' },
  }
  const finalVerification = { ...verification, dependencies: [repair.id], timeoutSeconds: 60 }
  const lifecycle = {
    id: `lifecycle:${lifecycleReplacement.changeId}`,
    kind: 'LIFECYCLE',
    componentIds: [lifecycleReplacement.componentId],
    dependencies: [finalVerification.id],
    toolBinding: 'kernl.lifecycle_replace',
    writeScopes: [],
    retries: 0,
    requiresApproval: false,
    timeoutSeconds: 30,
  }
  const tail = projected.slice(verificationIndex + 1).map(step => step.kind === 'APPROVAL'
    ? { ...step, dependencies: [lifecycle.id] }
    : step)
  return [
    ...projected.slice(0, verificationIndex),
    initialVerification,
    repair,
    finalVerification,
    lifecycle,
    ...tail,
  ]
}

export function compilePromotedWorkflow(input: PromotedWorkflowInput): PromotedWorkflow {
  const content: PromotedWorkflowContent = {
    schemaVersion: '1.0' as const,
    workflowVersion: `workflow-${input.dag.toAirVersion}`,
    name: 'sync-to-queued-worker' as const,
    inputs: {
      beforeAir: { type: 'AirDocument', required: true },
      afterAir: { type: 'AirDocument', required: true },
      replacementAir: { type: 'AirDocument', required: true },
      fixtureTemplate: { type: 'SourceTree', required: true },
    },
    outputs: {
      candidateCommit: { type: 'GitCommit' },
      verificationReport: { type: 'VerificationReport' },
      lifecycleReport: { type: 'LifecycleReplacementReport' },
      evidenceManifest: { type: 'EvidenceManifest' },
    },
    limits: {
      maximumAgents: 4,
      maximumParallelMutations: 2,
      maximumRepairAttempts: 3,
      maximumTasks: 12,
      maximumSteps: 20,
      maximumModelRequests: 6,
      maximumModelSpendUsd: 0,
      wallTimeSeconds: 300,
    },
    steps: workflowStepsFromDag(input.dag, input.lifecycleReplacement),
    policies: {
      isolatedMutations: true as const,
      testsReadOnlyToBuilders: true as const,
      promotionRequiresApproval: true as const,
      effectsRequireReceipts: true as const,
    },
    assertions: [
      'AIR bindings validate before model execution',
      'public HTTP contract and eventual result are preserved',
      'duplicate event delivery creates one worker effect',
      'no active consumer binds an inactive provider',
      'retiring providers accept no new bindings',
      'provider reliance is zero before inactivation',
      'all required gates pass before promotion',
    ],
    evaluationBaseline: {
      expectedInitialFailure: 'duplicate-event-effect' as const,
      expectedRepairStepId: 'implement:worker' as const,
      expectedRepairScope: ['src/worker.ts'],
      expectedFinalStatus: 'passed' as const,
    },
    provenance: {
      runId: input.runId,
      changeId: input.dag.changeId,
      fromAirDigest: input.dag.fromAirDigest,
      toAirDigest: input.dag.toAirDigest,
      dagDigest: input.dag.digest,
      candidateCommit: input.candidateCommit,
      verificationDigest: input.verificationDigest,
      evidenceVersion: input.evidenceVersion,
      evidenceCoreDigest: input.evidenceCoreDigest,
      lifecycleReplacement: input.lifecycleReplacement,
      approval: input.approval,
      agent: input.model,
    },
  }
  return { ...content, contentDigest: workflowContentDigest(content) }
}

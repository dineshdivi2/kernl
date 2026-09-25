import { digestJson } from '@kernl/core'
import type { ArchitecturePlan } from '@kernl/core'

export interface PromotedWorkflowV2Input {
  runId: string
  plan: ArchitecturePlan
  candidateCommit: string
  verificationDigest: string
  evidenceCoreDigest: string
  approval: { actor: string; decision: 'approved' | 'rejected'; createdAt: string }
  model: { adapter: string; model?: string; dshSessionId?: string }
  executionBindings?: {catalogDigest:string;sourceDigest:string;runtimeDigest:string}
}

/**
 * Generic promoted workflow (schema 2.0). Every field is derived from the
 * compiled plan, the run's durable facts, and provenance digests. The format
 * carries both supported architecture changes without scenario knowledge.
 */
export interface PromotedWorkflowV2 {
  schemaVersion: '2.0'
  workflowVersion: string
  name: string
  inputs: Record<string, { type: string; required: boolean }>
  outputs: Record<string, { type: string }>
  limits: ArchitecturePlan['budgets']
  steps: Array<{
    id: string
    type: string
    title: string
    componentIds: string[]
    dependencies: string[]
    toolBinding: string
    writeScopes: string[]
    requiredCapabilities: string[]
    catalogRefs: Array<{ type: string; id: string; version: string; recipe: string }>
    retries: number
    requiresApproval: boolean
    timeoutMs: number
    assertions: string[]
    repairCondition?: { fingerprint: string; scopeHint: string[] }
  }>
  policies: {
    isolatedMutations: true
    testsReadOnlyToBuilders: true
    promotionRequiresApproval: true
    effectsRequireReceipts: true
  }
  assertions: string[]
  evaluationBaseline: {
    expectedInitialFailure?: { fingerprint: string; repairStepId: string; repairScope: string[] }
    expectedFinalStatus: 'passed'
  }
  lifecycleOperations: Array<{ stepId: string; componentId: string; kind: 'PROVIDER_TRANSITION' }>
  recoveryBehaviour: {
    resumeFromPersistedState: true
    effectReceiptsIdempotent: true
    approvalSuspendsRun: true
    replayRequiresOnlyWorkflowInputs: true
  }
  provenance: {
    runId: string
    changeId: string
    planId: string
    planDigest: string
    fromAirVersion: string
    toAirVersion: string
    fromAirDigest: string
    toAirDigest: string
    candidateCommit: string
    verificationDigest: string
    evidenceVersion: 'evidence-v2'
    evidenceCoreDigest: string
    approval: PromotedWorkflowV2Input['approval']
    agent: PromotedWorkflowV2Input['model']
  }
  contentDigest: string
  executionBindings?: {catalogDigest:string;sourceDigest:string;runtimeDigest:string}
}

export type PromotedWorkflowV2Content = Omit<PromotedWorkflowV2, 'contentDigest'>

/** Digest of every workflow field except the self-referential digest. */
export function workflowContentDigestV2(workflow: PromotedWorkflowV2 | PromotedWorkflowV2Content): string {
  const { contentDigest: _omit, ...content } = workflow as PromotedWorkflowV2
  return digestJson(content)
}

/** Digest of the exact serialized promotion payload. */
export function workflowArtifactDigestV2(workflow: PromotedWorkflowV2): string {
  return digestJson(workflow)
}

const TOOL_BINDINGS: Record<string, string> = {
  VALIDATE_AIR: 'kernl.validate_air',
  GENERATE_COMPONENT: 'agent.implement_scoped_task',
  MODIFY_COMPONENT: 'agent.implement_scoped_task',
  UPDATE_BINDING: 'kernl.commit_bindings',
  UPDATE_CONTRACT: 'kernl.update_contracts',
  VERIFY_COMPONENT: 'kernl.verify_catalog_gates',
  VERIFY_SYSTEM: 'kernl.verify_system_gates',
  REPAIR: 'agent.repair_scoped_task',
  TRANSITION_PROVIDER: 'kernl.transition_provider',
  REQUEST_APPROVAL: 'kernl.request_approval',
  PROMOTE: 'kernl.promote_workflow',
  REPLAY_ASSERT: 'kernl.replay_assert',
}

export function compilePromotedWorkflowV2(input: PromotedWorkflowV2Input): PromotedWorkflowV2 {
  const plan = input.plan
  const steps = plan.steps.map(step => ({
    id: step.id,
    type: step.type,
    title: step.title,
    componentIds: [...step.componentIds],
    dependencies: [...step.dependsOn],
    toolBinding: TOOL_BINDINGS[step.type] ?? `kernl.${step.type.toLowerCase()}`,
    writeScopes: [...step.writeScopes],
    requiredCapabilities: [...step.requiredCapabilities],
    catalogRefs: step.catalogRefs.map(ref => ({ ...ref })),
    retries: IMPLEMENTING.has(step.type) ? Math.max(0, step.maxAttempts - 1) : 0,
    requiresApproval: step.requiresApproval,
    timeoutMs: step.timeoutMs,
    assertions: [...step.assertions],
    ...(step.repairCondition ? { repairCondition: { ...step.repairCondition } } : {}),
  }))
  const transitionSteps = plan.steps
    .filter(step => step.type === 'TRANSITION_PROVIDER')
    .map(step => ({
      stepId: step.id,
      componentId: step.componentIds[0] ?? '',
      kind: 'PROVIDER_TRANSITION' as const,
    }))
  const assertionSet = [...new Set(plan.steps.flatMap(step => step.assertions))]

  const content: PromotedWorkflowV2Content = {
    ...(input.executionBindings?{executionBindings:input.executionBindings}:{}),
    schemaVersion: '2.0',
    workflowVersion: `workflow-${plan.changeId}-${plan.toAir.version}`,
    name: plan.changeId,
    inputs: {
      beforeAir: { type: 'AirDocument', required: true },
      afterAir: { type: 'AirDocument', required: true },
      sourceTemplate: { type: 'SourceTree', required: true },
      catalogManifests: { type: 'Catalog', required: true },
    },
    outputs: {
      candidateCommit: { type: 'GitCommit' },
      verificationReport: { type: 'VerificationReport' },
      lifecycleSnapshots: { type: 'LifecycleSnapshot[]' },
      evidenceManifest: { type: 'EvidenceManifest' },
    },
    limits: { ...plan.budgets },
    steps,
    policies: {
      isolatedMutations: true,
      testsReadOnlyToBuilders: true,
      promotionRequiresApproval: true,
      effectsRequireReceipts: true,
    },
    assertions: assertionSet,
    evaluationBaseline: {
      ...(plan.expectedInitialFailure
        ? {
            expectedInitialFailure: {
              fingerprint: plan.expectedInitialFailure.fingerprint,
              repairStepId: plan.expectedInitialFailure.repairStepId,
              repairScope: [...plan.expectedInitialFailure.repairScope],
            },
          }
        : {}),
      expectedFinalStatus: 'passed',
    },
    lifecycleOperations: transitionSteps,
    recoveryBehaviour: {
      resumeFromPersistedState: true,
      effectReceiptsIdempotent: true,
      approvalSuspendsRun: true,
      replayRequiresOnlyWorkflowInputs: true,
    },
    provenance: {
      runId: input.runId,
      changeId: plan.changeId,
      planId: plan.planId,
      planDigest: plan.digest,
      fromAirVersion: plan.fromAir.version,
      toAirVersion: plan.toAir.version,
      fromAirDigest: plan.fromAir.digest,
      toAirDigest: plan.toAir.digest,
      candidateCommit: input.candidateCommit,
      verificationDigest: input.verificationDigest,
      evidenceVersion: 'evidence-v2',
      evidenceCoreDigest: input.evidenceCoreDigest,
      approval: { ...input.approval },
      agent: { ...input.model },
    },
  }
  return { ...content, contentDigest: workflowContentDigestV2(content) }
}

const IMPLEMENTING = new Set(['GENERATE_COMPONENT', 'MODIFY_COMPONENT', 'REPAIR'])

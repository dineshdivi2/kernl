import { z } from 'zod'
import { airDigest, type AirDocument } from './air.js'
import type { ComponentType, ParsedCatalog } from './catalog.js'
import { airKindToComponentType, resolveManifest } from './catalog.js'
import { digestJson } from './hashing.js'
import { semanticDiff, type AirSemanticDiff } from './diff.js'

/** Static step vocabulary. The executor knows these types and nothing else about scenarios. */
export const planStepTypes = [
  'VALIDATE_AIR',
  'GENERATE_COMPONENT',
  'MODIFY_COMPONENT',
  'UPDATE_BINDING',
  'UPDATE_CONTRACT',
  'VERIFY_COMPONENT',
  'VERIFY_SYSTEM',
  'REPAIR',
  'TRANSITION_PROVIDER',
  'REQUEST_APPROVAL',
  'PROMOTE',
  'REPLAY_ASSERT',
] as const

export type PlanStepType = (typeof planStepTypes)[number]

export const planStepSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(planStepTypes),
  title: z.string().min(1).max(200),
  componentIds: z.array(z.string().min(1)).default([]),
  dependsOn: z.array(z.string().min(1)).default([]),
  writeScopes: z.array(z.string().min(1)).default([]),
  /** Worker capability strings required to claim this step (e.g. task:implement). */
  requiredCapabilities: z.array(z.string().min(1)).default([]),
  catalogRefs: z.array(z.object({
    type: z.string().min(1),
    id: z.string().min(1),
    version: z.string().min(1),
    recipe: z.string().min(1).max(128),
  }).strict()).default([]),
  timeoutMs: z.number().int().positive().max(3_600_000),
  maxAttempts: z.number().int().positive().max(5),
  deterministic: z.boolean(),
  requiresApproval: z.boolean(),
  /** When set, the step runs only after a failing gate produced this fingerprint. */
  repairCondition: z.object({ fingerprint: z.string().min(1), scopeHint: z.array(z.string()).default([]) }).strict().optional(),
  assertions: z.array(z.string().min(1)).default([]),
}).strict()

export type PlanStep = z.infer<typeof planStepSchema>

export const planBudgetsSchema = z.object({
  maximumTasks: z.number().int().positive().max(64).default(12),
  maximumSteps: z.number().int().positive().max(64).default(20),
  maximumParallelMutations: z.number().int().positive().max(2).default(2),
  maximumRepairAttempts: z.number().int().positive().max(3).default(3),
  maximumModelRequests: z.number().int().nonnegative().max(100).default(10),
  /** Configurable model-spend ceiling in USD; deterministic mode pins this to 0. */
  maximumModelSpendUsd: z.number().nonnegative().default(0),
  wallTimeSeconds: z.number().int().positive().max(86_400).default(900),
}).strict()

export type PlanBudgets = z.infer<typeof planBudgetsSchema>

export const architecturePlanSchema = z.object({
  schemaVersion: z.literal('2.0'),
  planId: z.string().min(1).max(160),
  changeId: z.string().min(1).max(128),
  fromAir: z.object({ version: z.string(), digest: z.string() }).strict(),
  toAir: z.object({ version: z.string(), digest: z.string() }).strict(),
  directlyAffectedNodeIds: z.array(z.string()).default([]),
  affectedNodeIds: z.array(z.string()).default([]),
  steps: z.array(planStepSchema).min(1),
  parallelGroups: z.array(z.array(z.string())).default([]),
  budgets: planBudgetsSchema,
  /** Expected first-failure fingerprint used by deterministic acceptance and repair drills. */
  expectedInitialFailure: z.object({
    fingerprint: z.string().min(1),
    repairStepId: z.string().min(1),
    repairScope: z.array(z.string()).min(1),
  }).strict().optional(),
  digest: z.string(),
}).strict()

export type ArchitecturePlan = z.infer<typeof architecturePlanSchema>
export type PlanBudgetOverrides = Partial<PlanBudgets>

export class PlanValidationError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`Architecture plan validation failed: ${issues.join('; ')}`)
    this.name = 'PlanValidationError'
    this.issues = issues
  }
}

function validateSteps(steps: readonly PlanStep[]): string[] {
  const issues: string[] = []
  const ids = new Set(steps.map(step => step.id))
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) issues.push(`${step.id} depends on missing step ${dependency}`)
      if (dependency === step.id) issues.push(`${step.id} depends on itself`)
    }
  }
  // Cycle detection.
  const permanent = new Set<string>()
  const visiting = new Set<string>()
  const visit = (id: string): void => {
    if (permanent.has(id)) return
    if (visiting.has(id)) {
      issues.push(`cycle detected at ${id}`)
      return
    }
    visiting.add(id)
    for (const dependency of steps.find(step => step.id === id)?.dependsOn ?? []) visit(dependency)
    visiting.delete(id)
    permanent.add(id)
  }
  for (const step of steps) visit(step.id)
  return [...new Set(issues)]
}

function parallelGroups(steps: readonly PlanStep[], maximumParallel: number): string[][] {
  const remaining = new Map(steps.map(step => [step.id, step]))
  const complete = new Set<string>()
  const groups: string[][] = []
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter(step => step.dependsOn.every(dependency => complete.has(dependency)))
      .sort((left, right) => left.id.localeCompare(right.id))
    if (ready.length === 0) throw new PlanValidationError(['plan steps contain a cycle'])
    for (let index = 0; index < ready.length; index += maximumParallel) {
      const group = ready.slice(index, index + maximumParallel).map(step => step.id)
      groups.push(group)
      for (const stepId of group) {
        remaining.delete(stepId)
        complete.add(stepId)
      }
    }
  }
  return groups
}

interface RecipeRef {
  type: string
  id: string
  version: string
  recipe: string
}

function manifestRef(catalog: ParsedCatalog | undefined, kind: string, componentId: string, version: string): RecipeRef | undefined {
  const type = airKindToComponentType(kind)
  if (!type || !catalog) return undefined
  const direct = resolveManifest(catalog, type, componentId, version)
  const manifest = direct ?? [...catalog.byTypeVersion.values()].find(candidate =>
    candidate.component.type === type && candidate.component.version === version)
  if (!manifest) return undefined
  return { type: manifest.component.type, id: manifest.component.id, version: manifest.component.version, recipe: manifest.generation.template }
}

/**
 * Deterministically derive a typed execution plan from two validated AIR
 * versions plus the catalog. The compiler never sees component names — it
 * works purely from semantic differences, manifests, and declared policies.
 */
export function compileArchitecturePlan(
  fromAir: AirDocument,
  toAir: AirDocument,
  options: { budgets?: PlanBudgetOverrides; catalog?: ParsedCatalog; expectedInitialFailure?: ArchitecturePlan['expectedInitialFailure']; planId?: string } = {},
): ArchitecturePlan {
  const diff: AirSemanticDiff = semanticDiff(fromAir, toAir)
  if (diff.empty) throw new PlanValidationError(['AIR change is empty'])

  const budgets = planBudgetsSchema.parse(options.budgets ?? {})
  const steps: PlanStep[] = []
  const catalog = options.catalog

  steps.push({
    id: 'validate:air-change',
    type: 'VALIDATE_AIR',
    title: 'Validate architecture change against schema, bindings, and catalog',
    componentIds: diff.directlyAffectedComponentIds,
    dependsOn: [],
    writeScopes: [],
    requiredCapabilities: [],
    catalogRefs: [],
    timeoutMs: 30_000,
    maxAttempts: 1,
    deterministic: true,
    requiresApproval: false,
    assertions: ['air-schema-valid', 'bindings-compatible', 'lifecycle-policies-declared'],
  })

  const implementationDeps: string[] = []
  const verifyComponentIds: string[] = []

  const lookupFrom = new Map(fromAir.components.map(component => [component.id, component]))
  const lookupTo = new Map(toAir.components.map(component => [component.id, component]))

  const added = diff.components.added.map(component => component.id)
  const removed = new Set(diff.components.removed.map(component => component.id))
  const changed = diff.directlyAffectedComponentIds.filter(id => !added.includes(id) && !removed.has(id))

  for (const componentId of added) {
    const component = lookupTo.get(componentId)
    if (!component) continue
    const ref = manifestRef(catalog, component.kind, componentId, component.version)
    steps.push({
      id: `generate:${componentId}`,
      type: 'GENERATE_COMPONENT',
      title: `Generate ${componentId} from catalog recipe`,
      componentIds: [componentId],
      dependsOn: ['validate:air-change'],
      writeScopes: [...component.writeScopes],
      requiredCapabilities: ['task:implement'],
      catalogRefs: ref ? [ref] : [],
      timeoutMs: 60_000,
      maxAttempts: budgets.maximumRepairAttempts + 1,
      deterministic: false,
      requiresApproval: false,
      assertions: ['generated-source-matches-recipe', 'write-scopes-respected'],
    })
    implementationDeps.push(`generate:${componentId}`)
    verifyComponentIds.push(componentId)
  }

  for (const componentId of changed) {
    const component = lookupTo.get(componentId)
    if (!component) continue
    const ref = manifestRef(catalog, component.kind, componentId, component.version)
    steps.push({
      id: `modify:${componentId}`,
      type: 'MODIFY_COMPONENT',
      title: `Modify ${componentId} for the architecture change`,
      componentIds: [componentId],
      dependsOn: ['validate:air-change'],
      writeScopes: [...component.writeScopes],
      requiredCapabilities: ['task:implement'],
      catalogRefs: ref ? [ref] : [],
      timeoutMs: 60_000,
      maxAttempts: budgets.maximumRepairAttempts + 1,
      deterministic: false,
      requiresApproval: false,
      assertions: ['modification-limited-to-write-scopes', 'public-contracts-preserved'],
    })
    implementationDeps.push(`modify:${componentId}`)
    verifyComponentIds.push(componentId)
  }

  // Binding updates are deterministic ledger/graph operations ordered after implementations.
  const bindingChanges = diff.bindings.added.length + diff.bindings.removed.length + diff.bindings.changed.length
  if (bindingChanges > 0) {
    const bindingTouched = new Set<string>()
    for (const binding of diff.bindings.added) {
      bindingTouched.add(binding.consumerId)
      bindingTouched.add(binding.providerId)
    }
    for (const binding of diff.bindings.removed) {
      bindingTouched.add(binding.consumerId)
      bindingTouched.add(binding.providerId)
    }
    for (const change of diff.bindings.changed) {
      if (change.before) {
        bindingTouched.add(change.before.consumerId)
        bindingTouched.add(change.before.providerId)
      }
      if (change.after) {
        bindingTouched.add(change.after.consumerId)
        bindingTouched.add(change.after.providerId)
      }
    }
    steps.push({
      id: 'update:bindings',
      type: 'UPDATE_BINDING',
      title: 'Commit consumer rebinding changes',
      componentIds: [...bindingTouched].filter(id => !removed.has(id)).sort(),
      dependsOn: implementationDeps.length > 0 ? [...implementationDeps] : ['validate:air-change'],
      writeScopes: [],
      requiredCapabilities: [],
      catalogRefs: [],
      timeoutMs: 30_000,
      maxAttempts: 1,
      deterministic: true,
      requiresApproval: false,
      assertions: ['one-committed-binding-per-requirement'],
    })
  }

  if (diff.contracts.added.length + diff.contracts.removed.length + diff.contracts.changed.length > 0) {
    steps.push({
      id: 'update:contracts',
      type: 'UPDATE_CONTRACT',
      title: 'Apply contract set changes',
      componentIds: diff.directlyAffectedComponentIds,
      dependsOn: implementationDeps.length > 0 ? [...implementationDeps] : ['validate:air-change'],
      writeScopes: [],
      requiredCapabilities: [],
      catalogRefs: [],
      timeoutMs: 30_000,
      maxAttempts: 1,
      deterministic: true,
      requiresApproval: false,
      assertions: ['contract-versions-immutable'],
    })
  }

  // Provider transitions: only for providers whose catalog manifest declares
  // a runtime `provider.replace` effect — code-component version bumps stay
  // MODIFY steps. Identity persists while the version changes.
  const transitions: string[] = []
  for (const changedEntry of diff.components.changed) {
    const before = lookupFrom.get(changedEntry.id)
    const target = lookupTo.get(changedEntry.id)
    if (!before || !target) continue
    const typeBefore = airKindToComponentType(before.kind)
    const typeAfter = airKindToComponentType(target.kind)
    if (!typeBefore || typeBefore !== typeAfter) continue
    if (before.version === target.version) continue
    const refAfter = manifestRef(catalog, target.kind, target.id ?? changedEntry.id, target.version)
    const targetManifest = refAfter && catalog
      ? [...catalog.byTypeVersion.values()].find(candidate =>
          candidate.component.type === refAfter.type
          && candidate.component.id === refAfter.id
          && candidate.component.version === refAfter.version)
      : undefined
    if (!targetManifest?.effects.some(effect => effect.effectType === 'provider.replace')) continue
    const stepId = `transition:${changedEntry.id}:${before.version}-to-${target.version}`
    steps.push({
      id: stepId,
      type: 'TRANSITION_PROVIDER',
      title: `Replace ${changedEntry.id} ${before.version} with ${target.version} through the drain lifecycle`,
      componentIds: [changedEntry.id],
      dependsOn: ['update:bindings'],
      writeScopes: [],
      requiredCapabilities: [],
      catalogRefs: refAfter ? [refAfter] : [],
      timeoutMs: Math.max(before.lifecycle.drainTimeoutMs + 30_000, 60_000),
      maxAttempts: 1,
      deterministic: true,
      requiresApproval: false,
      assertions: [
        'retiring-provider-rejects-new-bindings',
        'consumers-rebind-exactly-once',
        'reliance-reaches-zero-before-inactive',
        'cleanup-receipt-committed',
      ],
    })
    transitions.push(stepId)
  }

  const postImplementationGate = transitions.length > 0 ? transitions : (steps.some(step => step.type === 'UPDATE_BINDING') ? ['update:bindings'] : (implementationDeps.length > 0 ? [...implementationDeps] : ['validate:air-change']))

  for (const componentId of [...verifyComponentIds].sort()) {
    const component = lookupTo.get(componentId)
    if (!component) continue
    const ref = manifestRef(catalog, component.kind, componentId, component.version)
    steps.push({
      id: `verify:${componentId}`,
      type: 'VERIFY_COMPONENT',
      title: `Run catalog gates for ${componentId}`,
      componentIds: [componentId],
      dependsOn: [...postImplementationGate],
      writeScopes: [],
      requiredCapabilities: [],
      catalogRefs: ref ? [ref] : [],
      timeoutMs: 120_000,
      maxAttempts: 1,
      deterministic: true,
      requiresApproval: false,
      assertions: ['component-gates-green'],
    })
  }

  steps.push({
    id: 'verify:system',
    type: 'VERIFY_SYSTEM',
    title: 'Run whole-system deterministic gates',
    componentIds: diff.affectedComponentIds,
    dependsOn: [...new Set([...steps.filter(step => step.type === 'VERIFY_COMPONENT').map(step => step.id), ...(transitions.length > 0 ? transitions : [])])],
    writeScopes: [],
    requiredCapabilities: [],
    catalogRefs: [],
    timeoutMs: 180_000,
    maxAttempts: 1,
    deterministic: true,
    requiresApproval: false,
    assertions: ['all-required-gates-pass', 'secret-scan-clean', 'evidence-complete'],
  })
  if (options.expectedInitialFailure && !transitions.length) {
    // The system verify step is where the deliberate candidate failure surfaces.
  }

  steps.push({
    id: 'approval:promotion',
    type: 'REQUEST_APPROVAL',
    title: 'Architect reviews impact, diffs, contracts, and evidence',
    componentIds: diff.affectedComponentIds,
    dependsOn: ['verify:system'],
    writeScopes: [],
    requiredCapabilities: [],
    catalogRefs: [],
    timeoutMs: 3_600_000,
    maxAttempts: 1,
    deterministic: true,
    requiresApproval: true,
    assertions: ['approval-bound-to-evidence-core-digest'],
  })

  steps.push({
    id: 'promote:workflow',
    type: 'PROMOTE',
    title: 'Promote the exact versioned workflow',
    componentIds: diff.affectedComponentIds,
    dependsOn: ['approval:promotion'],
    writeScopes: [],
    requiredCapabilities: [],
    catalogRefs: [],
    timeoutMs: 60_000,
    maxAttempts: 1,
    deterministic: true,
    requiresApproval: false,
    assertions: ['promotion-binds-air-git-verification-digests'],
  })

  steps.push({
    id: 'replay:assert',
    type: 'REPLAY_ASSERT',
    title: 'Assert replay determinism and effect non-duplication',
    componentIds: diff.affectedComponentIds,
    dependsOn: ['promote:workflow'],
    writeScopes: [],
    requiredCapabilities: [],
    catalogRefs: [],
    timeoutMs: 300_000,
    maxAttempts: 1,
    deterministic: true,
    requiresApproval: false,
    assertions: ['no-duplicate-effects', 'replay-without-original-conversation'],
  })

  const stepIssues = validateSteps(steps)
  if (stepIssues.length > 0) throw new PlanValidationError(stepIssues)

  const mutating = steps.filter(step => step.writeScopes.length > 0)
  if (mutating.length > budgets.maximumTasks) throw new PlanValidationError([`plan exceeds maximumTasks=${budgets.maximumTasks}`])
  if (steps.length > budgets.maximumSteps) throw new PlanValidationError([`plan exceeds maximumSteps=${budgets.maximumSteps}`])

  const content = {
    schemaVersion: '2.0' as const,
    planId: options.planId ?? `plan:${toAir.change.id}:${toAir.airVersion}`,
    changeId: toAir.change.id,
    fromAir: { version: fromAir.airVersion, digest: airDigest(fromAir) },
    toAir: { version: toAir.airVersion, digest: airDigest(toAir) },
    directlyAffectedNodeIds: diff.directlyAffectedComponentIds,
    affectedNodeIds: diff.affectedComponentIds,
    steps,
    parallelGroups: [] as string[][],
    budgets,
    ...(options.expectedInitialFailure ? { expectedInitialFailure: options.expectedInitialFailure } : {}),
  }
  const withGroups: ArchitecturePlan = { ...content, parallelGroups: parallelGroups(steps, budgets.maximumParallelMutations), digest: '' }
  return { ...withGroups, digest: digestJson(withGroups) }
}

/** Insert the standard scoped-repair step template for a failing component. */
export function repairStepFor(failedVerifyStepId: string, componentId: string, writeScopes: readonly string[], fingerprint: string, attempt: number): PlanStep {
  if (attempt < 1 || attempt > 3) throw new RangeError('repair attempt must be between 1 and 3')
  return {
    id: `repair:${failedVerifyStepId}:${attempt}`,
    type: 'REPAIR',
    title: `Scoped repair of ${componentId} after ${fingerprint}`,
    componentIds: [componentId],
    dependsOn: [failedVerifyStepId],
    writeScopes: [...writeScopes],
    requiredCapabilities: ['task:repair'],
    catalogRefs: [],
    timeoutMs: 60_000,
    maxAttempts: 1,
    deterministic: false,
    requiresApproval: false,
    repairCondition: { fingerprint, scopeHint: [...writeScopes] },
    assertions: ['repair-limited-to-authorized-scope'],
  }
}

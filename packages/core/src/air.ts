import { isAbsolute, normalize, sep } from 'node:path'
import { z } from 'zod'
import { canonicalJson, digestJson } from './hashing.js'

const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const versionSchema = z.string().min(1).max(64)
const relativePathSchema = z.string().min(1).max(512)

export const recoveryClassificationSchema = z.enum([
  'REVERSIBLE',
  'COMPENSATABLE',
  'RETRY_SAFE',
  'APPROVAL_GATED',
  'IRREVERSIBLE',
])

export const lifecycleStateSchema = z.enum([
  'PENDING',
  'LOADING',
  'ACTIVE',
  'RETIRING',
  'DRAINING',
  'INACTIVE',
  'FAILED',
])

export const capabilitySchema = z.object({
  id: idSchema,
  capability: idSchema,
  version: versionSchema,
  contract: idSchema.optional(),
}).strict()

export const requirementSchema = capabilitySchema.extend({
  optional: z.boolean().default(false),
}).strict()

export const lifecyclePolicySchema = z.object({
  initialState: lifecycleStateSchema.default('PENDING'),
  replacement: z.enum(['DRAIN_THEN_REPLACE', 'REPLACE_THEN_DRAIN', 'MANUAL']).default('DRAIN_THEN_REPLACE'),
  drainTimeoutMs: z.number().int().positive().max(86_400_000).default(30_000),
  requireCleanup: z.boolean().default(true),
}).strict()

export const componentSchema = z.object({
  id: idSchema,
  version: versionSchema,
  kind: z.enum(['API', 'WORKER', 'QUEUE', 'STORE', 'SERVICE', 'ADAPTER']),
  sourcePath: relativePathSchema,
  writeScopes: z.array(relativePathSchema).min(1),
  provides: z.array(capabilitySchema).default([]),
  requires: z.array(requirementSchema).default([]),
  lifecycle: lifecyclePolicySchema,
}).strict()

export const bindingSchema = z.object({
  id: idSchema,
  consumerId: idSchema,
  requirementId: idSchema,
  providerId: idSchema,
  capabilityId: idSchema,
  providerVersion: versionSchema,
}).strict()

export const contractSchema = z.object({
  id: idSchema,
  kind: z.enum(['API', 'EVENT', 'DATA', 'TOOL']),
  version: versionSchema,
  schema: z.record(z.string(), z.unknown()).default({}),
}).strict()

export const verificationGateSchema = z.object({
  id: idSchema,
  command: z.string().min(1),
  required: z.boolean().default(true),
  timeoutMs: z.number().int().positive().max(3_600_000).default(60_000),
}).strict()

export const approvalGateSchema = z.object({
  id: idSchema,
  when: z.enum(['BEFORE_MUTATION', 'BEFORE_EXTERNAL_EFFECT', 'BEFORE_PROMOTION']),
  requiredRole: z.string().min(1).default('architect'),
}).strict()

export const declaredEffectSchema = z.object({
  id: idSchema,
  componentId: idSchema,
  effectType: idSchema,
  resource: z.string().min(1),
  recovery: recoveryClassificationSchema,
  approvalGateId: idSchema.optional(),
}).strict()

export const airDocumentSchema = z.object({
  schemaVersion: z.literal('1.0'),
  system: z.object({
    id: idSchema,
    version: versionSchema,
  }).strict(),
  airVersion: versionSchema,
  components: z.array(componentSchema).min(1),
  bindings: z.array(bindingSchema).default([]),
  contracts: z.array(contractSchema).default([]),
  verification: z.object({
    gates: z.array(verificationGateSchema).min(1),
  }).strict(),
  effects: z.array(declaredEffectSchema).default([]),
  approvalGates: z.array(approvalGateSchema).default([]),
  change: z.object({
    id: idSchema,
    intent: z.string().min(1).max(2_000),
    parentAirVersion: versionSchema.optional(),
    requestedBy: z.string().min(1).optional(),
  }).strict(),
  provenance: z.object({
    changeId: idSchema,
    parentAirDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    sourceCommit: z.string().min(7).max(128).optional(),
  }).strict(),
}).strict()

export type RecoveryClassification = z.infer<typeof recoveryClassificationSchema>
export type LifecycleStateName = z.infer<typeof lifecycleStateSchema>
export type AirCapability = z.infer<typeof capabilitySchema>
export type AirRequirement = z.infer<typeof requirementSchema>
export type AirComponent = z.infer<typeof componentSchema>
export type AirBinding = z.infer<typeof bindingSchema>
export type AirContract = z.infer<typeof contractSchema>
export type AirDocument = z.infer<typeof airDocumentSchema>

export interface AirValidationIssue {
  code: string
  path: string
  message: string
}

export class AirValidationError extends Error {
  readonly issues: readonly AirValidationIssue[]

  constructor(issues: readonly AirValidationIssue[]) {
    super(`AIR validation failed with ${issues.length} issue${issues.length === 1 ? '' : 's'}`)
    this.name = 'AirValidationError'
    this.issues = issues
  }
}

function addDuplicateIssues<T extends { id: string }>(items: readonly T[], path: string, issues: AirValidationIssue[]): void {
  const seen = new Set<string>()
  for (const [index, item] of items.entries()) {
    if (seen.has(item.id)) {
      issues.push({ code: 'DUPLICATE_ID', path: `${path}.${index}.id`, message: `Duplicate id ${item.id}` })
    }
    seen.add(item.id)
  }
}

function hasPathTraversal(path: string): boolean {
  const normalized = normalize(path)
  return isAbsolute(path) || normalized === '..' || normalized.startsWith(`..${sep}`)
}

function capabilityKey(capability: Pick<AirCapability, 'capability' | 'version'>): string {
  return `${capability.capability}@${capability.version}`
}

export function validateAirSemantics(air: AirDocument): AirValidationIssue[] {
  const issues: AirValidationIssue[] = []
  addDuplicateIssues(air.components, 'components', issues)
  addDuplicateIssues(air.bindings, 'bindings', issues)
  addDuplicateIssues(air.contracts, 'contracts', issues)
  addDuplicateIssues(air.effects, 'effects', issues)
  addDuplicateIssues(air.approvalGates, 'approvalGates', issues)
  addDuplicateIssues(air.verification.gates, 'verification.gates', issues)

  const components = new Map(air.components.map((component) => [component.id, component]))
  const contracts = new Set(air.contracts.map((contract) => contract.id))
  const approvals = new Set(air.approvalGates.map((gate) => gate.id))

  for (const [componentIndex, component] of air.components.entries()) {
    addDuplicateIssues(component.provides, `components.${componentIndex}.provides`, issues)
    addDuplicateIssues(component.requires, `components.${componentIndex}.requires`, issues)

    if (hasPathTraversal(component.sourcePath)) {
      issues.push({ code: 'UNSAFE_SOURCE_PATH', path: `components.${componentIndex}.sourcePath`, message: 'Source path must remain inside the repository' })
    }

    for (const [scopeIndex, scope] of component.writeScopes.entries()) {
      if (hasPathTraversal(scope)) {
        issues.push({ code: 'UNSAFE_WRITE_SCOPE', path: `components.${componentIndex}.writeScopes.${scopeIndex}`, message: 'Write scope must remain inside the repository' })
      }
    }

    const provided = new Set<string>()
    for (const [provideIndex, capability] of component.provides.entries()) {
      const key = capabilityKey(capability)
      if (provided.has(key)) {
        issues.push({ code: 'DUPLICATE_CAPABILITY', path: `components.${componentIndex}.provides.${provideIndex}`, message: `Capability ${key} is declared more than once` })
      }
      provided.add(key)
      if (capability.contract && !contracts.has(capability.contract)) {
        issues.push({ code: 'UNKNOWN_CONTRACT', path: `components.${componentIndex}.provides.${provideIndex}.contract`, message: `Contract ${capability.contract} does not exist` })
      }
    }

    for (const [requireIndex, requirement] of component.requires.entries()) {
      if (requirement.contract && !contracts.has(requirement.contract)) {
        issues.push({ code: 'UNKNOWN_CONTRACT', path: `components.${componentIndex}.requires.${requireIndex}.contract`, message: `Contract ${requirement.contract} does not exist` })
      }
    }
  }

  const bindingCount = new Map<string, number>()
  for (const [bindingIndex, binding] of air.bindings.entries()) {
    const consumer = components.get(binding.consumerId)
    const provider = components.get(binding.providerId)
    const bindingPath = `bindings.${bindingIndex}`

    if (!consumer) {
      issues.push({ code: 'UNKNOWN_CONSUMER', path: `${bindingPath}.consumerId`, message: `Consumer ${binding.consumerId} does not exist` })
    }
    if (!provider) {
      issues.push({ code: 'UNKNOWN_PROVIDER', path: `${bindingPath}.providerId`, message: `Provider ${binding.providerId} does not exist` })
    }
    if (!consumer || !provider) continue

    const requirement = consumer.requires.find((candidate) => candidate.id === binding.requirementId)
    if (!requirement) {
      issues.push({ code: 'UNKNOWN_REQUIREMENT', path: `${bindingPath}.requirementId`, message: `Requirement ${binding.requirementId} is not declared by ${consumer.id}` })
      continue
    }

    const exactKey = `${consumer.id}:${requirement.id}`
    bindingCount.set(exactKey, (bindingCount.get(exactKey) ?? 0) + 1)

    if (requirement.capability !== binding.capabilityId) {
      issues.push({ code: 'BINDING_CAPABILITY_MISMATCH', path: `${bindingPath}.capabilityId`, message: `Binding capability ${binding.capabilityId} does not match requirement ${requirement.capability}` })
    }
    if (provider.version !== binding.providerVersion) {
      issues.push({ code: 'PROVIDER_VERSION_MISMATCH', path: `${bindingPath}.providerVersion`, message: `Binding requires exact provider ${provider.id}@${binding.providerVersion}, found ${provider.version}` })
    }

    const capability = provider.provides.find((candidate) => candidate.capability === requirement.capability && candidate.version === requirement.version)
    if (!capability) {
      issues.push({ code: 'UNSATISFIED_CAPABILITY', path: `${bindingPath}.providerId`, message: `${provider.id} does not provide ${binding.capabilityId}@${requirement.version}` })
    } else if ((capability.contract ?? null) !== (requirement.contract ?? null)) {
      issues.push({ code: 'CONTRACT_MISMATCH', path: `${bindingPath}.providerId`, message: `Provider and consumer contracts do not match for ${binding.capabilityId}` })
    }
  }

  for (const [componentIndex, component] of air.components.entries()) {
    for (const [requireIndex, requirement] of component.requires.entries()) {
      const count = bindingCount.get(`${component.id}:${requirement.id}`) ?? 0
      if (!requirement.optional && count === 0) {
        issues.push({ code: 'MISSING_BINDING', path: `components.${componentIndex}.requires.${requireIndex}`, message: `Required capability ${requirement.capability}@${requirement.version} is unbound` })
      }
      if (count > 1) {
        issues.push({ code: 'AMBIGUOUS_BINDING', path: `components.${componentIndex}.requires.${requireIndex}`, message: `Requirement ${requirement.id} has ${count} exact bindings` })
      }
    }
  }

  for (const [effectIndex, effect] of air.effects.entries()) {
    if (!components.has(effect.componentId)) {
      issues.push({ code: 'UNKNOWN_EFFECT_COMPONENT', path: `effects.${effectIndex}.componentId`, message: `Component ${effect.componentId} does not exist` })
    }
    if (effect.approvalGateId && !approvals.has(effect.approvalGateId)) {
      issues.push({ code: 'UNKNOWN_APPROVAL_GATE', path: `effects.${effectIndex}.approvalGateId`, message: `Approval gate ${effect.approvalGateId} does not exist` })
    }
    if ((effect.recovery === 'APPROVAL_GATED' || effect.recovery === 'IRREVERSIBLE') && !effect.approvalGateId) {
      issues.push({ code: 'APPROVAL_REQUIRED', path: `effects.${effectIndex}.approvalGateId`, message: `${effect.recovery} effects require an approval gate` })
    }
  }

  if (air.change.id !== air.provenance.changeId) {
    issues.push({ code: 'PROVENANCE_CHANGE_MISMATCH', path: 'provenance.changeId', message: 'Provenance must reference the exact architecture change' })
  }

  return issues
}

function zodIssues(error: z.ZodError): AirValidationIssue[] {
  return error.issues.map((issue) => ({
    code: `SCHEMA_${issue.code.toUpperCase()}`,
    path: issue.path.join('.'),
    message: issue.message,
  }))
}

export type AirValidationResult =
  | { success: true; data: AirDocument; digest: string }
  | { success: false; issues: AirValidationIssue[] }

export function validateAir(input: unknown): AirValidationResult {
  const parsed = airDocumentSchema.safeParse(input)
  if (!parsed.success) return { success: false, issues: zodIssues(parsed.error) }
  const issues = validateAirSemantics(parsed.data)
  if (issues.length > 0) return { success: false, issues }
  return { success: true, data: parsed.data, digest: airDigest(parsed.data) }
}

export function parseAir(input: unknown): AirDocument {
  const result = validateAir(input)
  if (!result.success) throw new AirValidationError(result.issues)
  return result.data
}

export function airDigest(air: AirDocument): string {
  return digestJson(air)
}

export function serializeAir(air: AirDocument): string {
  return canonicalJson(air)
}

import { z } from 'zod'
import {
  approvalGateSchema,
  capabilitySchema,
  contractSchema,
  declaredEffectSchema,
  lifecyclePolicySchema,
  requirementSchema,
  type AirDocument,
} from './air.js'
import { canonicalJson, digestJson } from './hashing.js'

export const componentTypeSchema = z.enum(['HTTP_API', 'WORKER', 'QUEUE', 'STORE', 'POLICY', 'FAILURE_SINK'])
export type ComponentType = z.infer<typeof componentTypeSchema>

export const catalogCapabilitySchema = capabilitySchema
export const catalogRequirementSchema = requirementSchema

/**
 * A binding rule states with which component types a capability may be
 * produced or consumed. The catalog — not the model and not the UI — is the
 * authority on whether a typed connection is allowed.
 */
export const bindingRuleSchema = z.object({
  capability: z.string().min(1).max(128),
  role: z.enum(['PROVIDES', 'REQUIRES']),
  withComponentTypes: z.array(componentTypeSchema).min(1),
  contracts: z.array(z.string().min(1)).default([]),
}).strict()

export const sourceFileSchema = z.object({
  path: z.string().min(1).max(256),
  purpose: z.enum(['entry', 'contract', 'implementation', 'test', 'config']),
}).strict()

export const generationRecipeSchema = z.object({
  /** Registry key resolved by the runtime; recipes stay deterministic and offline. */
  template: z.string().min(1).max(128),
  /** Deterministic template inputs. Values must be JSON-serializable. */
  inputs: z.record(z.string(), z.unknown()).default({}),
  /** Files the recipe fully generates on ADD. */
  generates: z.array(sourceFileSchema).default([]),
  /** Files the recipe deterministically rewrites on UPDATE. */
  modifies: z.array(sourceFileSchema).default([]),
}).strict()

export const catalogGateSchema = z.object({
  id: z.string().min(1).max(128),
  command: z.string().min(1).max(512),
  required: z.boolean().default(true),
  timeoutMs: z.number().int().positive().max(3_600_000).default(60_000),
}).strict()

export const replacementPolicySchema = z.object({
  /** Versions this manifest may replace in place (same component id, newer version). */
  supersedes: z.array(z.string().min(1)).default([]),
  /** Consumers may rebind without code changes when contracts are identical. */
  transparentRebind: z.boolean().default(true),
  /** Replacement must run the declared lifecycle drain policy. */
  requiresDrain: z.boolean().default(true),
}).strict()

export const catalogManifestSchema = z.object({
  schemaVersion: z.literal('1.0'),
  component: z.object({
    id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    type: componentTypeSchema,
    version: z.string().min(1).max(64),
    description: z.string().max(2_000).default(''),
  }).strict(),
  provides: z.array(catalogCapabilitySchema).default([]),
  requires: z.array(catalogRequirementSchema).default([]),
  bindingRules: z.array(bindingRuleSchema).default([]),
  contracts: z.array(contractSchema).default([]),
  sourceLayout: z.object({
    sourcePath: z.string().min(1).max(512),
    defaultFiles: z.array(sourceFileSchema).default([]),
    writeScopes: z.array(z.string().min(1).max(512)).min(1),
  }).strict(),
  generation: generationRecipeSchema,
  verification: z.object({
    gates: z.array(catalogGateSchema).min(1),
  }).strict(),
  lifecycle: lifecyclePolicySchema,
  replacement: replacementPolicySchema.default({ supersedes: [], transparentRebind: true, requiresDrain: true }),
  effects: z.array(declaredEffectSchema).default([]),
  approvals: z.array(approvalGateSchema).default([]),
  provenance: z.object({
    catalog: z.literal('kernl-local-v1'),
    notes: z.string().max(2_000).default(''),
  }).strict(),
}).strict()

export type CatalogManifest = z.infer<typeof catalogManifestSchema>

export const catalogSchema = z.object({
  schemaVersion: z.literal('1.0'),
  manifests: z.array(catalogManifestSchema).min(1),
}).strict()

export type Catalog = z.infer<typeof catalogSchema>

export interface CatalogValidationIssue {
  code: string
  message: string
  manifestId?: string
}

export interface ParsedCatalog {
  catalog: Catalog
  digest: string
  byTypeVersion: Map<string, CatalogManifest>
  issues: CatalogValidationIssue[]
}

export class CatalogValidationError extends Error {
  readonly issues: readonly CatalogValidationIssue[]

  constructor(issues: readonly CatalogValidationIssue[]) {
    super(`Catalog validation failed: ${issues.map(issue => issue.code).join(', ')}`)
    this.name = 'CatalogValidationError'
    this.issues = issues
  }
}

function manifestKey(manifest: CatalogManifest): string {
  return `${manifest.component.type}:${manifest.component.id}@${manifest.component.version}`
}

/** Parse and cross-validate a catalog. Uniqueness and binding-rule coherence are enforced. */
export function parseCatalog(input: unknown): ParsedCatalog {
  const parsed = catalogSchema.parse(input)
  const issues: CatalogValidationIssue[] = []
  const byTypeVersion = new Map<string, CatalogManifest>()

  for (const manifest of parsed.manifests) {
    const key = manifestKey(manifest)
    if (byTypeVersion.has(key)) {
      issues.push({ code: 'DUPLICATE_MANIFEST', message: `duplicate catalog manifest ${key}`, manifestId: key })
      continue
    }
    byTypeVersion.set(key, manifest)

    const provided = new Set(manifest.provides.map(capability => capability.capability))
    for (const capability of manifest.provides) {
      if (capability.contract && !manifest.contracts.some(contract => contract.id === capability.contract)) {
        issues.push({
          code: 'PROVIDED_CONTRACT_UNDEFINED',
          message: `${key} provides ${capability.capability} via undefined contract ${capability.contract}`,
          manifestId: key,
        })
      }
      const rule = manifest.bindingRules.find(candidate => candidate.role === 'PROVIDES' && candidate.capability === capability.capability)
      if (!rule) {
        issues.push({ code: 'PROVIDE_RULE_MISSING', message: `${key} provides ${capability.capability} without a PROVIDES binding rule`, manifestId: key })
      }
    }
    for (const requirement of manifest.requires) {
      if (requirement.contract && !manifest.contracts.some(contract => contract.id === requirement.contract)) {
        // Consumers may reference shared contracts they do not own; only warn via rule check below.
      }
      const rule = manifest.bindingRules.find(candidate => candidate.role === 'REQUIRES' && candidate.capability === requirement.capability)
      if (!rule) {
        issues.push({ code: 'REQUIRE_RULE_MISSING', message: `${key} requires ${requirement.capability} without a REQUIRES binding rule`, manifestId: key })
      }
    }
    for (const contract of manifest.contracts) {
      if (!contract.schema || typeof contract.schema !== 'object') {
        issues.push({ code: 'CONTRACT_SCHEMA_MISSING', message: `${key} contract ${contract.id} has no schema`, manifestId: key })
      }
    }
    const scopeRoot = manifest.sourceLayout.writeScopes.every(scope => scope.startsWith(manifest.sourceLayout.sourcePath))
    if (!scopeRoot) {
      issues.push({ code: 'SCOPE_OUTSIDE_SOURCE_PATH', message: `${key} declares a write scope outside its source path`, manifestId: key })
    }
  }

  if (issues.length > 0) throw new CatalogValidationError(issues)
  return { catalog: parsed, digest: digestJson(parsed), byTypeVersion, issues: [] }
}

export function catalogDigest(catalog: Catalog): string {
  return digestJson(catalog)
}

export function catalogCanonicalJson(catalog: Catalog): string {
  return canonicalJson(catalog)
}

export function resolveManifest(catalog: ParsedCatalog, type: ComponentType, id: string, version: string): CatalogManifest | undefined {
  return catalog.byTypeVersion.get(`${type}:${id}@${version}`)
}

export interface BindingCheckResult {
  allowed: boolean
  reason?: string
}

/**
 * Check a consumer requirement against a provider capability using the
 * catalog's binding rules. Both manifests must already be catalog members.
 */
export function checkBinding(
  catalog: ParsedCatalog,
  consumer: CatalogManifest,
  requirementCapability: string,
  provider: CatalogManifest,
  providerCapability: string,
): BindingCheckResult {
  const requirement = consumer.requires.find(candidate => candidate.capability === requirementCapability)
  if (!requirement) return { allowed: false, reason: `${consumer.component.id} does not require capability ${requirementCapability}` }
  const provided = provider.provides.find(candidate => candidate.capability === providerCapability)
  if (!provided) return { allowed: false, reason: `${provider.component.id} does not provide capability ${providerCapability}` }
  if (requirement.version !== provided.version) {
    return { allowed: false, reason: `capability ${requirementCapability} version mismatch: requires ${requirement.version}, provided ${provided.version}` }
  }
  if (requirement.contract && provided.contract && requirement.contract !== provided.contract) {
    return { allowed: false, reason: `contract mismatch: ${requirement.contract} vs ${provided.contract}` }
  }
  const rule = consumer.bindingRules.find(candidate => candidate.role === 'REQUIRES' && candidate.capability === requirementCapability)
  if (!rule) return { allowed: false, reason: `${consumer.component.id} declares no REQUIRES rule for ${requirementCapability}` }
  if (!rule.withComponentTypes.includes(provider.component.type)) {
    return { allowed: false, reason: `capability ${requirementCapability} may not bind to component type ${provider.component.type}` }
  }
  if (rule.contracts.length > 0 && provided.contract && !rule.contracts.includes(provided.contract)) {
    return { allowed: false, reason: `contract ${provided.contract} is not allowed for ${requirementCapability}` }
  }
  return { allowed: true }
}

/**
 * Validate every binding of an AIR document against the catalog manifests
 * that declare its component types. Components absent from the catalog are
 * ignored here (AIR-level semantic validation covers them).
 */
export function validateAirBindingsAgainstCatalog(catalog: ParsedCatalog, air: AirDocument): CatalogValidationIssue[] {
  const issues: CatalogValidationIssue[] = []
  const manifests = new Map<string, CatalogManifest>()
  for (const component of air.components) {
    const manifest = resolveManifestByComponentId(catalog, component.kind, component.id, component.version)
    if (manifest) manifests.set(component.id, manifest)
  }
  for (const binding of air.bindings) {
    const consumer = manifests.get(binding.consumerId)
    const provider = manifests.get(binding.providerId)
    if (!consumer || !provider) continue
    const check = checkBinding(catalog, consumer, binding.capabilityId, provider, binding.capabilityId)
    if (!check.allowed) {
      issues.push({ code: 'BINDING_REJECTED_BY_CATALOG', message: `binding ${binding.id}: ${check.reason ?? 'not allowed'}` })
    }
  }
  return issues
}

const airKindToType: Record<string, ComponentType> = {
  API: 'HTTP_API',
  WORKER: 'WORKER',
  QUEUE: 'QUEUE',
  STORE: 'STORE',
  SERVICE: 'POLICY',
  ADAPTER: 'FAILURE_SINK',
}

export function airKindToComponentType(kind: string): ComponentType | undefined {
  return airKindToType[kind]
}

function resolveManifestByComponentId(catalog: ParsedCatalog, airKind: string, componentId: string, version: string): CatalogManifest | undefined {
  const type = airKindToComponentType(airKind)
  if (!type) return undefined
  // AIR component ids may differ from catalog ids; catalog ids are canonical types like 'http-api'.
  const direct = catalog.byTypeVersion.get(`${type}:${componentId}@${version}`)
  if (direct) return direct
  for (const manifest of catalog.byTypeVersion.values()) {
    if (manifest.component.type === type && manifest.component.version === version) return manifest
  }
  return undefined
}

import { z } from 'zod'
import {
  airDigest,
  validateAir,
  componentSchema,
  contractSchema,
  verificationGateSchema,
  type AirDocument,
} from './air.js'
import {
  checkBinding,
  componentTypeSchema,
  resolveManifest,
  validateAirBindingsAgainstCatalog,
  airKindToComponentType,
  type CatalogValidationIssue,
  type ComponentType,
  type ParsedCatalog,
} from './catalog.js'
import { digestJson } from './hashing.js'
import { semanticDiff, type AirSemanticDiff } from './diff.js'

export const draftOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('ADD'),
    componentId: z.string().min(1).max(128),
    catalogType: componentTypeSchema,
    catalogId: z.string().min(1).max(128),
    catalogVersion: z.string().min(1).max(64),
  }).strict(),
  z.object({
    op: z.literal('UPGRADE'),
    componentId: z.string().min(1).max(128),
    catalogType: componentTypeSchema,
    catalogVersion: z.string().min(1).max(64),
  }).strict(),
  z.object({
    op: z.literal('REMOVE'),
    componentId: z.string().min(1).max(128),
  }).strict(),
  z.object({
    op: z.literal('REBIND'),
    componentId: z.string().min(1).max(128),
    requirementId: z.string().min(1).max(128),
    providerComponentId: z.string().min(1).max(128),
    providerCapabilityId: z.string().min(1).max(128).optional(),
  }).strict(),
])

export type DraftOp = z.infer<typeof draftOpSchema>

export type RebindOp = Extract<DraftOp, { op: 'REBIND' }>

export const contractChangeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('ADD'), contract: contractSchema }).strict(),
  z.object({ op: z.literal('UPDATE'), contract: contractSchema }).strict(),
  z.object({ op: z.literal('REMOVE'), contractId: z.string().min(1).max(128) }).strict(),
])

export type ContractChange = z.infer<typeof contractChangeSchema>

export const architectureDraftSchema = z.object({
  schemaVersion: z.literal('1.0'),
  draftId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  systemId: z.string().min(1).max(128),
  title: z.string().min(1).max(200),
  intent: z.string().min(1).max(2_000),
  baseAirVersion: z.string().min(1).max(64),
  baseAirDigest: z.string().regex(/^[a-f0-9]{64}$/),
  componentOps: z.array(draftOpSchema).default([]),
  contractChanges: z.array(contractChangeSchema).default([]),
  /** Gate ids requested for the compiled AIR; resolved against catalog manifests at compile time. */
  requestedVerification: z.object({
    gates: z.array(z.string().min(1).max(128)).min(1),
  }).strict(),
  /**
   * Optional declared verification drill: the honest first-candidate failure
   * the deterministic adapter must exhibit, with the step it applies to and
   * the authorized repair scope. Declared by the architect, never invented.
   */
  expectedFailure: z.object({
    fingerprint: z.string().min(1).max(128),
    repairStepId: z.string().min(1).max(128),
    repairScope: z.array(z.string().min(1)).min(1),
  }).strict().optional(),
  changeNotes: z.string().max(4_000).default(''),
  requestedBy: z.string().min(1).max(128),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict()

export type ArchitectureDraft = z.infer<typeof architectureDraftSchema>

export type DraftStatus = 'DRAFT' | 'VALID' | 'INVALID' | 'LOCKED' | 'EXECUTED' | 'REJECTED'

export interface DraftIssue {
  code: string
  message: string
  componentId?: string
}

export interface DraftValidationResult {
  valid: boolean
  issues: DraftIssue[]
  affectedComponentIds: string[]
}

export interface CompiledDraft {
  after: AirDocument
  diff: AirSemanticDiff
  digest: string
  airVersion: string
}

type AirKind = z.infer<typeof componentSchema>['kind']

function cloneAir(air: AirDocument): AirDocument {
  return structuredClone(air)
}

function componentTypeToAirKind(type: ComponentType): AirKind {
  switch (type) {
    case 'HTTP_API': return 'API'
    case 'WORKER': return 'WORKER'
    case 'QUEUE': return 'QUEUE'
    case 'STORE': return 'STORE'
    case 'POLICY': return 'SERVICE'
    case 'FAILURE_SINK': return 'ADAPTER'
  }
}

function bumpMinor(version: string): string {
  const parts = version.split('.')
  const minor = Number(parts[1] ?? 0)
  if (Number.isNaN(minor)) return version
  parts[1] = String(minor + 1)
  return parts.join('.')
}

function findManifestForVersion(catalog: ParsedCatalog, type: ComponentType, version: string) {
  for (const manifest of catalog.byTypeVersion.values()) {
    if (manifest.component.type === type && manifest.component.version === version) return manifest
  }
  return undefined
}

/**
 * Compile a draft into a new AIR document. Validation and compilation share
 * this single deterministic path: validateDraft reports every issue it would
 * raise at compile time, and applyDraft refuses invalid drafts.
 */
export function compileDraft(
  draft: ArchitectureDraft,
  baseAir: AirDocument,
  catalog: ParsedCatalog,
): { ok: true; compiled: CompiledDraft } | { ok: false; issues: DraftIssue[] } {
  const issues: DraftIssue[] = []
  const push = (issue: DraftIssue) => issues.push(issue)

  if (draft.systemId !== baseAir.system.id) {
    push({ code: 'SYSTEM_MISMATCH', message: `draft targets system ${draft.systemId}, base AIR is ${baseAir.system.id}` })
  }
  if (draft.baseAirVersion !== baseAir.airVersion) {
    push({ code: 'BASE_VERSION_MISMATCH', message: `draft bases on ${draft.baseAirVersion}, base AIR is ${baseAir.airVersion}` })
  }
  if (draft.baseAirDigest !== airDigest(baseAir)) {
    push({ code: 'BASE_DIGEST_MISMATCH', message: 'base AIR digest does not match the stored base version' })
  }
  if (draft.componentOps.length === 0 && draft.contractChanges.length === 0) {
    push({ code: 'EMPTY_DRAFT', message: 'draft changes nothing; add at least one component or contract operation' })
  }

  const after = cloneAir(baseAir)
  after.airVersion = `air-draft-${digestJson(draft).slice(0,24)}`
  after.change = {
    id: draft.draftId,
    intent: draft.intent,
    parentAirVersion: baseAir.airVersion,
    requestedBy: draft.requestedBy,
  }
  after.provenance = { changeId: draft.draftId, parentAirDigest: airDigest(baseAir) }

  const touched = new Set<string>()
  const addedIds = new Set<string>()
  const removedIds = new Set<string>()
  const upgradedProviders: Array<{ id: string; providedNow: Set<string>; transparent: boolean }> = []

  // ---- component ops -------------------------------------------------
  for (const op of draft.componentOps) {
    switch (op.op) {
      case 'ADD': {
        touched.add(op.componentId)
        if (addedIds.has(op.componentId) || baseAir.components.some(component => component.id === op.componentId)) {
          push({ code: 'COMPONENT_EXISTS', message: `cannot add ${op.componentId}: already exists`, componentId: op.componentId })
          break
        }
        const manifest = resolveManifest(catalog, op.catalogType, op.catalogId, op.catalogVersion)
        if (!manifest) {
          push({ code: 'MANIFEST_NOT_FOUND', message: `catalog has no ${op.catalogType} ${op.catalogId}@${op.catalogVersion}`, componentId: op.componentId })
          break
        }
        addedIds.add(op.componentId)
        after.components.push({
          id: op.componentId,
          version: manifest.component.version,
          kind: componentTypeToAirKind(op.catalogType),
          sourcePath: manifest.sourceLayout.sourcePath,
          writeScopes: [...manifest.sourceLayout.writeScopes],
          provides: manifest.provides.map(capability => ({ ...capability })),
          requires: manifest.requires.map(requirement => ({ ...requirement })),
          lifecycle: { ...manifest.lifecycle },
        })
        for (const contract of manifest.contracts) {
          if (!after.contracts.some(existing => existing.id === contract.id)) after.contracts.push(structuredClone(contract))
        }
        for (const effect of manifest.effects) {
          after.effects.push({ ...effect, componentId: op.componentId })
        }
        break
      }
      case 'UPGRADE': {
        touched.add(op.componentId)
        const existing = after.components.find(component => component.id === op.componentId)
        if (!existing) {
          push({ code: 'COMPONENT_MISSING', message: `cannot upgrade ${op.componentId}: not present`, componentId: op.componentId })
          break
        }
        const currentType = airKindToComponentType(existing.kind)
        if (!currentType || currentType !== op.catalogType) {
          push({ code: 'TYPE_MISMATCH', message: `component ${op.componentId} is ${existing.kind}, not a ${op.catalogType}`, componentId: op.componentId })
          break
        }
        const manifest = findManifestForVersion(catalog, op.catalogType, op.catalogVersion)
        if (!manifest) {
          push({ code: 'MANIFEST_NOT_FOUND', message: `catalog has no ${op.catalogType} version ${op.catalogVersion}`, componentId: op.componentId })
          break
        }
        if (!manifest.replacement.supersedes.includes(existing.version)) {
          push({ code: 'REPLACEMENT_NOT_COMPATIBLE', message: `${op.catalogType}@${op.catalogVersion} does not supersede ${existing.version}`, componentId: op.componentId })
          break
        }
        const transparent = manifest.replacement.transparentRebind
        existing.version = manifest.component.version
        existing.writeScopes = [...manifest.sourceLayout.writeScopes]
        existing.provides = manifest.provides.map(capability => ({ ...capability }))
        const previousRequires = new Map(existing.requires.map(requirement => [requirement.capability, requirement]))
        existing.requires = manifest.requires.map(requirement => ({
          ...requirement,
          optional: previousRequires.get(requirement.capability)?.optional ?? false,
        }))
        upgradedProviders.push({
          id: existing.id,
          providedNow: new Set(existing.provides.map(capability => `${capability.capability}@${capability.version}`)),
          transparent,
        })
        for (const contract of manifest.contracts) {
          if (!after.contracts.some(candidate => candidate.id === contract.id)) after.contracts.push(structuredClone(contract))
        }
        for (const effect of manifest.effects) {
          const exists = after.effects.some(candidate => candidate.id === effect.id && candidate.componentId === op.componentId)
          if (!exists) after.effects.push({ ...effect, componentId: op.componentId })
        }
        break
      }
      case 'REMOVE': {
        touched.add(op.componentId)
        const existing = after.components.find(component => component.id === op.componentId)
        if (!existing) {
          push({ code: 'COMPONENT_MISSING', message: `cannot remove ${op.componentId}: not present`, componentId: op.componentId })
          break
        }
        removedIds.add(op.componentId)
        break
      }
      case 'REBIND': {
        touched.add(op.componentId)
        touched.add(op.providerComponentId)
        const consumer = after.components.find(component => component.id === op.componentId)
        if (!consumer) {
          push({ code: 'COMPONENT_MISSING', message: `cannot rebind ${op.componentId}: not present`, componentId: op.componentId })
          break
        }
        const requirement = consumer.requires.find(candidate => candidate.id === op.requirementId)
        if (!requirement) {
          push({ code: 'REQUIREMENT_MISSING', message: `${op.componentId} has no requirement ${op.requirementId}`, componentId: op.componentId })
          break
        }
        const knownProvider = after.components.some(component => component.id === op.providerComponentId)
        if (!knownProvider) {
          push({ code: 'PROVIDER_MISSING', message: `rebind target ${op.providerComponentId} is neither in base AIR nor added by this draft`, componentId: op.componentId })
          break
        }
        const consumerManifest = findManifestForVersion(catalog, airKindToComponentType(consumer.kind) ?? 'WORKER', consumer.version)
          ?? manifestByComponentIdentity(catalog, consumer.kind, consumer.id, consumer.version)
        const provider = after.components.find(component => component.id === op.providerComponentId)
        const providerManifest = provider
          ? (findManifestForVersion(catalog, airKindToComponentType(provider.kind) ?? 'STORE', provider.version)
            ?? manifestByComponentIdentity(catalog, provider.kind, provider.id, provider.version))
          : undefined
        if (consumerManifest && providerManifest) {
          const check = checkBinding(catalog, consumerManifest, requirement.capability, providerManifest, op.providerCapabilityId ?? requirement.capability)
          if (!check.allowed) {
            push({ code: 'BINDING_REJECTED_BY_CATALOG', message: `rebind ${op.componentId}.${op.requirementId} -> ${op.providerComponentId}: ${check.reason ?? 'rejected'}`, componentId: op.componentId })
          }
        }
        break
      }
    }
  }

  // Apply removals after the loop so later ops could still reference earlier states.
  after.components = after.components.filter(component => !removedIds.has(component.id))

  // ---- bindings ------------------------------------------------------
  const rebindByKey = new Map<string, RebindOp>()
  for (const op of draft.componentOps) {
    if (op.op === 'REBIND') rebindByKey.set(`${op.componentId}::${op.requirementId}`, op)
  }

  // Drop bindings whose consumer/provider disappeared, whose requirement no
  // longer exists on the consumer, or which are explicitly rebound.
  after.bindings = after.bindings.filter(binding => {
    if (removedIds.has(binding.consumerId) || removedIds.has(binding.providerId)) return false
    const consumer = after.components.find(component => component.id === binding.consumerId)
    if (!consumer) return false
    const requirement = consumer.requires.find(candidate => candidate.id === binding.requirementId)
    if (!requirement || requirement.capability !== binding.capabilityId) return false
    return !rebindByKey.has(`${binding.consumerId}::${binding.requirementId}`)
  })

  // Provider versions follow transparent upgrades.
  for (const binding of after.bindings) {
    const provider = after.components.find(component => component.id === binding.providerId)
    if (provider && provider.version !== binding.providerVersion) {
      binding.providerVersion = provider.version
    }
  }

  // Upgraded providers that dropped capabilities invalidate surviving
  // upstream bindings unless the manifest declares transparent rebind.
  for (const upgrade of upgradedProviders) {
    for (const binding of after.bindings) {
      if (binding.providerId !== upgrade.id) continue
      const key = `${binding.capabilityId}@${binding.providerVersion}`
      if (!upgrade.providedNow.has(key) && !upgrade.transparent) {
        push({ code: 'PROVIDER_CAPABILITY_LOST', message: `upgrade removes ${key} still consumed by ${binding.consumerId}`, componentId: upgrade.id })
      }
    }
  }

  // Ensure every non-optional requirement of every component has exactly one committed-style binding.
  const providersOf = (capability: string, version: string, excludeId: string) =>
    after.components.filter(candidate =>
      candidate.id !== excludeId
      && candidate.provides.some(entry => entry.capability === capability && entry.version === version))

  for (const consumer of after.components) {
    for (const requirement of consumer.requires) {
      if (requirement.optional) continue
      const key = `${consumer.id}::${requirement.id}`
      const existingBinding = after.bindings.find(binding =>
        binding.consumerId === consumer.id && binding.requirementId === requirement.id)
      if (existingBinding) continue
      const rebind = rebindByKey.get(key)
      let providerComponentId: string
      let providerVersion: string
      if (rebind) {
        const provider = after.components.find(component => component.id === rebind.providerComponentId)
        if (!provider) continue // reported above
        const wantedCapability = rebind.providerCapabilityId ?? requirement.capability
        const capability = provider.provides.find(entry => entry.capability === wantedCapability && entry.version === requirement.version)
        if (!capability) {
          push({ code: 'BINDING_INCOMPATIBLE', message: `${rebind.providerComponentId} does not provide ${wantedCapability}@${requirement.version}`, componentId: consumer.id })
          continue
        }
        providerComponentId = provider.id
        providerVersion = provider.version
      } else {
        const candidates = providersOf(requirement.capability, requirement.version, consumer.id)
        if (candidates.length === 0) {
          push({ code: 'NO_PROVIDER', message: `no provider for ${requirement.capability}@${requirement.version} required by ${consumer.id}.${requirement.id}`, componentId: consumer.id })
          continue
        }
        if (candidates.length > 1) {
          push({ code: 'AMBIGUOUS_PROVIDER', message: `${candidates.length} providers for ${requirement.capability}@${requirement.version}; add an explicit REBIND`, componentId: consumer.id })
          continue
        }
        const provider = candidates[0]
        if (!provider) continue
        providerComponentId = provider.id
        providerVersion = provider.version
      }
      after.bindings.push({
        id: `${consumer.id}-to-${providerComponentId}-${requirement.id}`.slice(0, 128),
        consumerId: consumer.id,
        requirementId: requirement.id,
        providerId: providerComponentId,
        capabilityId: requirement.capability,
        providerVersion,
      })
      touched.add(consumer.id)
    }
  }

  // Exactly-one-binding invariant per (consumer, requirement).
  const seen = new Map<string, number>()
  for (const binding of after.bindings) {
    const key = `${binding.consumerId}::${binding.requirementId}`
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  for (const [key, count] of seen) {
    if (count > 1) push({ code: 'DUPLICATE_BINDING', message: `${count} bindings target ${key}; remove the ambiguity` })
  }

  // ---- contracts -----------------------------------------------------
  for (const change of draft.contractChanges) {
    const id = change.op === 'REMOVE' ? change.contractId : change.contract.id
    if (change.op === 'ADD') {
      if (after.contracts.some(contract => contract.id === id)) {
        push({ code: 'CONTRACT_EXISTS', message: `cannot add contract ${id}: already present` })
        continue
      }
      after.contracts.push(structuredClone(change.contract))
    }
    if (change.op === 'UPDATE') {
      const index = after.contracts.findIndex(contract => contract.id === id)
      if (index < 0) {
        push({ code: 'CONTRACT_MISSING', message: `cannot update contract ${id}: not present` })
        continue
      }
      after.contracts[index] = structuredClone(change.contract)
    }
    if (change.op === 'REMOVE') {
      const referers = after.components.filter(component =>
        [...component.provides, ...component.requires].some(capability => capability.contract === id))
      if (referers.length > 0) {
        push({
          code: 'CONTRACT_STILL_REFERENCED',
          message: `contract ${id} is removed but surviving components still reference it: ${referers.map(component => `${component.id}@${component.version}[${component.provides.concat(component.requires).filter(capability => capability.contract === id).map(capability => capability.capability).join(',')}]`).join('; ')}`,
        })
        continue
      }
      after.contracts = after.contracts.filter(contract => contract.id !== id)
    }
  }

  // ---- verification gates -------------------------------------------
  const gateById = new Map<string, z.infer<typeof verificationGateSchema>>()
  for (const component of after.components) {
    const type = airKindToComponentType(component.kind)
    if (!type) continue
    const manifest = findManifestForVersion(catalog, type, component.version)
      ?? manifestByComponentIdentity(catalog, component.kind, component.id, component.version)
    if (!manifest) continue
    for (const gate of manifest.verification.gates) {
      const existing = gateById.get(gate.id)
      if (existing && existing.command !== gate.command) {
        push({ code: 'GATE_CONFLICT', message: `catalog manifests disagree on command for verification gate ${gate.id}` })
      }
      if (!existing) {
        gateById.set(gate.id, { id: gate.id, command: gate.command, required: gate.required, timeoutMs: gate.timeoutMs })
      } else if (gate.required) {
        existing.required = true
      }
    }
  }
  const requestedGates = draft.requestedVerification.gates
    .map(gateId => gateById.get(gateId))
    .filter((gate): gate is z.infer<typeof verificationGateSchema> => Boolean(gate))
  const unresolvedGates = draft.requestedVerification.gates.filter(gateId => !gateById.has(gateId))
  for (const gateId of unresolvedGates) {
    push({ code: 'GATE_UNKNOWN', message: `requested verification gate ${gateId} is not declared by any catalog manifest involved` })
  }
  if (requestedGates.length > 0) {
    // An architect can request additional checks, not remove catalog obligations.
    const requiredGates = [...gateById.values()].filter(gate => gate.required)
    after.verification = { gates: [...new Map([...requiredGates, ...requestedGates].map(gate => [gate.id, gate])).values()] }
  }

  // ---- system bump + final semantic validation -----------------------
  after.system = { ...after.system, version: bumpMinor(after.system.version) }

  const finalValidation = validateAir(after)
  if (!finalValidation.success) for (const issue of finalValidation.issues) push({code:issue.code,message:issue.message})

  if (issues.length > 0) return { ok: false, issues }

  const diff = semanticDiff(baseAir, after)
  return {
    ok: true,
    compiled: {
      after,
      diff,
      digest: airDigest(after),
      airVersion: after.airVersion,
    },
  }
}

function manifestByComponentIdentity(catalog: ParsedCatalog, airKind: string, componentId: string, version: string) {
  const type = airKindToComponentType(airKind)
  if (!type) return undefined
  return catalog.byTypeVersion.get(`${type}:${componentId}@${version}`)
}

/** Validate a draft by running the exact compilation it would undergo. */
export function validateDraft(draft: ArchitectureDraft, baseAir: AirDocument, catalog: ParsedCatalog): DraftValidationResult {
  const result = compileDraft(draft, baseAir, catalog)
  if (result.ok) {
    return { valid: true, issues: [], affectedComponentIds: result.compiled.diff.directlyAffectedComponentIds }
  }
  const affected = new Set<string>()
  for (const issue of result.issues) {
    if (issue.componentId) affected.add(issue.componentId)
  }
  for (const op of draft.componentOps) affected.add(op.componentId)
  return { valid: false, issues: result.issues, affectedComponentIds: [...affected].sort() }
}

/** Apply a validated draft. Throws when the draft does not compile cleanly. */
export function applyDraft(draft: ArchitectureDraft, baseAir: AirDocument, catalog: ParsedCatalog): CompiledDraft {
  const result = compileDraft(draft, baseAir, catalog)
  if (!result.ok) {
    throw new Error(`cannot apply invalid draft ${draft.draftId}: ${result.issues.map(issue => issue.code).join(', ')}`)
  }
  return result.compiled
}

/** Catalog-level issues for any AIR document (bindings checked against manifests). */
export function catalogIssuesForAir(catalog: ParsedCatalog, air: AirDocument): CatalogValidationIssue[] {
  return validateAirBindingsAgainstCatalog(catalog, air)
}

export function draftDigest(draft: ArchitectureDraft): string {
  return digestJson(draft)
}

import type { AirBinding, AirComponent, AirContract, AirDocument } from './air.js'
import { canonicalJson } from './hashing.js'

export interface EntityChange<T> {
  id: string
  before: T
  after: T
  changedFields: string[]
}

export interface EntityDiff<T> {
  added: T[]
  removed: T[]
  changed: EntityChange<T>[]
}

export interface AirSemanticDiff {
  fromAirVersion: string
  toAirVersion: string
  components: EntityDiff<AirComponent>
  bindings: EntityDiff<AirBinding>
  contracts: EntityDiff<AirContract>
  directlyAffectedComponentIds: string[]
  affectedComponentIds: string[]
  reasons: Record<string, string[]>
  otherChangedFields: string[]
  empty: boolean
}

function fieldDiff(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...fields].filter((field) => canonicalJson(before[field]) !== canonicalJson(after[field])).sort()
}

function entityDiff<T extends { id: string }>(before: readonly T[], after: readonly T[]): EntityDiff<T> {
  const beforeMap = new Map(before.map((item) => [item.id, item]))
  const afterMap = new Map(after.map((item) => [item.id, item]))
  const added = after.filter((item) => !beforeMap.has(item.id)).sort((left, right) => left.id.localeCompare(right.id))
  const removed = before.filter((item) => !afterMap.has(item.id)).sort((left, right) => left.id.localeCompare(right.id))
  const changed: EntityChange<T>[] = []

  for (const [id, prior] of beforeMap) {
    const next = afterMap.get(id)
    if (!next || canonicalJson(prior) === canonicalJson(next)) continue
    changed.push({ id, before: prior, after: next, changedFields: fieldDiff(prior, next) })
  }

  return { added, removed, changed: changed.sort((left, right) => left.id.localeCompare(right.id)) }
}

function addReason(reasons: Map<string, Set<string>>, componentId: string, reason: string): void {
  const componentReasons = reasons.get(componentId) ?? new Set<string>()
  componentReasons.add(reason)
  reasons.set(componentId, componentReasons)
}

export function semanticDiff(before: AirDocument, after: AirDocument): AirSemanticDiff {
  const components = entityDiff(before.components, after.components)
  const bindings = entityDiff(before.bindings, after.bindings)
  const contracts = entityDiff(before.contracts, after.contracts)
  const reasons = new Map<string, Set<string>>()

  for (const component of components.added) addReason(reasons, component.id, 'COMPONENT_ADDED')
  for (const component of components.removed) addReason(reasons, component.id, 'COMPONENT_REMOVED')
  for (const component of components.changed) addReason(reasons, component.id, `COMPONENT_CHANGED:${component.changedFields.join(',')}`)

  const changedBindings = [
    ...bindings.added.map((binding) => ({ before: undefined, after: binding })),
    ...bindings.removed.map((binding) => ({ before: binding, after: undefined })),
    ...bindings.changed,
  ]

  for (const change of changedBindings) {
    const prior = change.before as AirBinding | undefined
    const next = change.after as AirBinding | undefined
    if (prior) {
      addReason(reasons, prior.consumerId, `BINDING_CHANGED:${prior.id}`)
      addReason(reasons, prior.providerId, `BINDING_CHANGED:${prior.id}`)
    }
    if (next) {
      addReason(reasons, next.consumerId, `BINDING_CHANGED:${next.id}`)
      addReason(reasons, next.providerId, `BINDING_CHANGED:${next.id}`)
    }
  }

  const changedContractIds = new Set([
    ...contracts.added.map((contract) => contract.id),
    ...contracts.removed.map((contract) => contract.id),
    ...contracts.changed.map((contract) => contract.id),
  ])
  for (const component of [...before.components, ...after.components]) {
    if ([...component.provides, ...component.requires].some((capability) => capability.contract && changedContractIds.has(capability.contract))) {
      addReason(reasons, component.id, 'REFERENCED_CONTRACT_CHANGED')
    }
  }

  const direct = new Set(reasons.keys())
  const affected = new Set(direct)
  const allBindings = [...before.bindings, ...after.bindings]
  let expanded = true
  while (expanded) {
    expanded = false
    for (const binding of allBindings) {
      if (affected.has(binding.consumerId) || affected.has(binding.providerId)) {
        if (!affected.has(binding.consumerId)) {
          affected.add(binding.consumerId)
          expanded = true
        }
        if (!affected.has(binding.providerId)) {
          affected.add(binding.providerId)
          expanded = true
        }
      }
    }
  }

  const otherBefore = {
    system: before.system,
    verification: before.verification,
    effects: before.effects,
    approvalGates: before.approvalGates,
    change: before.change,
    provenance: before.provenance,
  }
  const otherAfter = {
    system: after.system,
    verification: after.verification,
    effects: after.effects,
    approvalGates: after.approvalGates,
    change: after.change,
    provenance: after.provenance,
  }
  const otherChangedFields = fieldDiff(otherBefore, otherAfter)
  const serializedReasons = Object.fromEntries(
    [...reasons.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, values]) => [id, [...values].sort()]),
  )
  const empty = components.added.length === 0 && components.removed.length === 0 && components.changed.length === 0
    && bindings.added.length === 0 && bindings.removed.length === 0 && bindings.changed.length === 0
    && contracts.added.length === 0 && contracts.removed.length === 0 && contracts.changed.length === 0
    && otherChangedFields.length === 0

  return {
    fromAirVersion: before.airVersion,
    toAirVersion: after.airVersion,
    components,
    bindings,
    contracts,
    directlyAffectedComponentIds: [...direct].sort(),
    affectedComponentIds: [...affected].sort(),
    reasons: serializedReasons,
    otherChangedFields,
    empty,
  }
}

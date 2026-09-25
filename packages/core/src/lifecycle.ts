import type { LifecycleStateName, RecoveryClassification } from './air.js'

export type BindingState = 'COMMITTED' | 'RELEASED'

export interface ProviderRuntime {
  id: string
  version: string
  state: LifecycleStateName
  acceptingNewBindings: boolean
  relianceCount: number
  cleanupComplete: boolean
  cleanupReceipt?: CleanupReceiptReference
  failure?: string
}

/**
 * Structural proof accepted from a persisted effect receipt. Requiring the
 * ledger-assigned id and committedAt prevents lifecycle callers from marking
 * cleanup complete with an unrecorded boolean.
 */
export interface CleanupEffectReceiptProof {
  id: string
  effectType: string
  resourceIdentity: string
  idempotencyKey: string
  result: unknown
  resultingState: string
  recoveryClassification: RecoveryClassification
  committedAt: string
}

export interface CleanupReceiptReference {
  receiptId: string
  idempotencyKey: string
  committedAt: string
}

export interface BindingRuntime {
  id: string
  consumerId: string
  requirementId: string
  providerId: string
  providerVersion: string
  state: BindingState
}

export interface LifecycleSnapshot {
  providers: Record<string, ProviderRuntime>
  bindings: Record<string, BindingRuntime>
}

export interface NewBinding {
  id: string
  consumerId: string
  requirementId: string
  providerId: string
  providerVersion: string
}

export class LifecycleGuardError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'LifecycleGuardError'
    this.code = code
  }
}

const transitions: Readonly<Record<LifecycleStateName, readonly LifecycleStateName[]>> = {
  PENDING: ['LOADING'],
  LOADING: ['ACTIVE', 'FAILED'],
  ACTIVE: ['RETIRING', 'FAILED'],
  RETIRING: ['DRAINING', 'FAILED'],
  DRAINING: ['INACTIVE', 'FAILED'],
  INACTIVE: ['LOADING'],
  FAILED: ['PENDING'],
}

function cloneSnapshot(snapshot: LifecycleSnapshot): LifecycleSnapshot {
  return {
    providers: Object.fromEntries(Object.entries(snapshot.providers).map(([id, provider]) => [id, { ...provider }])),
    bindings: Object.fromEntries(Object.entries(snapshot.bindings).map(([id, binding]) => [id, { ...binding }])),
  }
}

export interface InitialProviderRuntime extends Pick<ProviderRuntime, 'id' | 'version' | 'state'> {
  cleanupReceipt?: CleanupEffectReceiptProof
}

function cleanupReference(providerId: string, receipt: CleanupEffectReceiptProof): CleanupReceiptReference {
  if (!receipt.id.trim() || !receipt.idempotencyKey.trim() || !receipt.committedAt.trim()) {
    throw new LifecycleGuardError('CLEANUP_RECEIPT_INVALID', 'Cleanup proof must be a committed effect receipt with id and idempotency key')
  }
  if (receipt.effectType !== 'provider.cleanup') {
    throw new LifecycleGuardError('CLEANUP_RECEIPT_EFFECT_MISMATCH', `Expected provider.cleanup receipt, found ${receipt.effectType}`)
  }
  if (receipt.resourceIdentity !== providerId) {
    throw new LifecycleGuardError('CLEANUP_RECEIPT_RESOURCE_MISMATCH', `Cleanup receipt targets ${receipt.resourceIdentity}, not ${providerId}`)
  }
  if (receipt.resultingState !== 'CLEANUP_COMPLETE') {
    throw new LifecycleGuardError('CLEANUP_RECEIPT_STATE_MISMATCH', `Cleanup receipt ended in ${receipt.resultingState}, not CLEANUP_COMPLETE`)
  }
  const result = receipt.result
  if (!result || typeof result !== 'object' || Array.isArray(result) || (result as Record<string, unknown>).cleanupComplete !== true) {
    throw new LifecycleGuardError('CLEANUP_RECEIPT_RESULT_MISMATCH', 'Cleanup receipt must attest cleanupComplete=true')
  }
  return { receiptId: receipt.id, idempotencyKey: receipt.idempotencyKey, committedAt: receipt.committedAt }
}

export function createLifecycleSnapshot(providers: readonly InitialProviderRuntime[] = []): LifecycleSnapshot {
  const snapshot: LifecycleSnapshot = { providers: {}, bindings: {} }
  for (const provider of providers) {
    if (snapshot.providers[provider.id]) throw new LifecycleGuardError('DUPLICATE_PROVIDER', `Provider ${provider.id} already exists`)
    const proof = provider.cleanupReceipt ? cleanupReference(provider.id, provider.cleanupReceipt) : undefined
    if (provider.state === 'INACTIVE' && !proof) {
      throw new LifecycleGuardError('CLEANUP_RECEIPT_REQUIRED', `Inactive provider ${provider.id} requires a committed cleanup receipt`)
    }
    snapshot.providers[provider.id] = {
      id: provider.id,
      version: provider.version,
      state: provider.state,
      acceptingNewBindings: provider.state === 'ACTIVE',
      relianceCount: 0,
      cleanupComplete: proof !== undefined,
      ...(proof ? { cleanupReceipt: proof } : {}),
    }
  }
  assertLifecycleInvariants(snapshot)
  return snapshot
}

export function addProvider(snapshot: LifecycleSnapshot, provider: Pick<ProviderRuntime, 'id' | 'version'>): LifecycleSnapshot {
  if (snapshot.providers[provider.id]) throw new LifecycleGuardError('DUPLICATE_PROVIDER', `Provider ${provider.id} already exists`)
  const next = cloneSnapshot(snapshot)
  next.providers[provider.id] = {
    ...provider,
    state: 'PENDING',
    acceptingNewBindings: false,
    relianceCount: 0,
    cleanupComplete: false,
  }
  return next
}

export interface TransitionOptions {
  failure?: string
}

export function transitionProvider(
  snapshot: LifecycleSnapshot,
  providerId: string,
  target: LifecycleStateName,
  options: TransitionOptions = {},
): LifecycleSnapshot {
  const provider = snapshot.providers[providerId]
  if (!provider) throw new LifecycleGuardError('UNKNOWN_PROVIDER', `Provider ${providerId} does not exist`)
  if (!transitions[provider.state].includes(target)) {
    throw new LifecycleGuardError('INVALID_TRANSITION', `Cannot transition ${providerId} from ${provider.state} to ${target}`)
  }
  if (target === 'INACTIVE' && provider.relianceCount > 0) {
    throw new LifecycleGuardError('PROVIDER_STILL_REFERENCED', `Provider ${providerId} has ${provider.relianceCount} committed bindings`)
  }
  if (target === 'INACTIVE' && (!provider.cleanupComplete || !provider.cleanupReceipt)) {
    throw new LifecycleGuardError('CLEANUP_RECEIPT_REQUIRED', `Provider ${providerId} cannot become inactive without a committed cleanup receipt`)
  }
  if (target === 'FAILED' && !options.failure) {
    throw new LifecycleGuardError('FAILURE_REASON_REQUIRED', 'A failed transition requires a failure reason')
  }

  const next = cloneSnapshot(snapshot)
  const updated = next.providers[providerId]
  if (!updated) throw new LifecycleGuardError('UNKNOWN_PROVIDER', `Provider ${providerId} does not exist`)
  updated.state = target
  updated.acceptingNewBindings = target === 'ACTIVE'
  if (target === 'PENDING' || target === 'LOADING') {
    updated.cleanupComplete = false
    delete updated.cleanupReceipt
  }
  if (target === 'FAILED') updated.failure = options.failure ?? 'unknown failure'
  else delete updated.failure
  assertLifecycleInvariants(next)
  return next
}

export function markCleanupComplete(
  snapshot: LifecycleSnapshot,
  providerId: string,
  receipt: CleanupEffectReceiptProof,
): LifecycleSnapshot {
  const provider = snapshot.providers[providerId]
  if (!provider) throw new LifecycleGuardError('UNKNOWN_PROVIDER', `Provider ${providerId} does not exist`)
  if (provider.state !== 'DRAINING') throw new LifecycleGuardError('NOT_DRAINING', `Provider ${providerId} must be draining before cleanup completes`)
  if (provider.relianceCount > 0) {
    throw new LifecycleGuardError('PROVIDER_STILL_REFERENCED', `Provider ${providerId} has ${provider.relianceCount} committed bindings`)
  }
  const proof = cleanupReference(providerId, receipt)
  if (provider.cleanupReceipt) {
    if (provider.cleanupReceipt.receiptId === proof.receiptId && provider.cleanupReceipt.idempotencyKey === proof.idempotencyKey) return snapshot
    throw new LifecycleGuardError('CLEANUP_RECEIPT_CONFLICT', `Provider ${providerId} already has a different cleanup receipt`)
  }
  const next = cloneSnapshot(snapshot)
  const updated = next.providers[providerId]
  if (updated) {
    updated.cleanupComplete = true
    updated.cleanupReceipt = proof
  }
  assertLifecycleInvariants(next)
  return next
}

export function commitBinding(snapshot: LifecycleSnapshot, binding: NewBinding): LifecycleSnapshot {
  if (snapshot.bindings[binding.id]) throw new LifecycleGuardError('DUPLICATE_BINDING', `Binding ${binding.id} already exists`)
  const provider = snapshot.providers[binding.providerId]
  if (!provider) throw new LifecycleGuardError('UNKNOWN_PROVIDER', `Provider ${binding.providerId} does not exist`)
  if (provider.version !== binding.providerVersion) {
    throw new LifecycleGuardError('PROVIDER_VERSION_MISMATCH', `Binding requires ${binding.providerId}@${binding.providerVersion}, found ${provider.version}`)
  }
  if (provider.state !== 'ACTIVE' || !provider.acceptingNewBindings) {
    throw new LifecycleGuardError('PROVIDER_NOT_ACCEPTING', `Provider ${binding.providerId} is ${provider.state} and cannot accept a new binding`)
  }
  const exactBinding = Object.values(snapshot.bindings).find((candidate) =>
    candidate.state === 'COMMITTED' && candidate.consumerId === binding.consumerId && candidate.requirementId === binding.requirementId,
  )
  if (exactBinding) {
    throw new LifecycleGuardError('EXACT_BINDING_ALREADY_COMMITTED', `${binding.consumerId}:${binding.requirementId} is already bound to ${exactBinding.providerId}`)
  }

  const next = cloneSnapshot(snapshot)
  next.bindings[binding.id] = { ...binding, state: 'COMMITTED' }
  const updated = next.providers[binding.providerId]
  if (updated) updated.relianceCount += 1
  assertLifecycleInvariants(next)
  return next
}

export function releaseBinding(snapshot: LifecycleSnapshot, bindingId: string): LifecycleSnapshot {
  const binding = snapshot.bindings[bindingId]
  if (!binding) throw new LifecycleGuardError('UNKNOWN_BINDING', `Binding ${bindingId} does not exist`)
  if (binding.state === 'RELEASED') return snapshot
  const next = cloneSnapshot(snapshot)
  const updatedBinding = next.bindings[bindingId]
  const provider = next.providers[binding.providerId]
  if (!updatedBinding || !provider) throw new LifecycleGuardError('UNKNOWN_PROVIDER', `Provider ${binding.providerId} does not exist`)
  updatedBinding.state = 'RELEASED'
  provider.relianceCount -= 1
  assertLifecycleInvariants(next)
  return next
}

export function assertLifecycleInvariants(snapshot: LifecycleSnapshot): void {
  const exactBindings = new Set<string>()
  const reliance = new Map<string, number>()
  for (const binding of Object.values(snapshot.bindings)) {
    if (binding.state !== 'COMMITTED') continue
    const provider = snapshot.providers[binding.providerId]
    if (!provider) throw new LifecycleGuardError('DANGLING_BINDING', `Binding ${binding.id} references missing provider ${binding.providerId}`)
    if (provider.state === 'INACTIVE') throw new LifecycleGuardError('BOUND_TO_INACTIVE_PROVIDER', `Binding ${binding.id} references inactive provider ${provider.id}`)
    if (provider.version !== binding.providerVersion) throw new LifecycleGuardError('PROVIDER_VERSION_MISMATCH', `Binding ${binding.id} references the wrong provider version`)
    const exactKey = `${binding.consumerId}:${binding.requirementId}`
    if (exactBindings.has(exactKey)) throw new LifecycleGuardError('MULTIPLE_EXACT_BINDINGS', `${exactKey} has more than one committed provider`)
    exactBindings.add(exactKey)
    reliance.set(provider.id, (reliance.get(provider.id) ?? 0) + 1)
  }
  for (const provider of Object.values(snapshot.providers)) {
    if (provider.relianceCount !== (reliance.get(provider.id) ?? 0)) {
      throw new LifecycleGuardError('RELIANCE_COUNT_MISMATCH', `${provider.id} reliance count is ${provider.relianceCount}, expected ${reliance.get(provider.id) ?? 0}`)
    }
    if (provider.acceptingNewBindings !== (provider.state === 'ACTIVE')) {
      throw new LifecycleGuardError('ACCEPTANCE_STATE_MISMATCH', `${provider.id} acceptance flag does not match ${provider.state}`)
    }
    if (provider.state === 'INACTIVE' && provider.relianceCount > 0) {
      throw new LifecycleGuardError('INACTIVE_WITH_RELIANCE', `${provider.id} is inactive with committed bindings`)
    }
    if (provider.cleanupComplete !== (provider.cleanupReceipt !== undefined)) {
      throw new LifecycleGuardError('CLEANUP_RECEIPT_STATE_MISMATCH', `${provider.id} cleanup state is not backed by exactly one receipt`)
    }
    if (provider.state === 'INACTIVE' && !provider.cleanupReceipt) {
      throw new LifecycleGuardError('CLEANUP_RECEIPT_REQUIRED', `${provider.id} is inactive without a committed cleanup receipt`)
    }
  }
}

export function legalTransitions(state: LifecycleStateName): readonly LifecycleStateName[] {
  return transitions[state]
}

import {
  addProvider,
  airDigest,
  assertLifecycleInvariants,
  canonicalJson,
  commitBinding,
  createLifecycleSnapshot,
  markCleanupComplete,
  parseAir,
  releaseBinding,
  transitionProvider,
  type AirBinding,
  type KernlLedger,
  type LifecycleSnapshot,
  type RecoveryClassification,
} from '@kernl/core'

export interface LifecycleTraceEntry {
  step: string
  snapshot: LifecycleSnapshot
}

export interface ReplacementBindingPlan {
  logicalBindingId: string
  consumerId: string
  requirementId: string
  capabilityId: string
  currentRuntimeBindingId: string
  replacementRuntimeBindingId: string
}

export interface QueueProviderReplacementPlan {
  changeId: string
  currentAirVersion: string
  replacementAirVersion: string
  currentAirDigest: string
  replacementAirDigest: string
  componentId: string
  currentProvider: { identity: string; version: string }
  replacementProvider: { identity: string; version: string }
  lifecyclePolicy: {
    replacement: 'DRAIN_THEN_REPLACE'
    drainTimeoutMs: number
    requireCleanup: true
  }
  declaredEffect: {
    id: string
    effectType: string
    resource: string
    recovery: 'COMPENSATABLE'
  }
  bindings: ReplacementBindingPlan[]
}

export interface QueueProviderReplacementResult {
  plan: QueueProviderReplacementPlan
  trace: LifecycleTraceEntry[]
  finalSnapshot: LifecycleSnapshot
  duplicateReceiptSuppressed: boolean
  receiptsInserted: number
}

export class LifecycleReplacementCompileError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'LifecycleReplacementCompileError'
    this.code = code
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function providerIdentity(componentId: string, version: string): string {
  return `${componentId}@${version}`
}

function runtimeBindingId(binding: AirBinding): string {
  return `${binding.id}@${binding.providerVersion}`
}

function compileError(code: string, message: string): never {
  throw new LifecycleReplacementCompileError(code, message)
}

function canonicalById<T extends { id: string }>(items: readonly T[]): string {
  return canonicalJson([...items].sort((left, right) => left.id.localeCompare(right.id)))
}

/** Compile the provider replacement solely from two validated AIR versions. */
export function compileQueueProviderReplacement(
  currentAirInput: unknown,
  replacementAirInput: unknown,
): QueueProviderReplacementPlan {
  const currentAir = parseAir(currentAirInput)
  const replacementAir = parseAir(replacementAirInput)

  if (replacementAir.system.id !== currentAir.system.id) {
    compileError('SYSTEM_MISMATCH', `Cannot replace a provider across systems ${currentAir.system.id} and ${replacementAir.system.id}`)
  }
  if (replacementAir.change.parentAirVersion !== currentAir.airVersion) {
    compileError(
      'PARENT_AIR_MISMATCH',
      `${replacementAir.airVersion} must name ${currentAir.airVersion} as its parent AIR version`,
    )
  }

  const changedQueues = currentAir.components.filter((component) => {
    if (component.kind !== 'QUEUE') return false
    const replacement = replacementAir.components.find(candidate => candidate.id === component.id && candidate.kind === 'QUEUE')
    return replacement !== undefined && replacement.version !== component.version
  })
  if (changedQueues.length !== 1) {
    compileError('QUEUE_REPLACEMENT_CARDINALITY', `Expected exactly one versioned queue replacement, found ${changedQueues.length}`)
  }

  const currentProvider = changedQueues[0]
  if (!currentProvider) compileError('QUEUE_REPLACEMENT_MISSING', 'The current queue provider is missing')
  const replacementProvider = replacementAir.components.find(component => component.id === currentProvider.id && component.kind === 'QUEUE')
  if (!replacementProvider) compileError('QUEUE_REPLACEMENT_MISSING', `Replacement queue ${currentProvider.id} is missing`)

  const currentComponentIds = currentAir.components.map(component => component.id).sort()
  const replacementComponentIds = replacementAir.components.map(component => component.id).sort()
  if (canonicalJson(currentComponentIds) !== canonicalJson(replacementComponentIds)) {
    compileError('COMPONENT_SET_CHANGED', 'A provider replacement cannot add or remove components')
  }
  for (const currentComponent of currentAir.components) {
    const replacementComponent = replacementAir.components.find(component => component.id === currentComponent.id)
    if (!replacementComponent) compileError('COMPONENT_SET_CHANGED', `Component ${currentComponent.id} disappeared during provider replacement`)
    if (currentComponent.id === currentProvider.id) {
      const currentShape = { ...currentComponent, version: '__QUEUE_PROVIDER_VERSION__' }
      const replacementShape = { ...replacementComponent, version: '__QUEUE_PROVIDER_VERSION__' }
      if (canonicalJson(currentShape) !== canonicalJson(replacementShape)) {
        compileError('QUEUE_COMPONENT_SHAPE_CHANGED', `Queue ${currentProvider.id} may change only its component version`)
      }
    } else if (canonicalJson(currentComponent) !== canonicalJson(replacementComponent)) {
      compileError('UNRELATED_COMPONENT_CHANGED', `Component ${currentComponent.id} changed during queue-only replacement`)
    }
  }

  if (canonicalById(currentAir.contracts) !== canonicalById(replacementAir.contracts)) {
    compileError('CONTRACT_SET_CHANGED', 'A queue-only provider replacement cannot add, remove, or modify contracts')
  }

  const normalizeBinding = (binding: AirBinding): AirBinding => ({
    ...binding,
    providerVersion: binding.providerId === currentProvider.id ? '__QUEUE_PROVIDER_VERSION__' : binding.providerVersion,
  })
  if (
    canonicalById(currentAir.bindings.map(normalizeBinding))
    !== canonicalById(replacementAir.bindings.map(normalizeBinding))
  ) {
    compileError('BINDING_SET_MISMATCH', 'A queue-only provider replacement may change only queue binding providerVersion values')
  }

  if (currentProvider.lifecycle.initialState !== 'ACTIVE' || replacementProvider.lifecycle.initialState !== 'ACTIVE') {
    compileError('UNSUPPORTED_INITIAL_STATE', 'The prototype replacement compiler requires both AIR provider versions to declare ACTIVE')
  }
  if (
    currentProvider.lifecycle.replacement !== 'DRAIN_THEN_REPLACE'
    || replacementProvider.lifecycle.replacement !== 'DRAIN_THEN_REPLACE'
    || !currentProvider.lifecycle.requireCleanup
    || !replacementProvider.lifecycle.requireCleanup
  ) {
    compileError('UNSUPPORTED_LIFECYCLE_POLICY', 'The prototype requires DRAIN_THEN_REPLACE with cleanup for both provider versions')
  }

  const declaredEffects = replacementAir.effects.filter(effect =>
    effect.componentId === currentProvider.id && effect.effectType === 'provider.replace',
  )
  if (declaredEffects.length !== 1) {
    compileError('REPLACEMENT_EFFECT_CARDINALITY', `Expected one provider.replace effect for ${currentProvider.id}, found ${declaredEffects.length}`)
  }
  const declaredEffect = declaredEffects[0]
  if (!declaredEffect) compileError('REPLACEMENT_EFFECT_MISSING', `Replacement effect for ${currentProvider.id} is missing`)
  if (declaredEffect.recovery !== 'COMPENSATABLE') {
    compileError('REPLACEMENT_NOT_COMPENSATABLE', `Provider replacement must be COMPENSATABLE, found ${declaredEffect.recovery}`)
  }
  const expectedEffectResource = `${currentProvider.id}:${currentProvider.version}-to-${replacementProvider.version}`
  if (declaredEffect.resource !== expectedEffectResource) {
    compileError(
      'REPLACEMENT_RESOURCE_MISMATCH',
      `Provider replacement effect must name exact resource ${expectedEffectResource}, found ${declaredEffect.resource}`,
    )
  }

  const currentBindings = currentAir.bindings
    .filter(binding => binding.providerId === currentProvider.id)
    .sort((left, right) => left.id.localeCompare(right.id))
  const replacementBindings = replacementAir.bindings.filter(binding => binding.providerId === replacementProvider.id)
  if (currentBindings.length === 0 || currentBindings.length !== replacementBindings.length) {
    compileError(
      'BINDING_SET_MISMATCH',
      `Replacement must preserve all exact inbound bindings (${currentBindings.length} current, ${replacementBindings.length} replacement)`,
    )
  }

  const bindings = currentBindings.map((currentBinding): ReplacementBindingPlan => {
    const replacementBinding = replacementBindings.find(candidate => candidate.id === currentBinding.id)
    if (!replacementBinding) compileError('BINDING_SET_MISMATCH', `Replacement binding ${currentBinding.id} is missing`)
    const stableFields = ['consumerId', 'requirementId', 'providerId', 'capabilityId'] as const
    for (const field of stableFields) {
      if (currentBinding[field] !== replacementBinding[field]) {
        compileError('BINDING_IDENTITY_CHANGED', `${currentBinding.id} changed ${field} during provider replacement`)
      }
    }
    if (currentBinding.providerVersion !== currentProvider.version || replacementBinding.providerVersion !== replacementProvider.version) {
      compileError('BINDING_VERSION_MISMATCH', `${currentBinding.id} is not bound to the exact AIR provider versions`)
    }
    return {
      logicalBindingId: currentBinding.id,
      consumerId: currentBinding.consumerId,
      requirementId: currentBinding.requirementId,
      capabilityId: currentBinding.capabilityId,
      currentRuntimeBindingId: runtimeBindingId(currentBinding),
      replacementRuntimeBindingId: runtimeBindingId(replacementBinding),
    }
  })

  return {
    changeId: replacementAir.change.id,
    currentAirVersion: currentAir.airVersion,
    replacementAirVersion: replacementAir.airVersion,
    currentAirDigest: airDigest(currentAir),
    replacementAirDigest: airDigest(replacementAir),
    componentId: currentProvider.id,
    currentProvider: {
      identity: providerIdentity(currentProvider.id, currentProvider.version),
      version: currentProvider.version,
    },
    replacementProvider: {
      identity: providerIdentity(replacementProvider.id, replacementProvider.version),
      version: replacementProvider.version,
    },
    lifecyclePolicy: {
      replacement: 'DRAIN_THEN_REPLACE',
      drainTimeoutMs: replacementProvider.lifecycle.drainTimeoutMs,
      requireCleanup: true,
    },
    declaredEffect: {
      id: declaredEffect.id,
      effectType: declaredEffect.effectType,
      resource: declaredEffect.resource,
      recovery: declaredEffect.recovery,
    },
    bindings,
  }
}

/** Execute an AIR-compiled replacement and persist every mutation receipt. */
export function runQueueProviderReplacement(
  ledger: KernlLedger,
  runId: string,
  currentAirInput: unknown,
  replacementAirInput: unknown,
): QueueProviderReplacementResult {
  const plan = compileQueueProviderReplacement(currentAirInput, replacementAirInput)
  const episodeId = `${runId}:${plan.changeId}`
  const taskId = `lifecycle:${plan.changeId}`
  const trace: LifecycleTraceEntry[] = []
  let snapshot = createLifecycleSnapshot()
  let receiptsInserted = 0

  const record = (step: string): void => {
    assertLifecycleInvariants(snapshot)
    const entry = { step, snapshot: clone(snapshot) }
    trace.push(entry)
    ledger.appendEvent(runId, 'LIFECYCLE_STATE_CHANGED', {
      ...entry,
      currentAirVersion: plan.currentAirVersion,
      replacementAirVersion: plan.replacementAirVersion,
      changeId: plan.changeId,
    })
  }

  const receipt = (input: {
    operation: string
    componentId?: string
    effectType: string
    resourceIdentity: string
    preconditions: unknown
    result: unknown
    resultingState: string
    recoveryClassification?: RecoveryClassification
  }) => {
    const persisted = ledger.appendEffectReceipt({
      runId,
      episodeId,
      componentId: input.componentId ?? plan.componentId,
      taskId,
      effectType: input.effectType,
      resourceIdentity: input.resourceIdentity,
      idempotencyKey: `${episodeId}:${input.operation}`,
      preconditions: input.preconditions,
      result: input.result,
      resultingState: input.resultingState,
      recoveryClassification: input.recoveryClassification ?? 'RETRY_SAFE',
      recoveryMetadata: {
        declaredEffectId: plan.declaredEffect.id,
        compensation: 'restore-prior-exact-binding',
        drainTimeoutMs: plan.lifecyclePolicy.drainTimeoutMs,
      },
      provenance: {
        changeId: plan.changeId,
        currentAirVersion: plan.currentAirVersion,
        currentAirDigest: plan.currentAirDigest,
        replacementAirVersion: plan.replacementAirVersion,
        replacementAirDigest: plan.replacementAirDigest,
        lifecyclePolicy: plan.lifecyclePolicy.replacement,
        actor: 'kernl-lifecycle-kernel',
      },
    })
    if (persisted.inserted) receiptsInserted += 1
    return persisted
  }

  const transition = (providerId: string, from: string, to: 'LOADING' | 'ACTIVE' | 'RETIRING' | 'DRAINING' | 'INACTIVE'): void => {
    const before = snapshot.providers[providerId]
    if (!before) throw new Error(`Lifecycle provider ${providerId} disappeared before ${from} -> ${to}`)
    snapshot = transitionProvider(snapshot, providerId, to)
    const after = snapshot.providers[providerId]
    receipt({
      operation: `${providerId}:${from}->${to}`,
      effectType: 'provider.lifecycle',
      resourceIdentity: providerId,
      preconditions: { provider: clone(before), targetState: to, policy: plan.lifecyclePolicy.replacement },
      result: { provider: clone(after) },
      resultingState: to,
    })
    record(`${providerId}:${to}`)
  }

  snapshot = addProvider(snapshot, { id: plan.currentProvider.identity, version: plan.currentProvider.version })
  receipt({
    operation: `${plan.currentProvider.identity}:declare`,
    effectType: 'provider.lifecycle',
    resourceIdentity: plan.currentProvider.identity,
    preconditions: { absent: true, airVersion: plan.currentAirVersion },
    result: { version: plan.currentProvider.version },
    resultingState: 'PENDING',
  })
  record(`${plan.currentProvider.identity}:PENDING`)
  transition(plan.currentProvider.identity, 'PENDING', 'LOADING')
  transition(plan.currentProvider.identity, 'LOADING', 'ACTIVE')

  for (const binding of plan.bindings) {
    const providerBeforeCommit = clone(snapshot.providers[plan.currentProvider.identity])
    snapshot = commitBinding(snapshot, {
      id: binding.currentRuntimeBindingId,
      consumerId: binding.consumerId,
      requirementId: binding.requirementId,
      providerId: plan.currentProvider.identity,
      providerVersion: plan.currentProvider.version,
    })
    ledger.putBinding({
      id: binding.currentRuntimeBindingId,
      runId,
      consumerId: binding.consumerId,
      requirementId: binding.requirementId,
      providerId: plan.currentProvider.identity,
      providerVersion: plan.currentProvider.version,
      state: 'COMMITTED',
      relianceCount: snapshot.providers[plan.currentProvider.identity]?.relianceCount ?? 0,
    })
    receipt({
      operation: `${binding.currentRuntimeBindingId}:commit`,
      effectType: 'binding.commit',
      resourceIdentity: `${binding.consumerId}:${binding.requirementId}`,
      preconditions: { exactBindingAbsent: true, provider: providerBeforeCommit },
      result: { bindingId: binding.currentRuntimeBindingId, providerId: plan.currentProvider.identity },
      resultingState: 'COMMITTED',
      recoveryClassification: plan.declaredEffect.recovery,
    })
  }
  record(`${plan.currentProvider.identity}:${plan.bindings.length}-committed-bindings`)

  const replacementPreconditions = {
    currentProvider: clone(snapshot.providers[plan.currentProvider.identity]),
    replacementProviderAbsent: snapshot.providers[plan.replacementProvider.identity] === undefined,
    exactBindings: plan.bindings.map(binding => clone(snapshot.bindings[binding.currentRuntimeBindingId])),
    lifecyclePolicy: clone(plan.lifecyclePolicy),
    declaredResource: plan.declaredEffect.resource,
  }

  transition(plan.currentProvider.identity, 'ACTIVE', 'RETIRING')
  transition(plan.currentProvider.identity, 'RETIRING', 'DRAINING')

  snapshot = addProvider(snapshot, { id: plan.replacementProvider.identity, version: plan.replacementProvider.version })
  receipt({
    operation: `${plan.replacementProvider.identity}:declare`,
    effectType: 'provider.lifecycle',
    resourceIdentity: plan.replacementProvider.identity,
    preconditions: { absent: true, airVersion: plan.replacementAirVersion, currentProviderState: 'DRAINING' },
    result: { version: plan.replacementProvider.version },
    resultingState: 'PENDING',
  })
  record(`${plan.replacementProvider.identity}:PENDING`)
  transition(plan.replacementProvider.identity, 'PENDING', 'LOADING')
  transition(plan.replacementProvider.identity, 'LOADING', 'ACTIVE')

  for (const binding of plan.bindings) {
    const bindingBeforeRelease = clone(snapshot.bindings[binding.currentRuntimeBindingId])
    const providerBeforeRelease = clone(snapshot.providers[plan.currentProvider.identity])
    snapshot = releaseBinding(snapshot, binding.currentRuntimeBindingId)
    ledger.putBinding({
      id: binding.currentRuntimeBindingId,
      runId,
      consumerId: binding.consumerId,
      requirementId: binding.requirementId,
      providerId: plan.currentProvider.identity,
      providerVersion: plan.currentProvider.version,
      state: 'RELEASED',
      relianceCount: snapshot.providers[plan.currentProvider.identity]?.relianceCount ?? 0,
    })
    receipt({
      operation: `${binding.currentRuntimeBindingId}:release`,
      effectType: 'binding.release',
      resourceIdentity: `${binding.consumerId}:${binding.requirementId}`,
      preconditions: { binding: bindingBeforeRelease, provider: providerBeforeRelease },
      result: { bindingId: binding.currentRuntimeBindingId, providerId: plan.currentProvider.identity },
      resultingState: 'RELEASED',
      recoveryClassification: plan.declaredEffect.recovery,
    })

    const replacementProviderBeforeCommit = clone(snapshot.providers[plan.replacementProvider.identity])
    snapshot = commitBinding(snapshot, {
      id: binding.replacementRuntimeBindingId,
      consumerId: binding.consumerId,
      requirementId: binding.requirementId,
      providerId: plan.replacementProvider.identity,
      providerVersion: plan.replacementProvider.version,
    })
    ledger.putBinding({
      id: binding.replacementRuntimeBindingId,
      runId,
      consumerId: binding.consumerId,
      requirementId: binding.requirementId,
      providerId: plan.replacementProvider.identity,
      providerVersion: plan.replacementProvider.version,
      state: 'COMMITTED',
      relianceCount: snapshot.providers[plan.replacementProvider.identity]?.relianceCount ?? 0,
    })
    receipt({
      operation: `${binding.replacementRuntimeBindingId}:commit`,
      effectType: 'binding.commit',
      resourceIdentity: `${binding.consumerId}:${binding.requirementId}`,
      preconditions: {
        priorBindingId: binding.currentRuntimeBindingId,
        priorBindingState: 'RELEASED',
        provider: replacementProviderBeforeCommit,
      },
      result: { bindingId: binding.replacementRuntimeBindingId, providerId: plan.replacementProvider.identity },
      resultingState: 'COMMITTED',
      recoveryClassification: plan.declaredEffect.recovery,
    })
    record(`${binding.logicalBindingId}:rebound-to-${plan.replacementProvider.identity}`)
  }

  const providerBeforeCleanup = clone(snapshot.providers[plan.currentProvider.identity])
  const cleanupEffect = receipt({
    operation: `${plan.currentProvider.identity}:cleanup`,
    effectType: 'provider.cleanup',
    resourceIdentity: plan.currentProvider.identity,
    preconditions: { provider: providerBeforeCleanup, requireCleanup: plan.lifecyclePolicy.requireCleanup },
    result: { cleanupComplete: true },
    resultingState: 'CLEANUP_COMPLETE',
    recoveryClassification: plan.declaredEffect.recovery,
  })
  snapshot = markCleanupComplete(snapshot, plan.currentProvider.identity, cleanupEffect.receipt)
  record(`${plan.currentProvider.identity}:cleanup-complete`)
  transition(plan.currentProvider.identity, 'DRAINING', 'INACTIVE')

  const completionInput = {
    operation: plan.declaredEffect.id,
    effectType: plan.declaredEffect.effectType,
    resourceIdentity: plan.declaredEffect.resource,
    preconditions: replacementPreconditions,
    result: {
      currentProvider: { identity: plan.currentProvider.identity, state: 'INACTIVE' },
      replacementProvider: { identity: plan.replacementProvider.identity, state: 'ACTIVE' },
      reboundBindings: plan.bindings.map(binding => binding.replacementRuntimeBindingId),
    },
    resultingState: 'COMPLETED',
    recoveryClassification: plan.declaredEffect.recovery,
  } as const
  const completion = receipt(completionInput)
  const duplicate = receipt(completionInput)
  const duplicateReceiptSuppressed = !duplicate.inserted && duplicate.receipt.id === completion.receipt.id

  assertLifecycleInvariants(snapshot)
  return { plan, trace, finalSnapshot: snapshot, duplicateReceiptSuppressed, receiptsInserted }
}

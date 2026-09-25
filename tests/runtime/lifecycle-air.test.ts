import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KernlLedger, parseAir, type AirDocument } from '@kernl/core'
import {
  LifecycleReplacementCompileError,
  compileQueueProviderReplacement,
  runQueueProviderReplacement,
} from '@kernl/runtime'

const fixtureDirectory = new URL('../../fixtures/air/', import.meta.url)

function fixture(name: string): AirDocument {
  return parseAir(JSON.parse(readFileSync(fileURLToPath(new URL(name, fixtureDirectory)), 'utf8')) as unknown)
}

function changedTargetVersion(air: AirDocument, version: string): AirDocument {
  const changed = structuredClone(air)
  const queue = changed.components.find(component => component.id === 'queue')
  if (!queue) throw new Error('queue fixture is missing')
  queue.version = version
  for (const binding of changed.bindings) {
    if (binding.providerId === queue.id) binding.providerVersion = version
  }
  const replacementEffect = changed.effects.find(effect => effect.effectType === 'provider.replace' && effect.componentId === queue.id)
  if (!replacementEffect) throw new Error('queue replacement effect fixture is missing')
  replacementEffect.resource = `queue:1.0.0-to-${version}`
  changed.airVersion = `${air.airVersion}-${version}`
  return parseAir(changed)
}

describe('AIR-driven provider replacement', () => {
  it('compiles provider identities, exact bindings, policy, and compensatable effect from AIR', () => {
    const current = fixture('after.json')
    const replacement = changedTargetVersion(fixture('queue-v2.json'), '9.7.0')
    const plan = compileQueueProviderReplacement(current, replacement)

    expect(plan).toMatchObject({
      changeId: replacement.change.id,
      currentAirVersion: current.airVersion,
      replacementAirVersion: replacement.airVersion,
      componentId: 'queue',
      currentProvider: { identity: 'queue@1.0.0', version: '1.0.0' },
      replacementProvider: { identity: 'queue@9.7.0', version: '9.7.0' },
      lifecyclePolicy: {
        replacement: 'DRAIN_THEN_REPLACE',
        drainTimeoutMs: 30_000,
        requireCleanup: true,
      },
      declaredEffect: {
        id: 'replace-queue',
        effectType: 'provider.replace',
        resource: 'queue:1.0.0-to-9.7.0',
        recovery: 'COMPENSATABLE',
      },
    })
    expect(plan.bindings).toEqual([
      {
        logicalBindingId: 'api-to-queue',
        consumerId: 'api',
        requirementId: 'enqueue-job',
        capabilityId: 'jobs.enqueue',
        currentRuntimeBindingId: 'api-to-queue@1.0.0',
        replacementRuntimeBindingId: 'api-to-queue@9.7.0',
      },
      {
        logicalBindingId: 'worker-to-queue',
        consumerId: 'worker',
        requirementId: 'dequeue-job',
        capabilityId: 'jobs.dequeue',
        currentRuntimeBindingId: 'worker-to-queue@1.0.0',
        replacementRuntimeBindingId: 'worker-to-queue@9.7.0',
      },
    ])
  })

  it('executes ACTIVE -> RETIRING -> DRAINING -> INACTIVE and exactly rebinds every AIR consumer', () => {
    const current = fixture('after.json')
    const replacement = fixture('queue-v2.json')
    const ledger = new KernlLedger(':memory:')
    try {
      const stored = ledger.putAir(current)
      ledger.createRun({ id: 'run-air-lifecycle', airDigest: stored.digest, sourceCommit: 'source-commit' })

      const result = runQueueProviderReplacement(ledger, 'run-air-lifecycle', current, replacement)
      const oldProviderId = result.plan.currentProvider.identity
      const newProviderId = result.plan.replacementProvider.identity
      const observedOldStates = result.trace
        .map(entry => entry.snapshot.providers[oldProviderId]?.state)
        .filter((state, index, states) => state !== undefined && state !== states[index - 1])

      expect(observedOldStates).toEqual(['PENDING', 'LOADING', 'ACTIVE', 'RETIRING', 'DRAINING', 'INACTIVE'])
      expect(result.finalSnapshot.providers[oldProviderId]).toMatchObject({
        version: '1.0.0', state: 'INACTIVE', acceptingNewBindings: false, relianceCount: 0, cleanupComplete: true,
      })
      expect(result.finalSnapshot.providers[newProviderId]).toMatchObject({
        version: '2.0.0', state: 'ACTIVE', acceptingNewBindings: true, relianceCount: 2,
      })
      expect(result.duplicateReceiptSuppressed).toBe(true)

      for (const binding of result.plan.bindings) {
        expect(result.finalSnapshot.bindings[binding.currentRuntimeBindingId]).toMatchObject({
          consumerId: binding.consumerId,
          requirementId: binding.requirementId,
          providerId: oldProviderId,
          state: 'RELEASED',
        })
        expect(result.finalSnapshot.bindings[binding.replacementRuntimeBindingId]).toMatchObject({
          consumerId: binding.consumerId,
          requirementId: binding.requirementId,
          providerId: newProviderId,
          state: 'COMMITTED',
        })
      }

      const persistedBindings = ledger.listBindings('run-air-lifecycle')
      expect(persistedBindings.filter(binding => binding.state === 'COMMITTED')).toHaveLength(result.plan.bindings.length)
      expect(persistedBindings.filter(binding => binding.state === 'COMMITTED').every(binding => binding.providerId === newProviderId)).toBe(true)
      for (const binding of result.plan.bindings) {
        const exact = persistedBindings.filter(candidate =>
          candidate.consumerId === binding.consumerId
          && candidate.requirementId === binding.requirementId
          && candidate.state === 'COMMITTED',
        )
        expect(exact).toHaveLength(1)
        expect(exact[0]?.providerVersion).toBe('2.0.0')
      }

      const effects = ledger.listEffects('run-air-lifecycle')
      expect(effects).toHaveLength(result.receiptsInserted)
      expect(new Set(effects.map(effect => effect.idempotencyKey)).size).toBe(effects.length)
      expect(effects.find(effect => effect.effectType === 'provider.replace')).toMatchObject({
        resourceIdentity: replacement.effects.find(effect => effect.id === 'replace-queue')?.resource,
        recoveryClassification: 'COMPENSATABLE',
        resultingState: 'COMPLETED',
      })
      expect(effects.filter(effect => effect.effectType.startsWith('binding.'))).toHaveLength(result.plan.bindings.length * 3)
      expect(effects.filter(effect => effect.effectType.startsWith('binding.')).every(effect => effect.recoveryClassification === 'COMPENSATABLE')).toBe(true)
      expect(effects.every(effect =>
        (effect.provenance as Record<string, unknown>).replacementAirVersion === replacement.airVersion,
      )).toBe(true)
    } finally {
      ledger.close()
    }
  })

  it('rejects a valid AIR document that silently changes a logical binding during replacement', () => {
    const current = fixture('after.json')
    const replacement = structuredClone(fixture('queue-v2.json'))
    const binding = replacement.bindings.find(candidate => candidate.id === 'api-to-queue')
    if (!binding) throw new Error('api binding fixture is missing')
    binding.id = 'api-to-queue-renamed'

    expect(() => compileQueueProviderReplacement(current, replacement)).toThrowError(
      expect.objectContaining<Partial<LifecycleReplacementCompileError>>({ code: 'BINDING_SET_MISMATCH' }),
    )
  })

  it('rejects replacement AIR without its declared compensatable effect', () => {
    const current = fixture('after.json')
    const replacement = structuredClone(fixture('queue-v2.json'))
    const effect = replacement.effects.find(candidate => candidate.id === 'replace-queue')
    if (!effect) throw new Error('replacement effect fixture is missing')
    effect.recovery = 'RETRY_SAFE'

    expect(() => compileQueueProviderReplacement(current, replacement)).toThrowError(
      expect.objectContaining<Partial<LifecycleReplacementCompileError>>({ code: 'REPLACEMENT_NOT_COMPENSATABLE' }),
    )
  })

  it('rejects an unrelated component change hidden inside a queue replacement', () => {
    const current = fixture('after.json')
    const replacement = structuredClone(fixture('queue-v2.json'))
    const api = replacement.components.find(component => component.id === 'api')
    if (!api) throw new Error('api fixture is missing')
    api.version = '99.0.0'

    expect(() => compileQueueProviderReplacement(current, replacement)).toThrowError(
      expect.objectContaining<Partial<LifecycleReplacementCompileError>>({ code: 'UNRELATED_COMPONENT_CHANGED' }),
    )
  })

  it('rejects a contract change hidden inside a queue replacement', () => {
    const current = fixture('after.json')
    const replacement = structuredClone(fixture('queue-v2.json'))
    const contract = replacement.contracts.find(candidate => candidate.id === 'queued-job-v1')
    if (!contract) throw new Error('event contract fixture is missing')
    contract.schema = { eventId: 'string', jobId: 'string', value: 'number' }

    expect(() => compileQueueProviderReplacement(current, replacement)).toThrowError(
      expect.objectContaining<Partial<LifecycleReplacementCompileError>>({ code: 'CONTRACT_SET_CHANGED' }),
    )
  })
})

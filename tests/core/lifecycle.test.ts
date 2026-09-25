import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  LifecycleGuardError,
  addProvider,
  assertLifecycleInvariants,
  commitBinding,
  createLifecycleSnapshot,
  legalTransitions,
  markCleanupComplete,
  releaseBinding,
  transitionProvider,
  type CleanupEffectReceiptProof,
  type LifecycleSnapshot,
} from '../../packages/core/src/index.js'

function activeProvider(id = 'queue-v1', version = '1.0.0'): LifecycleSnapshot {
  let snapshot = createLifecycleSnapshot()
  snapshot = addProvider(snapshot, { id, version })
  snapshot = transitionProvider(snapshot, id, 'LOADING')
  return transitionProvider(snapshot, id, 'ACTIVE')
}

function cleanupProof(providerId = 'queue-v1', suffix = '1'): CleanupEffectReceiptProof {
  return {
    id: `cleanup-receipt-${suffix}`,
    effectType: 'provider.cleanup',
    resourceIdentity: providerId,
    idempotencyKey: `${providerId}:cleanup:${suffix}`,
    result: { cleanupComplete: true },
    resultingState: 'CLEANUP_COMPLETE',
    recoveryClassification: 'COMPENSATABLE',
    committedAt: '2026-08-20T00:00:00.000Z',
  }
}

describe('provider and binding lifecycle', () => {
  it('drains existing reliance while refusing new bindings, then becomes inactive', () => {
    let snapshot = activeProvider()
    snapshot = commitBinding(snapshot, {
      id: 'api-queue-v1', consumerId: 'api', requirementId: 'enqueue', providerId: 'queue-v1', providerVersion: '1.0.0',
    })
    snapshot = transitionProvider(snapshot, 'queue-v1', 'RETIRING')

    expect(() => commitBinding(snapshot, {
      id: 'worker-queue-v1', consumerId: 'worker', requirementId: 'dequeue', providerId: 'queue-v1', providerVersion: '1.0.0',
    })).toThrowError(expect.objectContaining({ code: 'PROVIDER_NOT_ACCEPTING' }))

    snapshot = transitionProvider(snapshot, 'queue-v1', 'DRAINING')
    expect(() => transitionProvider(snapshot, 'queue-v1', 'INACTIVE'))
      .toThrowError(expect.objectContaining({ code: 'PROVIDER_STILL_REFERENCED' }))
    snapshot = releaseBinding(snapshot, 'api-queue-v1')
    expect(() => transitionProvider(snapshot, 'queue-v1', 'INACTIVE', { cleanupComplete: true } as never))
      .toThrowError(expect.objectContaining({ code: 'CLEANUP_RECEIPT_REQUIRED' }))
    snapshot = markCleanupComplete(snapshot, 'queue-v1', cleanupProof())
    snapshot = transitionProvider(snapshot, 'queue-v1', 'INACTIVE')
    expect(snapshot.providers['queue-v1']).toMatchObject({
      state: 'INACTIVE',
      relianceCount: 0,
      acceptingNewBindings: false,
      cleanupReceipt: { receiptId: 'cleanup-receipt-1', idempotencyKey: 'queue-v1:cleanup:1' },
    })
    assertLifecycleInvariants(snapshot)
  })

  it('requires a committed cleanup receipt for the exact draining provider', () => {
    let snapshot = activeProvider()
    snapshot = transitionProvider(snapshot, 'queue-v1', 'RETIRING')
    snapshot = transitionProvider(snapshot, 'queue-v1', 'DRAINING')

    expect(() => markCleanupComplete(snapshot, 'queue-v1', { ...cleanupProof(), committedAt: '' }))
      .toThrowError(expect.objectContaining({ code: 'CLEANUP_RECEIPT_INVALID' }))
    expect(() => markCleanupComplete(snapshot, 'queue-v1', cleanupProof('another-provider')))
      .toThrowError(expect.objectContaining({ code: 'CLEANUP_RECEIPT_RESOURCE_MISMATCH' }))
    expect(() => markCleanupComplete(snapshot, 'queue-v1', { ...cleanupProof(), result: { cleanupComplete: false } }))
      .toThrowError(expect.objectContaining({ code: 'CLEANUP_RECEIPT_RESULT_MISMATCH' }))

    const proof = cleanupProof()
    snapshot = markCleanupComplete(snapshot, 'queue-v1', proof)
    expect(markCleanupComplete(snapshot, 'queue-v1', proof)).toBe(snapshot)
    expect(() => markCleanupComplete(snapshot, 'queue-v1', cleanupProof('queue-v1', '2')))
      .toThrowError(expect.objectContaining({ code: 'CLEANUP_RECEIPT_CONFLICT' }))
  })

  it('commits one exact provider binding at a time during replacement', () => {
    let snapshot = activeProvider()
    snapshot = commitBinding(snapshot, {
      id: 'consumer-v1', consumerId: 'worker', requirementId: 'dequeue', providerId: 'queue-v1', providerVersion: '1.0.0',
    })
    snapshot = addProvider(snapshot, { id: 'queue-v2', version: '2.0.0' })
    snapshot = transitionProvider(snapshot, 'queue-v2', 'LOADING')
    snapshot = transitionProvider(snapshot, 'queue-v2', 'ACTIVE')
    expect(() => commitBinding(snapshot, {
      id: 'consumer-v2', consumerId: 'worker', requirementId: 'dequeue', providerId: 'queue-v2', providerVersion: '2.0.0',
    })).toThrowError(expect.objectContaining({ code: 'EXACT_BINDING_ALREADY_COMMITTED' }))
    snapshot = releaseBinding(snapshot, 'consumer-v1')
    snapshot = commitBinding(snapshot, {
      id: 'consumer-v2', consumerId: 'worker', requirementId: 'dequeue', providerId: 'queue-v2', providerVersion: '2.0.0',
    })
    expect(snapshot.providers['queue-v2']?.relianceCount).toBe(1)
    assertLifecycleInvariants(snapshot)
  })

  it('allows only declared state transitions and requires a failure reason', () => {
    const snapshot = createLifecycleSnapshot([{ id: 'queue', version: '1.0.0', state: 'PENDING' }])
    expect(legalTransitions('PENDING')).toEqual(['LOADING'])
    expect(() => transitionProvider(snapshot, 'queue', 'ACTIVE')).toThrow(LifecycleGuardError)
    const loading = transitionProvider(snapshot, 'queue', 'LOADING')
    expect(() => transitionProvider(loading, 'queue', 'FAILED')).toThrowError(expect.objectContaining({ code: 'FAILURE_REASON_REQUIRED' }))
    expect(transitionProvider(loading, 'queue', 'FAILED', { failure: 'health check failed' }).providers.queue?.state).toBe('FAILED')
  })
})

describe('lifecycle properties', () => {
  it('no sequence of accepted commands can violate lifecycle invariants', () => {
    const command = fc.constantFrom('retire', 'drain', 'release', 'cleanup', 'inactive', 'duplicate-release' as const)
    fc.assert(fc.property(fc.array(command, { minLength: 0, maxLength: 40 }), (commands) => {
      let snapshot = activeProvider()
      snapshot = commitBinding(snapshot, {
        id: 'binding', consumerId: 'consumer', requirementId: 'queue', providerId: 'queue-v1', providerVersion: '1.0.0',
      })
      for (const action of commands) {
        try {
          if (action === 'retire') snapshot = transitionProvider(snapshot, 'queue-v1', 'RETIRING')
          if (action === 'drain') snapshot = transitionProvider(snapshot, 'queue-v1', 'DRAINING')
          if (action === 'release' || action === 'duplicate-release') snapshot = releaseBinding(snapshot, 'binding')
          if (action === 'cleanup') snapshot = markCleanupComplete(snapshot, 'queue-v1', cleanupProof())
          if (action === 'inactive') snapshot = transitionProvider(snapshot, 'queue-v1', 'INACTIVE')
        } catch (error) {
          expect(error).toBeInstanceOf(LifecycleGuardError)
        }
        assertLifecycleInvariants(snapshot)
      }
      const provider = snapshot.providers['queue-v1']
      expect(provider?.state === 'INACTIVE' && provider.relianceCount > 0).toBe(false)
    }), { numRuns: 250 })
  })

  it('reliance count always equals the number of committed bindings', () => {
    fc.assert(fc.property(fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/), { maxLength: 25 }), (consumerIds) => {
      let snapshot = activeProvider('provider', '1')
      for (const consumerId of consumerIds) {
        snapshot = commitBinding(snapshot, {
          id: `binding-${consumerId}`, consumerId, requirementId: 'requirement', providerId: 'provider', providerVersion: '1',
        })
      }
      expect(snapshot.providers.provider?.relianceCount).toBe(consumerIds.length)
      for (const consumerId of consumerIds) snapshot = releaseBinding(snapshot, `binding-${consumerId}`)
      expect(snapshot.providers.provider?.relianceCount).toBe(0)
      assertLifecycleInvariants(snapshot)
    }), { numRuns: 150 })
  })
})

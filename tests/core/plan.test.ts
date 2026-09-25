import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PlanValidationError,
  airDigest,
  applyDraft,
  compileArchitecturePlan,
  parseAir,
  parseCatalog,
  repairStepFor,
  validateDraft,
  type ArchitectureDraft,
} from '../../packages/core/src/index.js'
import type { AirDocument } from '../../packages/core/src/index.js'

const fixtureDirectory = new URL('../../fixtures/', import.meta.url)

function fixture(relative: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relative, fixtureDirectory)), 'utf8')) as unknown
}

function loadCatalog() {
  return parseCatalog(fixture('catalog/kernl-local-catalog.json'))
}

function baseAir(): AirDocument {
  return parseAir(fixture('air/before.json'))
}

function scenarioOneDraft(): ArchitectureDraft {
  const air = baseAir()
  const catalog = loadCatalog()
  const draft: ArchitectureDraft = {
    schemaVersion: '1.0',
    draftId: 'sync-to-queue-via-catalog',
    systemId: air.system.id,
    title: 'sync to queue',
    intent: 'Replace synchronous execution with a queued pipeline.',
    baseAirVersion: air.airVersion,
    baseAirDigest: airDigest(air),
    componentOps: [
      { op: 'ADD', componentId: 'queue', catalogType: 'QUEUE', catalogId: 'queue', catalogVersion: '1.0.0' },
      { op: 'UPGRADE', componentId: 'api', catalogType: 'HTTP_API', catalogVersion: '2.0.0' },
      { op: 'UPGRADE', componentId: 'worker', catalogType: 'WORKER', catalogVersion: '1.5.0' },
    ],
    contractChanges: [{ op: 'REMOVE', contractId: 'sync-job-v1' }],
    requestedVerification: { gates: ['build', 'unit', 'contract', 'idempotency'] },
    changeNotes: '',
    requestedBy: 'solution-architect',
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
  }
  if (!validateDraft(draft, air, catalog).valid) throw new Error('scenario one draft must be valid')
  return draft
}

function scenarioTwoBase(): AirDocument {
  return applyDraft(scenarioOneDraft(), baseAir(), loadCatalog()).after
}

describe('generic architecture plan compiler', () => {
  it('derives a typed step DAG for the sync-to-queue change', () => {
    const catalog = loadCatalog()
    const compiled = applyDraft(scenarioOneDraft(), baseAir(), catalog)
    const plan = compileArchitecturePlan(baseAir(), compiled.after, { catalog })

    expect(plan.schemaVersion).toBe('2.0')
    const types = plan.steps.map(step => step.type)
    expect(types).toContain('VALIDATE_AIR')
    expect(types).toContain('GENERATE_COMPONENT')
    expect(types.filter(type => type === 'MODIFY_COMPONENT')).toHaveLength(2)
    expect(types).toContain('UPDATE_BINDING')
    expect(types).toContain('UPDATE_CONTRACT')
    expect(types).toContain('VERIFY_COMPONENT')
    expect(types).toContain('VERIFY_SYSTEM')
    expect(types).toContain('REQUEST_APPROVAL')
    expect(types).toContain('PROMOTE')
    expect(types).toContain('REPLAY_ASSERT')
    expect(types).not.toContain('TRANSITION_PROVIDER')

    const generateQueue = plan.steps.find(step => step.id === 'generate:queue')
    expect(generateQueue?.writeScopes).toEqual(['src/queue.ts'])
    expect(generateQueue?.catalogRefs[0]).toMatchObject({ id: 'queue', version: '1.0.0', recipe: 'kernl.queue-microtask@1' })
    expect(generateQueue?.requiredCapabilities).toEqual(['task:implement'])

    // Every mutating step stays inside its AIR write scopes; verification stays read-only.
    for (const step of plan.steps) {
      if (step.type === 'VERIFY_COMPONENT' || step.type === 'VERIFY_SYSTEM') expect(step.writeScopes).toEqual([])
    }

    expect(plan.budgets.maximumTasks).toBe(12)
    expect(plan.budgets.maximumSteps).toBe(20)
    expect(plan.budgets.maximumParallelMutations).toBe(2)
    expect(plan.budgets.maximumRepairAttempts).toBe(3)
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/)

    // Determinism: same inputs produce byte-identical plans.
    const again = compileArchitecturePlan(baseAir(), compiled.after, { catalog })
    expect(again.digest).toBe(plan.digest)

    // Parallelism never exceeds the declared bound.
    for (const group of plan.parallelGroups) expect(group.length).toBeLessThanOrEqual(2)
  })

  it('emits a provider-transition step when an existing provider changes version', () => {
    const catalog = loadCatalog()
    const queued = scenarioTwoBase()
    const second: ArchitectureDraft = {
      schemaVersion: '1.0',
      draftId: 'add-retry-dlq-and-queue-v2',
      systemId: queued.system.id,
      title: 'retry, dead-letter, and queue v2',
      intent: 'Evolve the queued architecture with bounded retry, dead-letter handling, and queue v2.',
      baseAirVersion: queued.airVersion,
      baseAirDigest: airDigest(queued),
      componentOps: [
        { op: 'UPGRADE', componentId: 'queue', catalogType: 'QUEUE', catalogVersion: '2.0.0' },
        { op: 'UPGRADE', componentId: 'worker', catalogType: 'WORKER', catalogVersion: '2.0.0' },
        { op: 'ADD', componentId: 'retry', catalogType: 'POLICY', catalogId: 'retry-policy', catalogVersion: '1.0.0' },
        { op: 'ADD', componentId: 'dead-letter', catalogType: 'FAILURE_SINK', catalogId: 'dead-letter', catalogVersion: '1.0.0' },
      ],
      contractChanges: [],
      requestedVerification: { gates: ['build', 'unit', 'idempotency', 'retry-contract', 'dlq-contract'] },
      changeNotes: '',
      requestedBy: 'solution-architect',
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
    }
    const validation = validateDraft(second, queued, catalog)
    expect(validation.issues).toEqual([])
    const compiled = applyDraft(second, queued, catalog)
    const plan = compileArchitecturePlan(queued, compiled.after, { catalog })

    const transition = plan.steps.find(step => step.type === 'TRANSITION_PROVIDER')
    expect(transition?.id).toBe('transition:queue:1.0.0-to-2.0.0')
    expect(transition?.assertions).toContain('reliance-reaches-zero-before-inactive')
    expect(transition?.dependsOn).toContain('update:bindings')

    const verifySystem = plan.steps.find(step => step.id === 'verify:system')
    expect(verifySystem?.dependsOn).toContain(transition?.id)
    for (const componentId of ['retry', 'dead-letter']) {
      expect(plan.steps.some(step => step.id === `generate:${componentId}`)).toBe(true)
    }
    expect(plan.steps.some(step => step.id === 'modify:worker')).toBe(true)
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('enforces budgets and rejects malformed graphs', () => {
    const catalog = loadCatalog()
    const compiled = applyDraft(scenarioOneDraft(), baseAir(), catalog)
    expect(() => compileArchitecturePlan(baseAir(), compiled.after, { catalog, budgets: { maximumSteps: 5 } }))
      .toThrow(PlanValidationError)
    expect(() => compileArchitecturePlan(baseAir(), baseAir(), {})).toThrow(PlanValidationError)
  })

  it('creates scoped repair steps bound to a failing fingerprint', () => {
    const step = repairStepFor('verify:system', 'worker', ['src/worker.ts'], 'duplicate-event-effect', 1)
    expect(step.type).toBe('REPAIR')
    expect(step.writeScopes).toEqual(['src/worker.ts'])
    expect(step.repairCondition).toEqual({ fingerprint: 'duplicate-event-effect', scopeHint: ['src/worker.ts'] })
    expect(step.requiredCapabilities).toEqual(['task:repair'])
    expect(() => repairStepFor('verify:system', 'worker', [], 'x', 4)).toThrow(RangeError)
  })
})

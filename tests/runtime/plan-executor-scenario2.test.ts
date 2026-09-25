import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  KernlLedger,
  airDigest,
  applyDraft,
  compileArchitecturePlan,
  parseAir,
  parseCatalog,
  validateDraft,
  type AirDocument,
  type ArchitectureDraft,
} from '../../packages/core/src/index.js'
import { ArchitecturePlanExecutor, GitWorkspaceManager } from '../../packages/runtime/src/index.js'

const projectRoot = process.cwd()
const fixtureDir = join(projectRoot, 'fixtures', 'job-system-template')

function readFixture(relative: string): string {
  return readFileSync(join(projectRoot, 'fixtures', relative))
}

const cleanups: Array<{ databasePath: string; runId: string }> = []

afterEach(async () => {
  for (const target of cleanups.splice(0)) {
    await rm(target.databasePath, { force: true })
    await rm(new GitWorkspaceManager(projectRoot).runRepositoryPath(target.runId), { recursive: true, force: true }).catch(() => undefined)
    await rm(join(projectRoot, 'artifacts', 'runs', target.runId), { recursive: true, force: true }).catch(() => undefined)
  }
})

function load(): ReturnType<typeof parseCatalog> {
  return parseCatalog(JSON.parse(readFixture('catalog/kernl-local-catalog.json')))
}

function queuedBase(): AirDocument {
  const catalog = load()
  const before = parseAir(JSON.parse(readFixture('air/before.json')))
  const first: ArchitectureDraft = {
    schemaVersion: '1.0',
    draftId: `seed-queued-${randomUUID().slice(0, 8)}`,
    systemId: before.system.id,
    title: 'sync to queue',
    intent: 'Seed the queued baseline.',
    baseAirVersion: before.airVersion,
    baseAirDigest: airDigest(before),
    componentOps: [
      { op: 'ADD', componentId: 'queue', catalogType: 'QUEUE', catalogId: 'queue', catalogVersion: '1.0.0' },
      { op: 'UPGRADE', componentId: 'api', catalogType: 'HTTP_API', catalogVersion: '2.0.0' },
      { op: 'UPGRADE', componentId: 'worker', catalogType: 'WORKER', catalogVersion: '1.5.0' },
    ],
    contractChanges: [{ op: 'REMOVE', contractId: 'sync-job-v1' }],
    requestedVerification: { gates: ['build'] },
    changeNotes: '',
    requestedBy: 'solution-architect',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  if (!validateDraft(first, before, catalog).valid) throw new Error('seed draft must validate')
  return applyDraft(first, before, catalog).after
}

describe('architecture plan executor — scenario two (retry, dead-letter, queue v2)', () => {
  it('evolves the queued system through a live provider replacement and dead-letter repair drill', { timeout: 900_000 }, async () => {
    const catalog = load()
    const fromAir = queuedBase()
    const second: ArchitectureDraft = {
      schemaVersion: '1.0',
      draftId: `retry-dlq-${randomUUID().slice(0, 8)}`,
      systemId: fromAir.system.id,
      title: 'retry, dead-letter, queue v2',
      intent: 'Evolve the queued architecture with bounded retry, dead-letter handling, and queue v2.',
      baseAirVersion: fromAir.airVersion,
      baseAirDigest: airDigest(fromAir),
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    expect(validateDraft(second, fromAir, catalog).issues).toEqual([])
    const toAir = applyDraft(second, fromAir, catalog).after

    const plan = compileArchitecturePlan(fromAir, toAir, {
      catalog,
      expectedInitialFailure: {
        fingerprint: 'dead-letter-attempts-missing',
        repairStepId: 'generate:dead-letter',
        repairScope: ['src/dead-letter.ts'],
      },
    })

    const runId = `run-plan2-${randomUUID().slice(0, 8)}`
    const databasePath = join(projectRoot, 'data', `kernl-exec2-${randomUUID()}.sqlite`)
    cleanups.push({ databasePath, runId })

    await mkdir(join(projectRoot, 'data'), { recursive: true })
    const ledger = new KernlLedger(databasePath)
    try {
      ledger.putAir(fromAir)
      ledger.putAir(toAir)
      ledger.createRun({ id: runId, airDigest: airDigest(toAir), sourceCommit: 'PENDING_WORKSPACE', status: 'PLANNING' })

      const suspended = await new ArchitecturePlanExecutor(projectRoot, ledger).run({
        runId, plan, fromAir, toAir, catalog, fixtureDir,
      })
      expect(suspended.status).toBe('AWAITING_APPROVAL')
      expect(suspended.error).toBeUndefined()

      const events = ledger.listEvents(runId)

      // The provider transition ran through the full drain lifecycle.
      const lifecycleEvents = events.filter(event => event.type === 'LIFECYCLE_STATE_CHANGED')
      const snapshots = lifecycleEvents.map(event => (event.payload as { snapshot: { providers: Record<string, { state: string }> } }).snapshot.providers)
      const finalProviders = snapshots.at(-1)
      expect(finalProviders?.['queue@1.0.0']?.state).toBe('INACTIVE')
      expect(finalProviders?.['queue@2.0.0']?.state).toBe('ACTIVE')
      expect(lifecycleEvents.length).toBeGreaterThan(8)

      const transitionReceipt = ledger.listEffects(runId).find(effect => effect.effectType === 'PROVIDER_TRANSITION')
      expect(transitionReceipt).toBeDefined()
      const transitionResult = transitionReceipt?.result as { rejectedNewBinding: boolean; rebound: string[] }
      expect(transitionResult.rejectedNewBinding).toBe(true)
      expect(transitionResult.rebound.length).toBeGreaterThanOrEqual(2)

      // The scripted honest defect failed the dlq-contract gate; scoped repair fixed it.
      const defectEvent = events.find(event => event.type === 'SCRIPTED_DEFECT_APPLIED')
      expect((defectEvent?.payload as { fingerprint: string }).fingerprint).toBe('dead-letter-attempts-missing')
      const repairApplied = events.find(event => event.type === 'REPAIR_APPLIED')
      expect((repairApplied?.payload as { scopes: string[] }).scopes).toEqual(['src/dead-letter.ts'])
      const finalPassed = [...events].reverse().find(event =>
        event.type === 'VERIFICATION_FINISHED' && (event.payload as { status: string }).status === 'passed')
      expect(finalPassed).toBeDefined()
      const passedGates = (finalPassed?.payload as { gates: Array<{ name: string; status: string }> }).gates
      for (const gateId of ['retry-contract', 'dlq-contract', 'idempotency']) {
        expect(passedGates.find(gate => gate.name === gateId)?.status).toBe('passed')
      }

      // Restart, approve, resume.
      ledger.close()
      const reopened = new KernlLedger(databasePath)
      try {
        const pending = reopened.listApprovals(runId).find(approval => approval.decision === 'PENDING')
        expect(pending).toBeDefined()
        const evidenceReady = [...events].reverse().find(event => event.type === 'EVIDENCE_READY')
        const evidenceCoreDigest = (evidenceReady?.payload as { evidenceCoreDigest: string }).evidenceCoreDigest
        reopened.decideApproval({
          runId,
          approvalId: pending?.id ?? '',
          decision: 'APPROVED',
          actor: 'solution-architect',
          evidenceDigest: evidenceCoreDigest,
        })
        const resumed = await new ArchitecturePlanExecutor(projectRoot, reopened).run({
          runId, plan, fromAir, toAir, catalog, fixtureDir,
        })
        expect(resumed.status).toBe('PROMOTED')

        const effects = reopened.listEffects(runId)
        const keys = effects.map(effect => effect.idempotencyKey)
        expect(new Set(keys).size).toBe(keys.length)
        const workflow = reopened.getPromotion(runId)?.workflow as { schemaVersion: string; lifecycleOperations: Array<{ componentId: string }> }
        expect(workflow.schemaVersion).toBe('2.0')
        expect(workflow.lifecycleOperations).toEqual([
          { stepId: 'transition:queue:1.0.0-to-2.0.0', componentId: 'queue', kind: 'PROVIDER_TRANSITION' },
        ])
      } finally {
        reopened.close()
      }
    } finally {
      try { ledger.close() } catch { /* closed during restart */ }
    }
  })
})

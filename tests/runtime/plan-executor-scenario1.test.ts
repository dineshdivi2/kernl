import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { access, mkdir, rm } from 'node:fs/promises'
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
  type ArchitectureDraft,
} from '../../packages/core/src/index.js'
import { ArchitecturePlanExecutor, GitWorkspaceManager } from '../../packages/runtime/src/index.js'
import { createHash } from 'node:crypto'
import { digestJson } from '../../packages/core/src/index.js'

const projectRoot = process.cwd()
const fixtureDir = join(projectRoot, 'fixtures', 'job-system-template')

interface CleanupTarget {
  databasePath: string
  runId: string
}

const cleanups: CleanupTarget[] = []

afterEach(async () => {
  for (const target of cleanups.splice(0)) {
    await rm(target.databasePath, { force: true })
    await rm(new GitWorkspaceManager(projectRoot).runRepositoryPath(target.runId), { recursive: true, force: true }).catch(() => undefined)
    await rm(join(projectRoot, 'artifacts', 'runs', target.runId), { recursive: true, force: true }).catch(() => undefined)
  }
})

function scenarioOne(): { draft: ArchitectureDraft; catalog: ReturnType<typeof parseCatalog>; before: ReturnType<typeof parseAir> } {
  const catalog = parseCatalog(JSON.parse(readFixture('catalog/kernl-local-catalog.json')))
  const before = parseAir(JSON.parse(readFixture('air/before.json')))
  const draft: ArchitectureDraft = {
    schemaVersion: '1.0',
    draftId: `sync-to-queue-${randomUUID().slice(0, 8)}`,
    systemId: before.system.id,
    title: 'sync to queue',
    intent: 'Replace synchronous execution with a queued pipeline.',
    baseAirVersion: before.airVersion,
    baseAirDigest: airDigest(before),
    componentOps: [
      { op: 'ADD', componentId: 'queue', catalogType: 'QUEUE', catalogId: 'queue', catalogVersion: '1.0.0' },
      { op: 'UPGRADE', componentId: 'api', catalogType: 'HTTP_API', catalogVersion: '2.0.0' },
      { op: 'UPGRADE', componentId: 'worker', catalogType: 'WORKER', catalogVersion: '1.5.0' },
    ],
    contractChanges: [{ op: 'REMOVE', contractId: 'sync-job-v1' }],
    requestedVerification: { gates: ['build', 'unit', 'contract', 'idempotency'] },
    changeNotes: '',
    requestedBy: 'solution-architect',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  if (!validateDraft(draft, before, catalog).valid) throw new Error('scenario-one draft must validate')
  return { draft, catalog, before }
}

function readFixture(relative: string): string {
  return readFileSync(join(projectRoot, 'fixtures', relative))
}

describe('architecture plan executor — scenario one (sync to queue)', () => {
  it('executes the compiled plan through failure, scoped repair, approval, and promotion', { timeout: 900_000 }, async () => {
    const { draft, catalog, before } = scenarioOne()
    const after = applyDraft(draft, before, catalog).after
    const plan = compileArchitecturePlan(before, after, {
      catalog,
      expectedInitialFailure: {
        fingerprint: 'duplicate-event-effect',
        repairStepId: 'modify:worker',
        repairScope: ['src/worker.ts'],
      },
    })

    const runId = `run-plan1-${randomUUID().slice(0, 8)}`
    const databasePath = join(projectRoot, 'data', `kernl-exec1-${randomUUID()}.sqlite`)
    cleanups.push({ databasePath, runId })

    await mkdir(join(projectRoot, 'data'), { recursive: true })
    const ledger = new KernlLedger(databasePath)
    try {
      ledger.putAir(before)
      ledger.putAir(after)
      ledger.createRun({ id: runId, airDigest: airDigest(after), sourceCommit: 'PENDING_WORKSPACE', status: 'PLANNING' })

      const executor = new ArchitecturePlanExecutor(projectRoot, ledger)
      const suspended = await executor.run({ runId, plan, fromAir: before, toAir: after, catalog, fixtureDir })
      expect(suspended.status).toBe('AWAITING_APPROVAL')
      expect(suspended.error).toBeUndefined()
      // Human review can take longer than the agent's execution budget.
      ledger.database.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z',runId)

      // The honest unguarded consumer failed idempotency; scoped repair fixed it.
      const events = ledger.listEvents(runId)
      const failedVerification = events.find(event =>
        event.type === 'VERIFICATION_FINISHED'
        && (event.payload as { status: string }).status === 'failed')
      expect(failedVerification).toBeDefined()
      const gates = (failedVerification?.payload as { gates: Array<{ name: string; failureFingerprint?: string }> }).gates
      expect(gates.some(gate => gate.failureFingerprint === 'duplicate-event-effect')).toBe(true)

      const repairEvent = events.find(event => event.type === 'REPAIR_APPLIED')
      expect(repairEvent).toBeDefined()
      const repairScopes = (repairEvent?.payload as { scopes: string[] }).scopes
      expect(repairScopes).toEqual(['src/worker.ts'])

      const repairTask = ledger.listTasks(runId).find(task => task.kind === 'REPAIR')
      expect(repairTask?.status).toBe('SUCCEEDED')

      const finalVerification = [...events].reverse().find(event =>
        event.type === 'VERIFICATION_FINISHED'
        && (event.payload as { status: string }).status === 'passed')
      expect(finalVerification).toBeDefined()

      // The run is durably suspended at its approval gate.
      const pending = ledger.listApprovals(runId).find(approval => approval.decision === 'PENDING')
      expect(pending).toBeDefined()
      const evidenceReady = [...events].reverse().find(event => event.type === 'EVIDENCE_READY')
      const evidenceCoreDigest = (evidenceReady?.payload as { evidenceCoreDigest: string }).evidenceCoreDigest
      expect(evidenceCoreDigest).toMatch(/^[a-f0-9]{64}$/)

      // Restart simulation: close and reopen SQLite, then decide the approval.
      ledger.close()
      const reopened = new KernlLedger(databasePath)
      try {
        const decided = reopened.decideApproval({
          runId,
          approvalId: pending?.id ?? '',
          decision: 'APPROVED',
          actor: 'solution-architect',
          evidenceDigest: evidenceCoreDigest,
        })
        expect(decided.decision).toBe('APPROVED')

        const resumed = await new ArchitecturePlanExecutor(projectRoot, reopened).run({
          runId, plan, fromAir: before, toAir: after, catalog, fixtureDir,
        })
        expect(resumed.status).toBe('PROMOTED')
        expect(resumed.error).toBeUndefined()

        const projection = reopened.replayRun(runId)
        expect(projection.status).toBe('PROMOTED')
        expect(projection.promotion).toBeDefined()

        const effects = reopened.listEffects(runId)
        const keys = effects.map(effect => effect.idempotencyKey)
        expect(new Set(keys).size).toBe(keys.length)

        const promotion = reopened.getPromotion(runId)
        expect(promotion).toBeDefined()
        const workflow = promotion?.workflow as { schemaVersion: string; steps: unknown[]; provenance: { candidateCommit: string } }
        expect(workflow.schemaVersion).toBe('2.0')
        expect(workflow.steps.length).toBe(plan.steps.length)
        expect(workflow.provenance.candidateCommit).toMatch(/^[a-f0-9]{40}$/)

        // Real code changes landed in the integration repository.
        const manager = new GitWorkspaceManager(projectRoot)
        const integrationDir = join(manager.runRepositoryPath(runId), 'integration')
        expect(promotion?.sourceCommit).toBe(await manager.currentCommit(integrationDir))
        const baseline = effects.find(effect => effect.effectType === 'RUN_REPOSITORY_CREATE')?.result as { baseCommit: string }
        expect(promotion?.sourceCommit).not.toBe(baseline.baseCommit)
        const artifactRoot = join(projectRoot, 'artifacts', 'runs', runId)
        const core = JSON.parse(readFileSync(join(artifactRoot, 'evidence-core.json'), 'utf8'))
        const { digest, ...sealed } = core
        expect(digestJson(sealed)).toBe(digest)
        expect(digest).toBe(evidenceCoreDigest)
        for (const file of core.files) {
          expect(createHash('sha256').update(readFileSync(join(artifactRoot, file.path))).digest('hex')).toBe(file.sha256)
        }
        await expect(access(join(projectRoot, 'artifacts', 'alpha-v2'))).resolves.toBeUndefined()
      } finally {
        reopened.close()
      }
    } finally {
      try { ledger.close() } catch { /* already closed above */ }
    }
  })
})

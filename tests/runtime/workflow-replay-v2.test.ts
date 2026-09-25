import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  KernlLedger,
  airDigest,
  applyDraft,
  parseAir,
  parseCatalog,
  validateDraft,
  type ArchitectureDraft,
} from '../../packages/core/src/index.js'
import { ArchitecturePlanExecutor, GitWorkspaceManager, runPromotedWorkflowReplayV2 } from '../../packages/runtime/src/index.js'

const projectRoot = process.cwd()
const fixtureDir = join(projectRoot, 'fixtures', 'job-system-template')

describe('generic promoted-workflow replay V2', () => {
  it('re-executes the promoted sync-to-queue workflow from static inputs alone', { timeout: 900_000 }, async () => {
    const catalog = parseCatalog(JSON.parse(
      await import('node:fs').then(fs => fs.readFileSync(join(projectRoot, 'fixtures/catalog/kernl-local-catalog.json'), 'utf8')),
    ) as unknown)
    const before = parseAir(JSON.parse(
      await import('node:fs').then(fs => fs.readFileSync(join(projectRoot, 'fixtures/air/before.json'), 'utf8')),
    ) as unknown)

    const draft: ArchitectureDraft = {
      schemaVersion: '1.0',
      draftId: `replay-seed-${randomUUID().slice(0, 8)}`,
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
    if (!validateDraft(draft, before, catalog).valid) throw new Error('seed draft must validate')
    const after = applyDraft(draft, before, catalog).after
    const { compileArchitecturePlan } = await import('../../packages/core/src/index.js')
    const plan = compileArchitecturePlan(before, after, { catalog })

    // Produce a promoted workflow artifact through a real run.
    const runId = `run-replay-src-${randomUUID().slice(0, 8)}`
    const databasePath = join(projectRoot, 'data', `kernl-replay-src-${randomUUID()}.sqlite`)
    await mkdir(join(projectRoot, 'data'), { recursive: true })
    const ledger = new KernlLedger(databasePath)
    let artifactDir: string
    try {
      ledger.putAir(before)
      ledger.putAir(after)
      ledger.createRun({ id: runId, airDigest: airDigest(after), sourceCommit: 'PENDING_WORKSPACE', status: 'PLANNING' })
      const executor = new ArchitecturePlanExecutor(projectRoot, ledger)
      const suspended = await executor.run({ runId, plan, fromAir: before, toAir: after, catalog, fixtureDir })
      if (suspended.status !== 'AWAITING_APPROVAL') throw new Error(`source run failed: ${suspended.error ?? suspended.status}`)
      const pending = ledger.listApprovals(runId).find(approval => approval.decision === 'PENDING')
      if (!pending) throw new Error('missing pending approval')
      const events = ledger.listEvents(runId)
      const evidenceReady = [...events].reverse().find(event => event.type === 'EVIDENCE_READY')
      const coreDigest = String((evidenceReady?.payload as { evidenceCoreDigest?: string }).evidenceCoreDigest ?? '')
      ledger.decideApproval({ runId, approvalId: pending.id, decision: 'APPROVED', actor: 'solution-architect', evidenceDigest: coreDigest })
      const promoted = await new ArchitecturePlanExecutor(projectRoot, ledger).run({ runId, plan, fromAir: before, toAir: after, catalog, fixtureDir })
      expect(promoted.status).toBe('PROMOTED')
      artifactDir = join(projectRoot, 'artifacts', 'runs', runId)
    } finally {
      ledger.close()
      await import('node:fs/promises').then(fs => fs.rm(databasePath, { force: true }))
    }

    // Replay the promoted workflow in a fresh database, from static inputs only.
    const result = await runPromotedWorkflowReplayV2({
      projectRoot,
      workflowArtifactPath: join(artifactDir, 'promoted-workflow.json'),
      beforeAirPath: join(artifactDir, 'air-before.json'),
      afterAirPath: join(artifactDir, 'air-after.json'),
      fixtureDir,
    })

    expect(result.status).toBe('PROMOTED')
    expect(result.contentDigestMatch).toBe(true)
    expect(result.planDigestMatch).toBe(true)
    expect(result.finalVerificationStatus).toBe('passed')
    expect(result.duplicateEffects).toBe(0)
    expect(result.repairAttemptsUsed).toBeGreaterThanOrEqual(1)
    expect(result.manifestDigest).toMatch(/^[a-f0-9]{64}$/)

    await import('node:fs/promises').then(async fs => {
      const manager = new GitWorkspaceManager(projectRoot)
      await fs.rm(manager.runRepositoryPath(runId), { recursive: true, force: true })
      await fs.rm(manager.runRepositoryPath(result.runId), { recursive: true, force: true })
      await fs.rm(result.reportPath, { recursive: true, force: true }).catch(() => undefined)
      await fs.rm(join(projectRoot, 'data', `${result.runId}.sqlite`), { force: true }).catch(() => undefined)
      await fs.rm(join(projectRoot, 'artifacts', 'runs', runId), { recursive: true, force: true }).catch(() => undefined)
      await fs.rm(join(projectRoot, 'artifacts', 'runs', result.runId), { recursive: true, force: true }).catch(() => undefined)
    })
  })
})

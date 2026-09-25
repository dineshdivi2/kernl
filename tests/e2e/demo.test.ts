import { randomUUID } from 'node:crypto'
import { access, cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KernlLedger, digestJson, sha256Hex } from '@kernl/core'
import {
  KernlDemoCoordinator,
  GitWorkspaceManager,
  workflowArtifactDigest,
  workflowContentDigest,
  type PromotedWorkflow,
  type VerificationReport,
} from '@kernl/runtime'

const projectRoot = process.cwd()

interface EvidenceFile {
  path: string
  sha256: string
  bytes: number
}

interface EvidenceCore {
  schemaVersion: string
  runId: string
  files: EvidenceFile[]
  digest: string
}

interface EvidenceManifest {
  schemaVersion: string
  generatedAt: string
  metadata: {
    runId: string
    airDigest: string
    candidateCommit: string
    verificationDigest: string
    workflowContentDigest: string
    workflowDigest: string
    evidenceCoreDigest: string
  }
  files: EvidenceFile[]
}

interface WorkflowReplayReport {
  status: string
  reportDigest: string
  reportPath: string
  workflow: {
    contentDigest: string
    computedContentDigest: string
    artifactDigest: string
    promotedWorkflowDigest: string
    contentVerified: boolean
    promotionEnvelopeVerified: boolean
  }
  verification: {
    attempts: VerificationReport[]
    intendedFailureObserved: boolean
    initialFailureFingerprint: string
    finalStatus: string
  }
  repair: { attemptsUsed: number; expectedScope: string[]; changedPaths: string[] }
  effects: Array<{ idempotencyKey: string }>
  assertions: Record<string, boolean>
}

interface RestartReplay {
  status: string
  runId: string
  stableAcrossRestart: boolean
  duplicateEffects: number
  effectsReexecuted: number
  effectCount: number
  projection: {
    effects: Record<string, unknown>
    promotion?: { workflowDigest: string }
  }
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function verifyEvidenceFiles(root: string, entries: readonly EvidenceFile[]): Promise<void> {
  expect(new Set(entries.map(entry => entry.path)).size).toBe(entries.length)
  for (const entry of entries) {
    const content = await readFile(join(root, entry.path))
    expect(content.byteLength, entry.path).toBe(entry.bytes)
    expect(sha256Hex(content), entry.path).toBe(entry.sha256)
  }
}

describe('Kernl deterministic end-to-end vertical slice', () => {
  it('turns an AIR graph change into repaired, approved, promoted, and replayable software', { timeout: 240_000 }, async () => {
    const testId = randomUUID()
    const databasePath = join(projectRoot, 'data', `kernl-e2e-${testId}.sqlite`)
    const canonicalArtifactDir = join(projectRoot, 'artifacts', 'demo-run')
    const backupRoot = await mkdtemp(join(tmpdir(), 'kernl-e2e-canonical-'))
    const canonicalBackup = join(backupRoot, 'demo-run')
    const canonicalExisted = await exists(canonicalArtifactDir)
    if (canonicalExisted) await cp(canonicalArtifactDir, canonicalBackup, { recursive: true })

    const coordinator = new KernlDemoCoordinator(projectRoot, databasePath)
    const workspaceManager = new GitWorkspaceManager(projectRoot)
    let runId: string | undefined

    try {
      const result = await coordinator.runDemo('e2e-solution-architect', 'architect')
      runId = result.runId
      const artifactDir = join(projectRoot, 'artifacts', 'runs', runId)

      expect(result).toMatchObject({
        status: 'PROMOTED',
        databasePath,
        artifactDir: canonicalArtifactDir,
      })
      expect(result.baseCommit).toMatch(/^[a-f0-9]{40}$/)
      expect(result.candidateCommit).toMatch(/^[a-f0-9]{40}$/)
      expect(result.candidateCommit).not.toBe(result.baseCommit)
      expect(result.verificationDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(result.workflowDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(result.evidenceCoreDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(result.evidenceManifestDigest).toMatch(/^[a-f0-9]{64}$/)

      const ledger = new KernlLedger(databasePath)
      const exported = ledger.exportRun(runId)
      const events = ledger.listEvents(runId)
      const effects = ledger.listEffects(runId)
      const promotion = ledger.getPromotion(runId)
      ledger.close()

      const invalidIndex = events.findIndex(event => event.type === 'INVALID_AIR_REJECTED_BEFORE_AGENTS')
      const firstModelIndex = events.findIndex(event => event.type === 'MODEL_REQUEST')
      expect(invalidIndex).toBeGreaterThanOrEqual(0)
      expect(firstModelIndex).toBeGreaterThan(invalidIndex)
      expect(events[invalidIndex]?.payload).toMatchObject({ modelRequests: 0 })
      expect(events.slice(0, invalidIndex + 1).some(event => event.type === 'MODEL_REQUEST')).toBe(false)

      const authorization = events.find(event => event.type === 'APPROVAL_AUTHORIZATION_GRANTED')
      expect(authorization?.payload).toMatchObject({
        actor: 'e2e-solution-architect',
        actorRole: 'architect',
        requiredRole: 'architect',
        authorized: true,
      })
      expect(exported.approvals).toEqual([
        expect.objectContaining({
          actor: 'e2e-solution-architect',
          gateId: 'architect-promotion',
          decision: 'APPROVED',
          evidenceDigest: result.evidenceCoreDigest,
        }),
      ])

      const baseline = await json<VerificationReport>(join(artifactDir, 'baseline-verification.json'))
      const firstVerification = await json<VerificationReport>(join(artifactDir, 'verification-attempt-1.json'))
      const finalVerification = await json<VerificationReport>(join(artifactDir, 'verification-report.json'))
      expect(baseline.status).toBe('passed')
      expect(baseline.gates.map(gate => [gate.name, gate.status])).toEqual([
        ['build', 'passed'],
        ['unit', 'passed'],
        ['contract', 'passed'],
      ])
      expect(firstVerification.status).toBe('failed')
      expect(firstVerification.gates.find(gate => gate.name === 'contract')).toMatchObject({ status: 'passed' })
      expect(firstVerification.gates.find(gate => gate.name === 'idempotency')).toMatchObject({
        status: 'failed',
        failureFingerprint: 'duplicate-event-effect',
        repairScope: ['src/worker.ts'],
      })
      expect(finalVerification.status).toBe('passed')
      expect(finalVerification.digest).toBe(result.verificationDigest)
      expect(finalVerification.gates.map(gate => [gate.name, gate.status])).toEqual([
        ['build', 'passed'],
        ['unit', 'passed'],
        ['contract', 'passed'],
        ['idempotency', 'passed'],
        ['architecture-invariants', 'passed'],
        ['secret-scan', 'passed'],
      ])

      const repairTask = exported.tasks.find(task => task.kind === 'REPAIR')
      expect(repairTask).toMatchObject({
        id: 'repair:implement:worker:1',
        status: 'SUCCEEDED',
        writeScopes: ['src/worker.ts'],
        attempt: 1,
        maxAttempts: 1,
      })
      const repairExecutions = events.filter(event =>
        event.type === 'TOOL_EXECUTED' && event.taskId === repairTask?.id,
      )
      expect(repairExecutions).toHaveLength(1)
      expect(repairExecutions[0]?.payload).toMatchObject({ changedPaths: ['src/worker.ts'] })

      const lifecycle = await json<{
        duplicateReceiptSuppressed: boolean
        finalSnapshot: {
          providers: Record<string, {
            state: string
            relianceCount: number
            acceptingNewBindings: boolean
            cleanupComplete: boolean
          }>
        }
      }>(join(artifactDir, 'lifecycle-trace.json'))
      expect(lifecycle.duplicateReceiptSuppressed).toBe(true)
      expect(lifecycle.finalSnapshot.providers['queue@1.0.0']).toMatchObject({
        state: 'INACTIVE',
        relianceCount: 0,
        acceptingNewBindings: false,
        cleanupComplete: true,
      })
      expect(lifecycle.finalSnapshot.providers['queue@2.0.0']).toMatchObject({
        state: 'ACTIVE',
        relianceCount: 2,
        acceptingNewBindings: true,
      })

      const effectKeys = effects.map(effect => effect.idempotencyKey)
      expect(effectKeys.length).toBeGreaterThan(0)
      expect(new Set(effectKeys).size).toBe(effectKeys.length)
      expect(effects.every(effect => effect.runId === runId)).toBe(true)
      expect(effects.some(effect => effect.effectType === 'WORKFLOW_PROMOTION')).toBe(true)
      const plannedKeys = events
        .filter(event => event.type === 'EFFECT_PLANNED')
        .flatMap(event => {
          const payload = event.payload as Record<string, unknown>
          return [
            ...(typeof payload.idempotencyKey === 'string' ? [payload.idempotencyKey] : []),
            ...(Array.isArray(payload.idempotencyKeys)
              ? payload.idempotencyKeys.filter((value): value is string => typeof value === 'string')
              : []),
          ]
        })
      expect(plannedKeys.length).toBeGreaterThan(0)
      expect(plannedKeys.every(key => effectKeys.includes(key))).toBe(true)
      const mainEffectTypes = new Set(effects.map(effect => effect.effectType))
      for (const requiredEffectType of [
        'RUN_REPOSITORY_CREATE',
        'GIT_WORKTREE_CREATE',
        'FILESYSTEM_WRITE',
        'GIT_INTEGRATION',
        'EVIDENCE_CORE_MATERIALIZE',
        'EVIDENCE_PACK_FINALIZE',
        'EVIDENCE_CANONICAL_PUBLISH',
        'WORKFLOW_PROMOTION',
      ]) expect(mainEffectTypes.has(requiredEffectType)).toBe(true)

      const workflow = await json<PromotedWorkflow>(join(artifactDir, 'promoted-workflow.json'))
      expect(promotion).toBeDefined()
      expect(workflowContentDigest(workflow)).toBe(workflow.contentDigest)
      expect(workflowArtifactDigest(workflow)).toBe(result.workflowDigest)
      expect(promotion).toMatchObject({
        runId,
        airDigest: workflow.provenance.toAirDigest,
        sourceCommit: result.candidateCommit,
        verificationDigest: result.verificationDigest,
        evidenceDigest: result.evidenceCoreDigest,
        workflowDigest: result.workflowDigest,
      })
      expect(workflow.provenance).toMatchObject({
        runId,
        candidateCommit: result.candidateCommit,
        verificationDigest: result.verificationDigest,
        evidenceCoreDigest: result.evidenceCoreDigest,
      })

      const evidenceCore = await json<EvidenceCore>(join(artifactDir, 'evidence-core.json'))
      const { digest: recordedCoreDigest, ...evidenceCoreContent } = evidenceCore
      expect(recordedCoreDigest).toBe(result.evidenceCoreDigest)
      expect(digestJson(evidenceCoreContent)).toBe(result.evidenceCoreDigest)
      await verifyEvidenceFiles(artifactDir, evidenceCore.files)

      const manifest = await json<EvidenceManifest>(join(artifactDir, 'evidence-manifest.json'))
      expect(digestJson(manifest)).toBe(result.evidenceManifestDigest)
      expect(manifest.metadata).toMatchObject({
        runId,
        candidateCommit: result.candidateCommit,
        verificationDigest: result.verificationDigest,
        workflowContentDigest: workflow.contentDigest,
        workflowDigest: result.workflowDigest,
        evidenceCoreDigest: result.evidenceCoreDigest,
      })
      await verifyEvidenceFiles(artifactDir, manifest.files)

      const workflowReplay = await json<WorkflowReplayReport>(join(artifactDir, 'workflow-replay-report.json'))
      const { reportDigest, ...workflowReportContent } = workflowReplay
      expect(reportDigest).toBe(digestJson(workflowReportContent))
      expect(workflowReplay).toMatchObject({
        status: 'passed',
        workflow: {
          contentDigest: workflow.contentDigest,
          computedContentDigest: workflow.contentDigest,
          artifactDigest: result.workflowDigest,
          promotedWorkflowDigest: result.workflowDigest,
          contentVerified: true,
          promotionEnvelopeVerified: true,
        },
        verification: {
          intendedFailureObserved: true,
          initialFailureFingerprint: 'duplicate-event-effect',
          finalStatus: 'passed',
        },
        repair: {
          attemptsUsed: 1,
          expectedScope: ['src/worker.ts'],
          changedPaths: ['src/worker.ts'],
        },
      })
      expect(workflowReplay.verification.attempts.map(attempt => attempt.status)).toEqual(['failed', 'passed'])
      expect(Object.values(workflowReplay.assertions).every(Boolean)).toBe(true)
      expect(new Set(workflowReplay.effects.map(effect => effect.idempotencyKey)).size).toBe(workflowReplay.effects.length)
      const replayEffectTypes = new Set(workflowReplay.effects.map(effect => effect.effectType))
      for (const requiredEffectType of [
        'RUN_REPOSITORY_CREATE', 'GIT_WORKTREE_CREATE', 'FILESYSTEM_WRITE', 'GIT_INTEGRATION', 'ARTIFACT_WRITE',
      ]) expect(replayEffectTypes.has(requiredEffectType)).toBe(true)

      const persistedReplay = await json<{
        stateEquivalent: boolean
        duplicateEffects: number
        effectsReexecuted: number
        idempotencyKeysUnique: boolean
      }>(join(artifactDir, 'replay-report.json'))
      expect(persistedReplay).toMatchObject({
        stateEquivalent: true,
        duplicateEffects: 0,
        effectsReexecuted: 0,
        idempotencyKeysUnique: true,
      })

      const restartReplay = await coordinator.replay(runId) as unknown as RestartReplay
      expect(restartReplay).toMatchObject({
        status: 'PROMOTED',
        runId,
        stableAcrossRestart: true,
        duplicateEffects: 0,
        effectsReexecuted: 0,
      })
      expect(Object.keys(restartReplay.projection.effects)).toHaveLength(restartReplay.effectCount)
      expect(restartReplay.projection.promotion?.workflowDigest).toBe(result.workflowDigest)

      const secretScan = await json<{ status: string; matches: string[] }>(join(artifactDir, 'secret-scan-report.json'))
      expect(secretScan).toEqual(expect.objectContaining({ status: 'passed', matches: [] }))
      expect(await stat(join(artifactDir, 'change.patch'))).toMatchObject({ size: expect.any(Number) })
      expect(await readFile(join(artifactDir, 'change.patch'), 'utf8')).toContain('processedEventIds')
      for (const name of await readdir(artifactDir)) {
        const content = await readFile(join(artifactDir, name), 'utf8')
        expect(content).not.toContain(projectRoot)
        expect(content).not.toContain(pathToFileURL(projectRoot).href)
        expect(content).not.toContain('file:///<USER_HOME>')
        expect(content).not.toMatch(/[A-Za-z]:\\{1,2}Users\\{1,2}/i)
      }
    } finally {
      if (!runId && await exists(databasePath)) {
        const ledger = new KernlLedger(databasePath)
        const row = ledger.database.prepare('SELECT id FROM runs ORDER BY created_at DESC LIMIT 1').get() as { id?: string } | undefined
        runId = row?.id
        ledger.close()
      }

      if (runId) {
        await rm(workspaceManager.runRepositoryPath(runId), { recursive: true, force: true })
        await rm(workspaceManager.runRepositoryPath(`${runId}-promoted-workflow`), { recursive: true, force: true })
        await rm(join(projectRoot, 'artifacts', 'runs', runId), { recursive: true, force: true })
      }
      await rm(databasePath, { force: true })
      await rm(`${databasePath}-wal`, { force: true })
      await rm(`${databasePath}-shm`, { force: true })

      await rm(canonicalArtifactDir, { recursive: true, force: true })
      if (canonicalExisted) await cp(canonicalBackup, canonicalArtifactDir, { recursive: true })
      await rm(backupRoot, { recursive: true, force: true })
    }
  })
})

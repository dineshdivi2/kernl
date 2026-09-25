import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJson, compileTaskDag, digestJson, parseAir } from '@kernl/core'
import {
  compilePromotedWorkflow,
  compileQueueProviderReplacement,
  GitWorkspaceManager,
  runPromotedWorkflowReplay,
  workflowArtifactDigest,
  workflowContentDigest,
} from '@kernl/runtime'

const projectRoot = process.cwd()
const cleanupPaths: string[] = []

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function workflowFixture() {
  const beforePath = join(projectRoot, 'fixtures', 'air', 'before.json')
  const afterPath = join(projectRoot, 'fixtures', 'air', 'after.json')
  const replacementPath = join(projectRoot, 'fixtures', 'air', 'queue-v2.json')
  const before = parseAir(await json(beforePath))
  const after = parseAir(await json(afterPath))
  const replacement = parseAir(await json(replacementPath))
  const lifecycleReplacement = compileQueueProviderReplacement(after, replacement)
  const dag = compileTaskDag(before, after, { maximumParallelImplementations: 2, maximumRepairAttempts: 3 })
  const workflow = compilePromotedWorkflow({
    runId: 'source-promoted-run',
    dag,
    candidateCommit: 'a'.repeat(40),
    verificationDigest: 'b'.repeat(64),
    evidenceVersion: 'evidence-v1',
    evidenceCoreDigest: 'c'.repeat(64),
    approval: { actor: 'test-architect', decision: 'approved', createdAt: '2026-08-20T00:00:00.000Z' },
    model: { adapter: 'deterministic-v1' },
    lifecycleReplacement: {
      changeId: lifecycleReplacement.changeId,
      componentId: lifecycleReplacement.componentId,
      currentAirVersion: lifecycleReplacement.currentAirVersion,
      currentAirDigest: lifecycleReplacement.currentAirDigest,
      replacementAirVersion: lifecycleReplacement.replacementAirVersion,
      replacementAirDigest: lifecycleReplacement.replacementAirDigest,
    },
  })
  return { beforePath, afterPath, replacementPath, dag, workflow }
}

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('promoted static workflow replay', () => {
  it('contains an explicit conditional repair and two unambiguous digests', async () => {
    const { workflow } = await workflowFixture()
    expect(workflow.steps.map(step => step.id)).toEqual([
      'validate:air-change',
      'implement:api',
      'implement:queue',
      'implement:worker',
      'integrate:change',
      'verify:initial-candidate',
      'repair:duplicate-event-effect',
      'verify:all-gates',
      'lifecycle:replace-queue-v2',
      'approval:promotion',
      'promote:workflow',
    ])
    expect(workflow.steps.find(step => step.kind === 'REPAIR')).toMatchObject({
      dependencies: ['verify:initial-candidate'],
      writeScopes: ['src/worker.ts'],
      condition: { gateFailureFingerprint: 'duplicate-event-effect' },
    })
    expect(workflow.contentDigest).toBe(workflowContentDigest(workflow))
    expect(workflowArtifactDigest(workflow)).not.toBe(workflow.contentDigest)
  })

  it('runs from artifact and explicit inputs through failure, scoped repair, and passing gates', { timeout: 120_000 }, async () => {
    const { beforePath, afterPath, replacementPath, workflow } = await workflowFixture()
    const temporary = await mkdtemp(join(tmpdir(), 'kernl-workflow-replay-'))
    cleanupPaths.push(temporary)
    const workflowPath = join(temporary, 'promoted-workflow.json')
    const promotionPath = join(temporary, 'promotion.json')
    const outputDir = join(temporary, 'output')
    const replayRunId = `workflow-test-${randomUUID()}`
    const runWorkspace = new GitWorkspaceManager(projectRoot).runRepositoryPath(replayRunId)
    cleanupPaths.push(runWorkspace)

    await writeFile(workflowPath, `${canonicalJson(workflow)}\n`, 'utf8')
    const workflowDigest = workflowArtifactDigest(workflow)
    await writeFile(promotionPath, `${canonicalJson({
      airDigest: workflow.provenance.toAirDigest,
      sourceCommit: workflow.provenance.candidateCommit,
      verificationDigest: workflow.provenance.verificationDigest,
      evidenceDigest: workflow.provenance.evidenceCoreDigest,
      workflowDigest,
      workflow,
    })}\n`, 'utf8')

    const report = await runPromotedWorkflowReplay({
      projectRoot,
      workflowArtifactPath: workflowPath,
      promotionArtifactPath: promotionPath,
      beforeAirPath: beforePath,
      afterAirPath: afterPath,
      replacementAirPath: replacementPath,
      fixtureDir: join(projectRoot, 'fixtures', 'job-system-template'),
      outputDir,
      replayRunId,
    })

    expect(report.status).toBe('passed')
    expect(report.workflow).toMatchObject({
      contentDigest: workflow.contentDigest,
      computedContentDigest: workflow.contentDigest,
      artifactDigest: workflowDigest,
      promotedWorkflowDigest: workflowDigest,
      contentVerified: true,
      promotionEnvelopeVerified: true,
    })
    expect(report.verification.attempts).toHaveLength(2)
    expect(report.verification.attempts[0]).toMatchObject({ status: 'failed' })
    expect(report.verification.attempts[0]?.gates.find(gate => gate.name === 'idempotency')).toMatchObject({
      failureFingerprint: 'duplicate-event-effect',
      repairScope: ['src/worker.ts'],
    })
    expect(report.verification.attempts[1]).toMatchObject({ status: 'passed' })
    expect(report.repair).toMatchObject({ attemptsUsed: 1, changedPaths: ['src/worker.ts'] })
    expect(report.lifecycle).toMatchObject({
      replacementAirVersion: 'air-003a-queue-v2-contract',
      duplicateReceiptSuppressed: true,
      assertions: {
        currentProviderInactive: true,
        currentProviderRelianceZero: true,
        replacementProviderActive: true,
        replacementBindingsCommitted: true,
      },
    })
    expect(report.limits).toMatchObject({ modelSpendUsd: 0, modelRequests: 4 })
    expect(report.steps.map(step => step.id)).toEqual(workflow.steps.map(step => step.id))
    expect(new Set(report.source.isolatedWorktrees).size).toBe(4)
    expect(report.source.isolatedWorktrees.every(path => basename(path).length === 20)).toBe(true)
    expect(report.effects.length).toBeGreaterThan(0)
    expect(new Set(report.effects.map(effect => effect.idempotencyKey)).size).toBe(report.effects.length)
    expect(report.assertions).toEqual({
      noConversationContextUsed: true,
      exactStaticStepsMatchedAirDag: true,
      allMutationsIsolated: true,
      repairStayedInDeclaredScope: true,
      publicContractPassed: true,
      duplicateDeliveryPassedAfterRepair: true,
      limitsRespected: true,
    })

    const persisted = await json(join(outputDir, report.reportPath)) as Record<string, unknown>
    const { reportDigest, ...content } = persisted
    expect(reportDigest).toBe(digestJson(content))
    expect(await readFile(join(outputDir, report.source.patchPath), 'utf8')).toContain('processedEventIds')
    const replayManifest = await json(join(outputDir, report.evidenceManifestPath)) as { files: Array<{ path: string }> }
    expect(replayManifest.files.map(file => file.path).sort()).toEqual([report.reportPath, report.source.patchPath].sort())
  })
})

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join,dirname } from 'node:path'
import {
  KernlLedger,
  compileArchitecturePlan,
  parseAir,
  parseCatalog,
  airDigest,
  digestJson,
  type AirDocument,
} from '@kernl/core'
import { ArchitecturePlanExecutor } from './plan-executor.js'
import { EvidenceWriter } from './evidence.js'
import { workflowContentDigestV2, type PromotedWorkflowV2 } from './promotion-v2.js'
import {executionFingerprint} from './execution-fingerprint.js'

export interface WorkflowReplayV2Input {
  projectRoot: string
  /** promoted-workflow.json written by promotePlanRun (schema 2.0). */
  workflowArtifactPath: string
  /** air-before.json / air-after.json from the same evidence pack. */
  beforeAirPath: string
  afterAirPath: string
  /** Source template directory (the job-system fixture for this alpha). */
  fixtureDir: string
  catalogPath?: string
  replayRunId?: string
}

export interface WorkflowReplayV2Result {
  status: 'PROMOTED' | 'FAILED'
  runId: string
  contentDigestMatch: boolean
  planDigestMatch: boolean
  repairAttemptsUsed: number
  verificationAttempts: number
  finalVerificationStatus: string
  duplicateEffects: number
  effectCount: number
  reportPath: string
  manifestDigest: string
  error?: string
}

/**
 * Static re-execution of a promoted schema-2.0 workflow.
 *
 * The replay consumes only versioned artifact inputs — both AIR versions,
 * the catalog, and the source template. It never consults the original
 * conversation, the original SQLite database, or any model memory. The plan
 * is recompiled from the AIR pair and must byte-match the promoted plan
 * digest, proving the promotion is deterministic and self-contained.
 */
export async function runPromotedWorkflowReplayV2(input: WorkflowReplayV2Input): Promise<WorkflowReplayV2Result> {
  const raw = JSON.parse(await readFile(input.workflowArtifactPath, 'utf8')) as PromotedWorkflowV2
  const contentDigestMatches = workflowContentDigestV2(raw) === raw.contentDigest
  if(raw.provenance.agent.adapter!=='deterministic-recipe-v2') throw new Error('live-generated workflow requires a captured-code replay adapter; recipe replay cannot claim to reproduce live output')

  const catalog = parseCatalog(JSON.parse(
    await readFile(input.catalogPath ?? (raw.executionBindings?join(dirname(input.workflowArtifactPath),'catalog.json'):join(input.projectRoot, 'fixtures', 'catalog', 'kernl-local-catalog.json')), 'utf8'),
  ) as unknown)
  if(raw.executionBindings && digestJson(raw.executionBindings)!==digestJson(await executionFingerprint(input.projectRoot,input.fixtureDir,catalog.digest))) throw new Error('replay requires the exact promoted catalog, source template and runtime version')
  const fromAir: AirDocument = parseAir(JSON.parse(await readFile(input.beforeAirPath, 'utf8')) as unknown)
  const toAir: AirDocument = parseAir(JSON.parse(await readFile(input.afterAirPath, 'utf8')) as unknown)

  const plan = compileArchitecturePlan(fromAir, toAir, {
    catalog,
    budgets:raw.limits,
    expectedInitialFailure: raw.evaluationBaseline.expectedInitialFailure,
    planId: raw.provenance.planId,
  })
  const planDigestMatch = plan.digest === raw.provenance.planDigest
  if (!contentDigestMatches) throw new Error('promoted workflow failed its own content-digest check')
  if (!planDigestMatch) throw new Error('recompiled plan digest differs from the promoted provenance')

  const runId = input.replayRunId ?? `replay-${randomUUID().slice(0, 8)}`
  const databasePath = join(input.projectRoot, 'data', `${runId}.sqlite`)
  const ledger = new KernlLedger(databasePath)
  let outcome
  try {
    ledger.putAir(fromAir)
    ledger.putAir(toAir)
    ledger.createRun({ id: runId, airDigest: airDigest(toAir), sourceCommit: 'REPLAY', status: 'PLANNING' })
    const executor = new ArchitecturePlanExecutor(input.projectRoot, ledger)
    outcome = await executor.run({ runId, plan, fromAir, toAir, catalog, fixtureDir: input.fixtureDir })
    if (outcome.status !== 'AWAITING_APPROVAL') throw new Error(`replay suspended unexpectedly: ${outcome.status}`)
    const approvals = ledger.listApprovals(runId)
    const pending = approvals.find(approval => approval.decision === 'PENDING')
    if (!pending) throw new Error('replay produced no pending approval')
    const events = ledger.listEvents(runId)
    const evidenceReady = [...events].reverse().find(event => event.type === 'EVIDENCE_READY')
    const digest = String((evidenceReady?.payload as { evidenceCoreDigest?: string }).evidenceCoreDigest ?? '')
    ledger.decideApproval({ runId, approvalId: pending.id, decision: 'APPROVED', actor: 'deterministic-replay', evidenceDigest: digest })
    // The replay architect is deterministic; resume straight through promotion.
    const resumed = await new ArchitecturePlanExecutor(input.projectRoot, ledger).run({ runId, plan, fromAir, toAir, catalog, fixtureDir: input.fixtureDir })
    if (resumed.status !== 'PROMOTED') throw new Error(`replay did not promote: ${resumed.error ?? resumed.status}`)
    outcome = resumed
  } finally {
    try { ledger.close() } catch { /* closed above */ }
  }

  const reopened = new KernlLedger(databasePath)
  try {
    const effects = reopened.listEffects(runId)
    const keys = effects.map(effect => effect.idempotencyKey)
    const duplicateEffects = keys.length - new Set(keys).size
    const events = reopened.listEvents(runId)
    const finalReport = [...events].reverse().find(event => event.type === 'VERIFICATION_FINISHED')
    const finalStatus = String((finalReport?.payload as { status?: string }).status ?? 'unknown')
    const repairsFromLedger = events.filter(event => event.type === 'REPAIR_APPLIED').length

    const writer = new EvidenceWriter(input.projectRoot, join('artifacts', 'replays', runId))
    await writer.initialize()
    await writer.json('replayed-plan.json', plan)
    await writer.json('source-workflow.json', raw)
    await writer.jsonLines('events.jsonl', events)
    await writer.json('effect-ledger.json', effects)
    const manifest = await writer.manifest({
      schemaVersion: '2.0',
      kind: 'workflow-replay-v2',
      sourceWorkflowDigest: raw.contentDigest,
      replayRunId: runId,
      planDigestMatch,
      contentDigestMatch: contentDigestMatches,
      duplicateEffects,
      finalVerificationStatus: finalStatus,
    })
    await writer.verifyFiles()

    const result: WorkflowReplayV2Result = {
      status: 'PROMOTED',
      runId,
      contentDigestMatch: contentDigestMatches,
      planDigestMatch,
      repairAttemptsUsed: repairsFromLedger,
      verificationAttempts: outcome.verificationAttempts,
      finalVerificationStatus: finalStatus,
      duplicateEffects,
      effectCount: keys.length,
      reportPath: writer.outputDir,
      manifestDigest: manifest.digest,
    }
    return result
  } finally {
    reopened.close()
  }
}

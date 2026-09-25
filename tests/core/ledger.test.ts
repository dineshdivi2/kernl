import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  IdempotencyConflictError,
  KernlLedger,
  TaskClaimAuthorityError,
  airDigest,
  compileTaskDag,
  parseAir,
  type AirDocument,
  type EffectReceiptInput,
} from '../../packages/core/src/index.js'

const fixtureDirectory = new URL('../../fixtures/air/', import.meta.url)
const temporaryDirectories: string[] = []

function fixture(name: string): AirDocument {
  return parseAir(JSON.parse(readFileSync(fileURLToPath(new URL(name, fixtureDirectory)), 'utf8')) as unknown)
}

function deterministicOptions() {
  let id = 0
  let tick = 0
  return {
    idFactory: () => `id-${++id}`,
    clock: () => new Date(Date.UTC(2026, 7, 20, 0, 0, tick++)).toISOString(),
    knownSecrets: ['known-live-secret'],
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('SQLite run ledger', () => {
  it('reuses an identical AIR version across runs and rejects version-content drift', () => {
    const ledger = new KernlLedger(':memory:', deterministicOptions())
    const air = fixture('after.json')
    try {
      const first = ledger.putAir(air)
      const repeated = ledger.putAir(air)
      expect(repeated).toEqual(first)

      const drifted = parseAir({
        ...air,
        change: { ...air.change, intent: `${air.change.intent} with unversioned drift` },
      })
      expect(() => ledger.putAir(drifted)).toThrow(/immutable and already bound/)
    } finally {
      ledger.close()
    }
  })

  it('persists AIR, tasks, events, idempotent effects, binding, approval, and promotion', () => {
    const before = fixture('before.json')
    const after = fixture('after.json')
    const ledger = new KernlLedger(':memory:', deterministicOptions())
    try {
      ledger.putAir(before)
      const storedAfter = ledger.putAir(after)
      const run = ledger.createRun({ id: 'run-1', airDigest: storedAfter.digest, sourceCommit: 'baseline1', traceId: 'trace-1' })
      const dag = compileTaskDag(before, after)
      for (const task of dag.tasks) ledger.putTask(run.id, task)
      ledger.setRunStatus(run.id, 'RUNNING')
      ledger.setTaskStatus(run.id, 'implement:worker', 'RUNNING')

      const effect: EffectReceiptInput = {
        runId: run.id,
        episodeId: 'episode-1',
        componentId: 'worker',
        taskId: 'implement:worker',
        effectType: 'filesystem.write',
        resourceIdentity: 'src/worker.ts',
        idempotencyKey: 'run-1:worker:write:1',
        preconditions: { commit: 'baseline1' },
        result: { path: 'src/worker.ts', apiKey: 'known-live-secret' },
        resultingState: 'WRITTEN',
        recoveryClassification: 'REVERSIBLE',
        recoveryMetadata: { patch: 'reverse.patch' },
        provenance: { taskDagDigest: dag.digest },
      }
      const first = ledger.appendEffectReceipt(effect)
      const replayed = ledger.appendEffectReceipt(effect)
      expect(first.inserted).toBe(true)
      expect(replayed.inserted).toBe(false)
      expect(ledger.listEffects(run.id)).toHaveLength(1)
      expect((first.receipt.result as Record<string, unknown>).apiKey).toBe('[REDACTED]')
      expect(() => ledger.appendEffectReceipt({ ...effect, result: { path: 'different.ts' } })).toThrow(IdempotencyConflictError)

      ledger.putBinding({
        id: 'worker-to-queue', runId: run.id, consumerId: 'worker', requirementId: 'dequeue-job', providerId: 'queue',
        providerVersion: '1.0.0', state: 'COMMITTED', relianceCount: 1,
      })
      const approval = ledger.requestApproval({ id: 'approval-1', runId: run.id, gateId: 'architect-promotion' })
      ledger.decideApproval({ runId: run.id, approvalId: approval.id, decision: 'APPROVED', actor: 'architect', evidenceDigest: 'evidence-1' })
      ledger.setRunSourceCommit(run.id, 'candidate2')
      const promotion = ledger.recordPromotion({
        runId: run.id,
        airDigest: airDigest(after),
        sourceCommit: 'candidate2',
        verificationDigest: 'verification-1',
        evidenceDigest: 'evidence-1',
        workflow: { inputs: ['change'], steps: dag.tasks.map((task) => task.id), secret: 'known-live-secret' },
      })

      expect(promotion.workflowDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(promotion.workflow).toMatchObject({ secret: '[REDACTED]' })
      expect(ledger.getRun(run.id).status).toBe('PROMOTED')
      expect(ledger.listEvents(run.id).map((event) => event.type)).toEqual(expect.arrayContaining([
        'RUN_CREATED', 'TASK_UPSERTED', 'EFFECT_COMMITTED', 'APPROVAL_DECIDED', 'RUN_SOURCE_COMMIT_CHANGED', 'WORKFLOW_PROMOTED',
      ]))

      const exported = ledger.exportRun(run.id)
      expect(exported.manifestDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(ledger.exportRunJson(run.id)).not.toContain('known-live-secret')
      const projection = ledger.replayRun(run.id)
      expect(projection).toMatchObject({ status: 'PROMOTED', sourceCommit: 'candidate2', promotion: { workflowDigest: promotion.workflowDigest } })
      expect(Object.keys(projection.effects)).toEqual(['run-1:worker:write:1'])
      expect(projection.approvals['approval-1']).toBe('APPROVED')
    } finally {
      ledger.close()
    }
  })

  it('reconstructs the same projection after closing and reopening the database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kernl-ledger-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'kernl.sqlite')
    const air = fixture('after.json')
    const options = deterministicOptions()
    const first = new KernlLedger(path, options)
    const stored = first.putAir(air)
    first.createRun({ id: 'persistent-run', airDigest: stored.digest, sourceCommit: 'commit-1', traceId: 'trace-persisted' })
    first.setRunStatus('persistent-run', 'VERIFYING')
    const beforeRestart = first.replayRun('persistent-run')
    first.close()

    const reopened = new KernlLedger(path, deterministicOptions())
    try {
      const afterRestart = reopened.replayRun('persistent-run')
      expect(afterRestart).toEqual(beforeRestart)
      expect(afterRestart).toMatchObject({ status: 'VERIFYING', airDigest: stored.digest, sourceCommit: 'commit-1' })
    } finally {
      reopened.close()
    }
  })

  it('atomically grants one worker only the task-declared capability and write scopes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kernl-claim-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'kernl.sqlite')
    const before = fixture('before.json')
    const after = fixture('after.json')
    const first = new KernlLedger(path)
    const stored = first.putAir(after)
    first.createRun({ id: 'claim-run', airDigest: stored.digest, sourceCommit: 'baseline1' })
    const dag = compileTaskDag(before, after)
    for (const task of dag.tasks) first.putTask('claim-run', task)
    first.setTaskStatus('claim-run', 'validate:air-change', 'SUCCEEDED')
    const second = new KernlLedger(path)
    const request = {
      runId: 'claim-run',
      taskId: 'implement:worker',
      workerId: 'dsh-worker-1',
      capabilities: ['task:implement', 'typescript'],
      writeScopes: ['src/worker.ts'],
    }

    try {
      expect(() => first.claimTask({ ...request, capabilities: ['typescript'] })).toThrow(TaskClaimAuthorityError)
      expect(() => first.claimTask({ ...request, writeScopes: ['src/worker.ts', 'src/store.ts'] })).toThrow(TaskClaimAuthorityError)
      expect(first.getTask('claim-run', 'implement:worker').status).toBe('PENDING')

      const winner = first.claimTask(request)
      const loser = second.claimTask({ ...request, workerId: 'dsh-worker-2' })

      expect(winner).toMatchObject({
        claimed: true,
        requiredCapability: 'task:implement',
        task: {
          status: 'CLAIMED',
          claimedBy: 'dsh-worker-1',
          claimCapabilities: ['task:implement', 'typescript'],
          claimWriteScopes: ['src/worker.ts'],
        },
      })
      expect(loser).toEqual({ claimed: false, taskId: 'implement:worker', reason: 'TASK_NOT_PENDING' })
      expect(first.listEvents('claim-run').filter((event) => event.type === 'TASK_CLAIMED')).toHaveLength(1)
      expect(first.replayRun('claim-run').tasks['implement:worker']?.status).toBe('CLAIMED')
    } finally {
      second.close()
      first.close()
    }
  })

  it('does not claim a task before all declared dependencies have succeeded', () => {
    const before = fixture('before.json')
    const after = fixture('after.json')
    const ledger = new KernlLedger(':memory:')
    const stored = ledger.putAir(after)
    ledger.createRun({ id: 'dependency-run', airDigest: stored.digest, sourceCommit: 'baseline1' })
    for (const task of compileTaskDag(before, after).tasks) ledger.putTask('dependency-run', task)
    try {
      expect(ledger.claimTask({
        runId: 'dependency-run',
        taskId: 'implement:api',
        workerId: 'dsh-worker',
        capabilities: ['task:implement'],
        writeScopes: ['src/api.ts'],
      })).toEqual({ claimed: false, taskId: 'implement:api', reason: 'DEPENDENCIES_NOT_READY' })
    } finally {
      ledger.close()
    }
  })

  it('refuses promotion against a different AIR/commit or without approval', () => {
    const ledger = new KernlLedger(':memory:', deterministicOptions())
    const air = fixture('after.json')
    const stored = ledger.putAir(air)
    ledger.createRun({ id: 'run', airDigest: stored.digest, sourceCommit: 'commit-1' })
    try {
      expect(() => ledger.recordPromotion({
        runId: 'run', airDigest: stored.digest, sourceCommit: 'commit-2', verificationDigest: 'v', evidenceDigest: 'e', workflow: {},
      })).toThrow(/exact AIR digest and source commit/)
      expect(() => ledger.recordPromotion({
        runId: 'run', airDigest: stored.digest, sourceCommit: 'commit-1', verificationDigest: 'v', evidenceDigest: 'e', workflow: {},
      })).toThrow(/approved gate/)
      const approval = ledger.requestApproval({ runId: 'run', gateId: 'promotion' })
      ledger.decideApproval({ runId: 'run', approvalId: approval.id, decision: 'APPROVED', actor: 'architect', evidenceDigest: 'evidence-a' })
      expect(() => ledger.recordPromotion({
        runId: 'run', airDigest: stored.digest, sourceCommit: 'commit-1', verificationDigest: 'v', evidenceDigest: 'evidence-b', workflow: {},
      })).toThrow(/exact evidence digest/)
    } finally {
      ledger.close()
    }
  })
})

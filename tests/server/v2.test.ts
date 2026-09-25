import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createV2App } from '../../apps/server/src/v2.js'

const projectRoot = process.cwd()
const tempDb = join(projectRoot, 'data', `kernl-v2api-${randomUUID()}.sqlite`)

process.env.KERNL_DB = tempDb

const app = createV2App(projectRoot)

async function post(path: string, body?: unknown): Promise<{ status: number; body: { ok: boolean; value?: unknown; error?: string } }> {
  const response = await app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as { ok: boolean; value?: unknown; error?: string } }
}

async function put(path: string, body: unknown): Promise<{ status: number; body: { ok: boolean; value?: unknown; error?: string } }> {
  const response = await app.request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as { ok: boolean; value?: unknown; error?: string } }
}

interface Envelope<T> { ok: boolean; value?: T; error?: string }

afterAll(async () => {
  await rm(tempDb, { force: true })
})

describe('Alpha V2 control-plane API', () => {
  it('carries a draft from authoring through execution to evidence-bound approval', { timeout: 900_000 }, async () => {
    const loaded = await post('/api/v2/catalog/load') as { status: number; body: Envelope<{ loaded: number }> }
    expect(loaded.status).toBe(200)
    expect(loaded.body.value?.loaded).toBeGreaterThanOrEqual(9)

    const seeded = await post('/api/v2/air/load', { path: 'air/before.json' }) as { status: number; body: Envelope<{ airVersion: string; digest: string }> }
    expect(seeded.body.value?.airVersion).toBe('air-001a-sync-contract')
    const initial = await post('/api/v2/bootstrap') as {status:number;body:Envelope<{starter:{componentOps:unknown[]};proposals:Array<{title:string}>}>}
    expect(initial.body.value?.starter.componentOps).toEqual([])
    expect(initial.body.value?.proposals.map(p=>p.title)).toEqual(['Move job execution to a queue'])

    const created = await post('/api/v2/drafts', {
      title: 'Queued pipeline evolution',
      intent: 'Replace synchronous worker invocation with a versioned queue.',
      componentOps: [
        { op: 'ADD', componentId: 'queue', catalogType: 'QUEUE', catalogId: 'queue', catalogVersion: '1.0.0' },
        { op: 'UPGRADE', componentId: 'api', catalogType: 'HTTP_API', catalogVersion: '2.0.0' },
        { op: 'UPGRADE', componentId: 'worker', catalogType: 'WORKER', catalogVersion: '1.5.0' },
      ],
      contractChanges: [{ op: 'REMOVE', contractId: 'sync-job-v1' }],
      requestedVerification: { gates: ['build', 'unit', 'contract', 'idempotency'] },
      expectedFailure: {
        fingerprint: 'duplicate-event-effect',
        repairStepId: 'modify:worker',
        repairScope: ['src/worker.ts'],
      },
      requestedBy: 'solution-architect',
    }) as { status: number; body: Envelope<{ draftId: string; status: string }> }
    expect(created.status).toBe(200)
    const draftId = created.body.value?.draftId ?? ''
    expect(draftId).toMatch(/^draft-/)

    const updated = await put(`/api/v2/drafts/${draftId}`, {
      title: 'Queued pipeline evolution (edited)',
      intent: 'Replace synchronous worker invocation with a versioned queue.',
      baseAirVersion: 'air-001a-sync-contract',
      componentOps: [
        { op: 'ADD', componentId: 'queue', catalogType: 'QUEUE', catalogId: 'queue', catalogVersion: '1.0.0' },
        { op: 'UPGRADE', componentId: 'api', catalogType: 'HTTP_API', catalogVersion: '2.0.0' },
        { op: 'UPGRADE', componentId: 'worker', catalogType: 'WORKER', catalogVersion: '1.5.0' },
      ],
      contractChanges: [{ op: 'REMOVE', contractId: 'sync-job-v1' }],
      requestedVerification: { gates: ['build', 'unit', 'contract', 'idempotency'] },
      expectedFailure: {
        fingerprint: 'duplicate-event-effect',
        repairStepId: 'modify:worker',
        repairScope: ['src/worker.ts'],
      },
      requestedBy: 'solution-architect',
    }) as { status: number; body: Envelope<{ title: string }> }
    expect(updated.body.value?.title).toContain('edited')

    const validated = await post(`/api/v2/drafts/${draftId}/validate`) as { status: number; body: Envelope<{ valid: boolean; issues: unknown[] }> }
    expect(validated.body.value?.valid).toBe(true)

    const compiled = await post(`/api/v2/drafts/${draftId}/compile`) as { status: number; body: Envelope<{ airVersion: string; airDigest: string }> }
    expect(compiled.body.value?.airVersion).toMatch(/^air-draft-[a-f0-9]{24}$/)
    expect(compiled.body.value?.airDigest).toMatch(/^[a-f0-9]{64}$/)

    // An invalid mutation must be rejected before any execution.
    const invalid = await post('/api/v2/drafts', {
      title: 'broken',
      intent: 'break bindings',
      baseAirVersion: 'air-001a-sync-contract',
      componentOps: [{ op: 'REMOVE', componentId: 'store' }],
      requestedVerification: { gates: ['build'] },
      requestedBy: 'solution-architect',
    }) as { status: number; body: Envelope<{ draftId: string }> }
    const invalidValidated = await post(`/api/v2/drafts/${invalid.body.value?.draftId}/validate`) as { status: number; body: Envelope<{ valid: boolean; issues: Array<{ code: string }> }> }
    expect(invalidValidated.body.value?.valid).toBe(false)
    expect(invalidValidated.body.value?.issues.map(issue => issue.code)).toContain('NO_PROVIDER')

    const run = await post(`/api/v2/drafts/${draftId}/run`) as { status: number; body: Envelope<{ runId: string; outcome: { status: string; repairAttemptsUsed: number } }> }
    expect(run.body.value?.outcome.status).toBe('AWAITING_APPROVAL')
    expect(run.body.value?.outcome.repairAttemptsUsed).toBe(1)
    const runId = run.body.value?.runId ?? ''

    const inspected = await app.request(`/api/v2/runs/${runId}`)
    const inspection = await inspected.json() as { ok: boolean; value?: { run: { status: string }; approvals: Array<{ decision: string }> } }
    expect(inspection.value?.run.status).toBe('AWAITING_APPROVAL')
    expect(inspection.value?.approvals.some(approval => approval.decision === 'PENDING')).toBe(true)

    const badRole = await post(`/api/v2/runs/${runId}/approve`, { actor: 'solution-architect', role: 'viewer' }) as { status: number; body: Envelope<unknown> }
    expect(badRole.status).toBeGreaterThanOrEqual(400)

    const approved = await post(`/api/v2/runs/${runId}/approve`, { actor: 'solution-architect', role: 'architect' }) as { status: number; body: Envelope<{ outcome: { status: string }; promotion: { workflowDigest: string } | null }> }
    expect(approved.body.value?.outcome.status).toBe('PROMOTED')
    expect(approved.body.value?.promotion?.workflowDigest).toMatch(/^[a-f0-9]{64}$/)
    // Each request reopens SQLite: a promotion, not a compiled draft, is the baseline.
    const boot = await post('/api/v2/bootstrap') as {status:number;body:Envelope<{baselineDigest:string;promotion:{sourceCommit:string};starter:{baseAirDigest:string;componentOps:unknown[]};proposals:Array<{title:string;componentOps:unknown[]}>}>}
    expect(boot.body.value?.baselineDigest).toBe(compiled.body.value?.airDigest)
    expect(boot.body.value?.starter.componentOps).toEqual([])
    expect(boot.body.value?.promotion.sourceCommit).toMatch(/^[a-f0-9]{40}$/)
    expect(boot.body.value?.proposals.map(p=>p.title)).toEqual(['Add bounded retry and dead-letter handling'])
    const next=await post('/api/v2/drafts',boot.body.value?.proposals[0]) as {status:number;body:Envelope<{draftId:string; baseAirVersion:string}>}
    expect(next.status).toBe(200)
    expect(next.body.value?.baseAirVersion).toBe(compiled.body.value?.airVersion)
    const nextValidation=await post(`/api/v2/drafts/${next.body.value?.draftId}/validate`) as {status:number;body:Envelope<{valid:boolean}>}
    expect(nextValidation.body.value?.valid).toBe(true)
    await post(`/api/v2/drafts/${next.body.value?.draftId}/compile`)
    const nextRun=await post(`/api/v2/drafts/${next.body.value?.draftId}/run`) as {status:number;body:Envelope<{outcome:{status:string}}>}
    expect(nextRun.body.value?.outcome.status).toBe('AWAITING_APPROVAL')
    const unchanged=await post('/api/v2/bootstrap') as {status:number;body:Envelope<{baselineDigest:string}>}
    expect(unchanged.body.value?.baselineDigest).toBe(compiled.body.value?.airDigest)
  }, )

  it('rejects a pending promotion with a persisted reason and leaves the candidate inspectable', { timeout: 900_000 }, async () => {
    const created = await post('/api/v2/drafts', {
      title: 'Rejection drill',
      baseAirVersion: 'air-001a-sync-contract',
      intent: 'Prove rejection keeps the candidate inspectable without promoting it.',
      componentOps: [
        { op: 'ADD', componentId: 'queue', catalogType: 'QUEUE', catalogId: 'queue', catalogVersion: '1.0.0' },
        { op: 'UPGRADE', componentId: 'api', catalogType: 'HTTP_API', catalogVersion: '2.0.0' },
        { op: 'UPGRADE', componentId: 'worker', catalogType: 'WORKER', catalogVersion: '1.5.0' },
      ],
      contractChanges: [{ op: 'REMOVE', contractId: 'sync-job-v1' }],
      requestedVerification: { gates: ['build'] },
      requestedBy: 'solution-architect',
    }) as { status: number; body: Envelope<{ draftId: string }> }
    const draftId = created.body.value?.draftId ?? ''
    await post(`/api/v2/drafts/${draftId}/validate`)
    await post(`/api/v2/drafts/${draftId}/compile`)
    const run = await post(`/api/v2/drafts/${draftId}/run`) as { status: number; body: Envelope<{ runId: string; outcome: { status: string } }> }
    expect(run.body.value?.outcome.status).toBe('AWAITING_APPROVAL')
    const runId = run.body.value?.runId ?? ''

    const rejected = await post(`/api/v2/runs/${runId}/reject`, {
      actor: 'solution-architect',
      role: 'architect',
      reason: 'the affected subgraph needs a second review pass before promotion',
    }) as { status: number; body: Envelope<{ status: string }> }
    expect(rejected.body.value?.status).toBe('REJECTED')

    const inspected = await app.request(`/api/v2/runs/${runId}`)
    const inspection = await inspected.json() as { ok: boolean; value?: { run: { status: string }; promotion: unknown } }
    expect(inspection.value?.run.status).toBe('CANCELLED')
    expect(inspection.value?.promotion ?? null).toBeNull()
    const draftRecord = await app.request(`/api/v2/drafts/${draftId}`)
    const record = await draftRecord.json() as { ok: boolean; value?: { status: string } }
    expect(record.value?.status).toBe('REJECTED')
  })
})

import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { KernlLedger, compileTaskDag, parseAir } from '../../packages/core/src/index.js'
import { createApp, projectPersistedState } from '../../apps/server/src/app.js'

const fixtureDirectory = fileURLToPath(new URL('../../fixtures/air/', import.meta.url))
const temporaryRoots: string[] = []

async function temporaryProjectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kernl-server-test-'))
  temporaryRoots.push(root)
  return root
}

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(fixtureDirectory, name), 'utf8')) as unknown
}

async function seedClaimableRun(root: string, runId = 'claimable-run'): Promise<void> {
  await mkdir(join(root, 'data'), { recursive: true })
  const before = parseAir(await fixture('before.json'))
  const after = parseAir(await fixture('after.json'))
  const ledger = new KernlLedger(join(root, 'data', 'kernl.sqlite'))
  try {
    const stored = ledger.putAir(after)
    ledger.createRun({ id: runId, airDigest: stored.digest, sourceCommit: 'baseline1', status: 'RUNNING' })
    for (const task of compileTaskDag(before, after).tasks) ledger.putTask(runId, task)
    ledger.setTaskStatus(runId, 'validate:air-change', 'SUCCEEDED')
  } finally {
    ledger.close()
  }
}

async function seedApprovalRun(root: string, runId = 'approval-run'): Promise<void> {
  await mkdir(join(root, 'data'), { recursive: true })
  const before = parseAir(await fixture('before.json'))
  const afterInput = structuredClone(await fixture('after.json')) as {
    approvalGates: Array<{ id: string; requiredRole: string }>
  }
  const promotionGate = afterInput.approvalGates.find(gate => gate.id === 'architect-promotion')
  if (!promotionGate) throw new Error('approval fixture is missing architect-promotion')
  promotionGate.requiredRole = 'platform-architect'
  const after = parseAir(afterInput)
  const ledger = new KernlLedger(join(root, 'data', 'kernl.sqlite'))
  try {
    const stored = ledger.putAir(after)
    ledger.createRun({ id: runId, airDigest: stored.digest, sourceCommit: 'baseline1', status: 'AWAITING_APPROVAL' })
    ledger.appendEvent(runId, 'ARCHITECTURE_CHANGE_ACCEPTED', { before, after })
    ledger.requestApproval({ runId, gateId: promotionGate.id })
  } finally {
    ledger.close()
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Kernl server API', () => {
  it('reports the deterministic service health contract', async () => {
    const { app } = createApp(await temporaryProjectRoot())

    const response = await app.request('/api/health')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: 'kernl',
      mode: 'deterministic',
    })
  })

  it('returns the persisted idle-state shape before any run exists', async () => {
    const root = await temporaryProjectRoot()
    const { app } = createApp(root)

    const response = await app.request('/api/state')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      system: { name: 'Kernl', mode: 'deterministic', status: 'idle' },
      architecture: {},
      tasks: [],
      events: [],
      effects: [],
      lifecycle: [],
      bindings: [],
      verification: { attempts: 0, latestGates: [], history: [] },
      approval: null,
      promotion: null,
      evidence: null,
    })
    const database = await stat(join(root, 'data', 'kernl.sqlite'))
    expect(database.isFile()).toBe(true)
    expect(database.size).toBeGreaterThan(0)
  })

  it('projects the required approval role from the persisted AIR gate', async () => {
    const root = await temporaryProjectRoot()
    await seedApprovalRun(root)
    const { app } = createApp(root)

    const response = await app.request('/api/state?runId=approval-run')
    const state = await response.json() as { approval?: { gateId?: string; requiredRole?: string | null } }

    expect(response.status).toBe(200)
    expect(state.approval).toMatchObject({
      gateId: 'architect-promotion',
      requiredRole: 'platform-architect',
    })
  })

  it('uses persisted approval authorization evidence when an AIR projection is unavailable', () => {
    const projected = projectPersistedState({
      approval: { id: 'approval-1', gateId: 'release-gate', decision: 'APPROVED' },
      events: [{
        type: 'APPROVAL_AUTHORIZATION_GRANTED',
        payload: { approvalId: 'approval-1', gateId: 'release-gate', requiredRole: 'release-architect' },
      }],
    }) as { approval: { requiredRole: string | null } }

    expect(projected.approval.requiredRole).toBe('release-architect')
  })

  it('wraps invalid AIR validation as a successful DSH request with validation issues', async () => {
    const { app } = createApp(await temporaryProjectRoot())
    const invalidAir = await fixture('invalid-binding.json')

    const response = await app.request('/api/dsh/validate-change', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ air: invalidAir }),
    })
    const payload = await response.json() as {
      ok: boolean
      value?: { valid: boolean; issues: Array<{ code: string; path: string; message: string }> }
    }

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({ ok: true, value: { valid: false } })
    expect(payload.value?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'BINDING_CAPABILITY_MISMATCH', path: 'bindings.0.capabilityId' }),
      expect.objectContaining({ code: 'PROVIDER_VERSION_MISMATCH', path: 'bindings.0.providerVersion' }),
    ]))
    expect(payload).not.toHaveProperty('error')
  })

  it('compiles the fixture AIR change into the bounded DSH task plan envelope', async () => {
    const { app } = createApp(await temporaryProjectRoot())
    const before = await fixture('before.json')
    const after = await fixture('after.json')

    const response = await app.request('/api/dsh/compile-plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ before, after }),
    })
    const payload = await response.json() as {
      ok: boolean
      value?: {
        id: string
        changeId: string
        fromAirVersion: string
        toAirVersion: string
        directlyAffectedNodeIds: string[]
        tasks: Array<{ id: string; kind: string; writeScopes: string[]; maxAttempts: number }>
        parallelGroups: string[][]
        digest: string
      }
    }

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      ok: true,
      value: {
        id: 'dag:sync-to-queue',
        changeId: 'sync-to-queue',
        fromAirVersion: 'air-001a-sync-contract',
        toAirVersion: 'air-002a-queued-contract',
        directlyAffectedNodeIds: ['api', 'queue', 'worker'],
      },
    })
    expect(payload.value?.tasks.filter(task => task.kind === 'IMPLEMENT')).toEqual([
      expect.objectContaining({ id: 'implement:api', writeScopes: ['src/api.ts'], maxAttempts: 4 }),
      expect.objectContaining({ id: 'implement:queue', writeScopes: ['src/queue.ts'], maxAttempts: 4 }),
      expect.objectContaining({ id: 'implement:worker', writeScopes: ['src/worker.ts'], maxAttempts: 4 }),
    ])
    expect(payload.value?.parallelGroups.every(group => group.length <= 2)).toBe(true)
    expect(payload.value?.digest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects a malformed approval command with HTTP 400', async () => {
    const { app } = createApp(await temporaryProjectRoot())

    const response = await app.request('/api/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'run-without-an-actor' }),
    })
    const payload = await response.json() as { error?: string; status?: number }

    expect(response.status).toBe(400)
    expect(payload).toMatchObject({ status: 400 })
    expect(payload.error).toContain('actor')
  })

  it('requires an explicit local architect role assertion for approval', async () => {
    const { app } = createApp(await temporaryProjectRoot())

    const missingRole = await app.request('/api/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'run', actor: 'local-user' }),
    })
    const wrongRole = await app.request('/api/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'run', actor: 'local-user', role: 'reviewer' }),
    })

    expect(missingRole.status).toBe(400)
    expect(wrongRole.status).toBe(400)
    expect(JSON.stringify(await missingRole.json())).toContain('role')
    expect(JSON.stringify(await wrongRole.json())).toContain('architect')
  })

  it('returns a structured 400 for malformed or unauthorized task claims', async () => {
    const root = await temporaryProjectRoot()
    await seedClaimableRun(root)
    const { app } = createApp(root)

    const malformed = await app.request('/api/dsh/claim-task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'claimable-run', taskId: 'implement:worker' }),
    })
    const unauthorized = await app.request('/api/dsh/claim-task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'claimable-run',
        taskId: 'implement:worker',
        workerId: 'worker-without-authority',
        capabilities: ['typescript'],
        writeScopes: ['src/worker.ts'],
      }),
    })

    expect(malformed.status).toBe(400)
    await expect(malformed.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'KERNL_INVALID_REQUEST', details: expect.any(Array) },
    })
    expect(unauthorized.status).toBe(400)
    await expect(unauthorized.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'KERNL_TASK_AUTHORITY_DENIED' },
    })
  })

  it('allows exactly one worker to win a double claim', async () => {
    const root = await temporaryProjectRoot()
    await seedClaimableRun(root)
    const { app } = createApp(root)
    const claim = (workerId: string) => app.request('/api/dsh/claim-task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'claimable-run',
        taskId: 'implement:worker',
        workerId,
        capabilities: ['task:implement', 'typescript'],
        writeScopes: ['src/worker.ts'],
      }),
    })

    const responses = await Promise.all([claim('worker-one'), claim('worker-two')])
    const payloads = await Promise.all(responses.map(async response => response.json() as Promise<{ ok: boolean; value?: { claimed?: boolean } }>))

    expect(responses.map(response => response.status)).toEqual([200, 200])
    expect(payloads.filter(payload => payload.value?.claimed === true)).toHaveLength(1)
    expect(payloads.filter(payload => payload.value?.claimed === false)).toHaveLength(1)
  })

  it('rejects a task result reported by a worker that did not claim the task', async () => {
    const root = await temporaryProjectRoot()
    await seedClaimableRun(root)
    const { app } = createApp(root)
    await app.request('/api/dsh/claim-task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'claimable-run', taskId: 'implement:worker', workerId: 'claim-owner',
        capabilities: ['task:implement'], writeScopes: ['src/worker.ts'],
      }),
    })

    const response = await app.request('/api/dsh/record-result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'claimable-run', taskId: 'implement:worker', workerId: 'different-worker',
        result: { status: 'completed', summary: 'not authoritative' },
      }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'KERNL_TASK_AUTHORITY_DENIED' },
    })
  })
})

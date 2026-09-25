import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AirValidationError,
  airDigest,
  canonicalJson,
  compileRepairTask,
  compileTaskDag,
  parseAir,
  semanticDiff,
  validateAir,
  validateTaskDag,
  writeScopesOverlap,
  type AirDocument,
} from '../../packages/core/src/index.js'

const fixtureDirectory = new URL('../../fixtures/air/', import.meta.url)

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(name, fixtureDirectory)), 'utf8')) as unknown
}

describe('AIR schema and semantic validation', () => {
  it.each(['before.json', 'after.json', 'queue-v2.json'])('accepts %s and produces a stable digest', (name) => {
    const first = parseAir(fixture(name))
    const reordered = JSON.parse(JSON.stringify(first, Object.keys(first).reverse())) as unknown
    expect(airDigest(first)).toMatch(/^[a-f0-9]{64}$/)
    expect(validateAir(first)).toMatchObject({ success: true, digest: airDigest(first) })
    expect(canonicalJson(first)).toBe(canonicalJson(JSON.parse(canonicalJson(first))))
    expect(reordered).toBeDefined()
  })

  it('rejects capability and exact-provider version mismatches before compilation', () => {
    const result = validateAir(fixture('invalid-binding.json'))
    expect(result.success).toBe(false)
    if (result.success) throw new Error('Expected invalid AIR')
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'BINDING_CAPABILITY_MISMATCH',
      'PROVIDER_VERSION_MISMATCH',
      'UNSATISFIED_CAPABILITY',
    ]))
  })

  it('keeps the exact public API and result contracts unchanged across the queue refactor', () => {
    const before = parseAir(fixture('before.json'))
    const after = parseAir(fixture('after.json'))
    const contract = (air: AirDocument, id: string) => air.contracts.find(candidate => candidate.id === id)

    expect(contract(after, 'public-api-v1')).toEqual(contract(before, 'public-api-v1'))
    expect(contract(after, 'result-v1')).toEqual(contract(before, 'result-v1'))
    expect(contract(after, 'public-api-v1')?.schema).toMatchObject({
      submit: { method: 'POST', path: '/jobs', request: { id: 'string', value: 'string' }, status: 202 },
      read: { method: 'GET', path: '/jobs/{id}', status: 200 },
    })
    expect(contract(after, 'queued-job-v1')?.schema).toEqual({
      eventId: 'string', jobId: 'string', value: 'string',
    })
  })

  it('rejects duplicate exact bindings, unsafe write scopes, and unknown contracts', () => {
    const input = structuredClone(fixture('after.json')) as Record<string, any>
    input.components[0].writeScopes = ['../outside']
    input.components[0].provides[0].contract = 'missing-contract'
    input.bindings.push({ ...input.bindings[0], id: 'second-api-binding' })
    const result = validateAir(input)
    expect(result.success).toBe(false)
    if (result.success) throw new Error('Expected invalid AIR')
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'UNSAFE_WRITE_SCOPE', 'UNKNOWN_CONTRACT', 'AMBIGUOUS_BINDING',
    ]))
  })
})

describe('semantic diff and task DAG compilation', () => {
  const before = parseAir(fixture('before.json'))
  const after = parseAir(fixture('after.json'))

  it('identifies direct write targets separately from the affected topology', () => {
    const diff = semanticDiff(before, after)
    expect(diff.directlyAffectedComponentIds).toEqual(['api', 'queue', 'worker'])
    expect(diff.affectedComponentIds).toEqual(['api', 'queue', 'store', 'worker'])
    expect(diff.components.added.map((component) => component.id)).toEqual(['queue'])
    expect(diff.bindings.added.map((binding) => binding.id)).toEqual(['api-to-queue', 'worker-to-queue'])
    expect(diff.bindings.removed.map((binding) => binding.id)).toEqual(['api-to-worker'])
  })

  it('compiles a deterministic, bounded DAG with exact provenance and write scopes', () => {
    const dag = compileTaskDag(before, after)
    expect(dag.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(dag.fromAirDigest).toBe(airDigest(before))
    expect(dag.toAirDigest).toBe(airDigest(after))
    expect(validateTaskDag(dag.tasks)).toEqual([])

    const mutations = dag.tasks.filter((task) => task.kind === 'IMPLEMENT')
    expect(mutations.map((task) => task.id)).toEqual(['implement:api', 'implement:queue', 'implement:worker'])
    expect(mutations.flatMap((task) => task.writeScopes).sort()).toEqual(['src/api.ts', 'src/queue.ts', 'src/worker.ts'])
    expect(dag.tasks.find((task) => task.id === 'implement:store')).toBeUndefined()
    expect(dag.parallelGroups.every((group) => group.length <= 2)).toBe(true)
    expect(dag.tasks.find((task) => task.kind === 'APPROVAL')).toMatchObject({ requiresApproval: true, deterministic: true })
  })

  it('serializes tasks with overlapping write scopes', () => {
    const changed = structuredClone(after) as AirDocument
    const queue = changed.components.find((component) => component.id === 'queue')
    const worker = changed.components.find((component) => component.id === 'worker')
    if (!queue || !worker) throw new Error('Fixture component missing')
    queue.writeScopes = ['src/shared']
    worker.writeScopes = ['src/shared/worker.ts']
    const dag = compileTaskDag(before, changed)
    const queueTask = dag.tasks.find((task) => task.id === 'implement:queue')
    const workerTask = dag.tasks.find((task) => task.id === 'implement:worker')
    expect(writeScopesOverlap('src/shared', 'src/shared/worker.ts')).toBe(true)
    expect(workerTask?.dependsOn).toContain(queueTask?.id)
    expect(validateTaskDag(dag.tasks)).toEqual([])
  })

  it('creates a repair task only inside the original component write scope and limit', () => {
    const implementation = compileTaskDag(before, after).tasks.find((task) => task.id === 'implement:worker')
    if (!implementation) throw new Error('Implementation task missing')
    const repair = compileRepairTask(implementation, 'EVENT_CONTRACT', 1)
    expect(repair).toMatchObject({ kind: 'REPAIR', writeScopes: ['src/worker.ts'], componentIds: ['worker'] })
    expect(repair.provenance.affectedBy).toContain('VERIFICATION_FAILURE:EVENT_CONTRACT')
    expect(() => compileRepairTask(implementation, 'EVENT_CONTRACT', implementation.maxAttempts)).toThrow(RangeError)
  })

  it('refuses to compile invalid AIR', () => {
    expect(() => compileTaskDag(before, fixture('invalid-binding.json') as AirDocument)).toThrow(AirValidationError)
  })
})

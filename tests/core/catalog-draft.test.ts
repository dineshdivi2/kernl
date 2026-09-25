import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CatalogValidationError,
  KernlLedger,
  applyDraft,
  catalogDigest,
  checkBinding,
  compileDraft,
  parseAir,
  parseCatalog,
  resolveManifest,
  validateDraft,
  type ArchitectureDraft,
  type ParsedCatalog,
} from '../../packages/core/src/index.js'
import type { AirDocument } from '../../packages/core/src/index.js'

const fixtureDirectory = new URL('../../fixtures/', import.meta.url)

function fixture(relative: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relative, fixtureDirectory)), 'utf8')) as unknown
}

function loadCatalog(): ParsedCatalog {
  return parseCatalog(fixture('catalog/kernl-local-catalog.json'))
}

function baseAir(): AirDocument {
  return parseAir(fixture('air/before.json'))
}

function nowIso(): string {
  return '2026-08-21T00:00:00.000Z'
}

function draftWith(overrides: Partial<ArchitectureDraft> & Pick<ArchitectureDraft, 'draftId' | 'componentOps'>): ArchitectureDraft {
  const air = baseAir()
  return {
    schemaVersion: '1.0',
    draftId: overrides.draftId,
    systemId: air.system.id,
    title: overrides.title ?? 'test draft',
    intent: overrides.intent ?? 'test intent',
    baseAirVersion: air.airVersion,
    baseAirDigest: airDigestOf(air),
    componentOps: overrides.componentOps,
    contractChanges: overrides.contractChanges ?? [],
    requestedVerification: overrides.requestedVerification ?? { gates: ['build'] },
    changeNotes: '',
    requestedBy: 'tester',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...('systemId' in overrides ? { systemId: overrides.systemId } : {}),
    ...('baseAirVersion' in overrides ? { baseAirVersion: overrides.baseAirVersion } : {}),
    ...('baseAirDigest' in overrides ? { baseAirDigest: overrides.baseAirDigest } : {}),
  }
}

// Local helper to avoid importing hashing twice under a different name.
import { airDigest as digestOf } from '../../packages/core/src/index.js'
function airDigestOf(air: AirDocument): string {
  return digestOf(air)
}

describe('versioned component catalog', () => {
  it('retains mandatory component verification even when only build is requested', () => {
    const draft=draftWith({draftId:'required-gates',componentOps:[
      {op:'ADD',componentId:'queue',catalogType:'QUEUE',catalogId:'queue',catalogVersion:'1.0.0'},
      {op:'UPGRADE',componentId:'api',catalogType:'HTTP_API',catalogVersion:'2.0.0'},
      {op:'UPGRADE',componentId:'worker',catalogType:'WORKER',catalogVersion:'1.5.0'},
    ],contractChanges:[{op:'REMOVE',contractId:'sync-job-v1'}],requestedVerification:{gates:['build']}})
    const compiled=applyDraft(draft,baseAir(),loadCatalog())
    expect(compiled.after.verification.gates.map(g=>g.id).sort()).toEqual(['build','contract','idempotency','unit'])
  })
  it('parses the local catalog with all supported component kinds', () => {
    const parsed = loadCatalog()
    expect(parsed.issues).toEqual([])
    expect(parsed.catalog.manifests.length).toBeGreaterThanOrEqual(9)
    for (const type of ['HTTP_API', 'WORKER', 'QUEUE', 'STORE', 'POLICY', 'FAILURE_SINK']) {
      expect([...parsed.byTypeVersion.keys()].some(key => key.startsWith(`${type}:`))).toBe(true)
    }
    expect(catalogDigest(parsed.catalog)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('resolves exact manifests by type, id, and version', () => {
    const parsed = loadCatalog()
    expect(resolveManifest(parsed, 'QUEUE', 'queue', '1.0.0')?.component.description).toContain('microtask')
    expect(resolveManifest(parsed, 'QUEUE', 'queue', '2.0.0')).toBeDefined()
    expect(resolveManifest(parsed, 'QUEUE', 'queue', '9.9.9')).toBeUndefined()
  })

  it('rejects duplicate manifests and manifests whose capabilities lack binding rules', () => {
    const raw = JSON.parse(JSON.stringify(fixture('catalog/kernl-local-catalog.json'))) as {
      manifests: Array<{ component: { id: string; type: string; version: string }; bindingRules?: unknown[] }>
    }
    raw.manifests.push(structuredClone(raw.manifests[1]))
    expect(() => parseCatalog(raw)).toThrow(CatalogValidationError)

    const stripped = JSON.parse(JSON.stringify(fixture('catalog/kernl-local-catalog.json'))) as typeof raw
    delete stripped.manifests[3].bindingRules
    expect(() => parseCatalog(stripped)).toThrow(CatalogValidationError)
  })

  it('allows queue bindings for worker dequeue requirements and rejects stores', () => {
    const parsed = loadCatalog()
    const worker = resolveManifest(parsed, 'WORKER', 'worker', '1.5.0')
    const queue = resolveManifest(parsed, 'QUEUE', 'queue', '1.0.0')
    const store = resolveManifest(parsed, 'STORE', 'result-store', '1.0.0')
    if (!worker || !queue || !store) throw new Error('missing manifests')
    expect(checkBinding(parsed, worker, 'jobs.dequeue', queue, 'jobs.dequeue').allowed).toBe(true)
    expect(checkBinding(parsed, worker, 'results.write', store, 'results.write').allowed).toBe(true)
    expect(checkBinding(parsed, worker, 'jobs.dequeue', store, 'jobs.dequeue').allowed).toBe(false)
  })
})

describe('architecture-change drafts', () => {
  it('compiles the sync-to-queue evolution from catalog ops alone', () => {
    const parsed = loadCatalog()
    const draft = draftWith({
      draftId: 'sync-to-queue-via-catalog',
      componentOps: [
        { op: 'ADD', componentId: 'queue', catalogType: 'QUEUE', catalogId: 'queue', catalogVersion: '1.0.0' },
        { op: 'UPGRADE', componentId: 'api', catalogType: 'HTTP_API', catalogVersion: '2.0.0' },
        { op: 'UPGRADE', componentId: 'worker', catalogType: 'WORKER', catalogVersion: '1.5.0' },
      ],
      contractChanges: [{ op: 'REMOVE', contractId: 'sync-job-v1' }],
      requestedVerification: { gates: ['build', 'unit', 'contract', 'idempotency'] },
    })
    const validation = validateDraft(draft, baseAir(), parsed)
    expect(validation.issues).toEqual([])
    expect(validation.valid).toBe(true)

    const compiled = applyDraft(draft, baseAir(), parsed)
    const ids = compiled.after.components.map(component => `${component.id}@${component.version}`).sort()
    expect(ids).toEqual(['api@2.0.0', 'queue@1.0.0', 'store@1.0.0', 'worker@1.5.0'])

    const bindings = compiled.after.bindings.map(binding => `${binding.consumerId}->${binding.providerId}:${binding.capabilityId}`).sort()
    expect(bindings).toEqual(['api->queue:jobs.enqueue', 'worker->queue:jobs.dequeue', 'worker->store:results.write'])

    expect(compiled.after.contracts.some(contract => contract.id === 'sync-job-v1')).toBe(false)
    expect(compiled.after.verification.gates.map(gate => gate.id).sort()).toEqual(['build', 'contract', 'idempotency', 'unit'])
    expect(compiled.after.change.parentAirVersion).toBe(baseAir().airVersion)
    expect(compiled.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(compiled.diff.directlyAffectedComponentIds.sort()).toEqual(['api', 'queue', 'worker'])
    // Compiled AIR must itself be schema-valid.
    expect(() => parseAir(compiled.after)).not.toThrow()
  })

  it('compiles the retry plus dead-letter evolution on top of the queued baseline', () => {
    const parsed = loadCatalog()
    const first = draftWith({
      draftId: 'sync-to-queue-via-catalog',
      componentOps: [
        { op: 'ADD', componentId: 'queue', catalogType: 'QUEUE', catalogId: 'queue', catalogVersion: '1.0.0' },
        { op: 'UPGRADE', componentId: 'api', catalogType: 'HTTP_API', catalogVersion: '2.0.0' },
        { op: 'UPGRADE', componentId: 'worker', catalogType: 'WORKER', catalogVersion: '1.5.0' },
      ],
      contractChanges: [{ op: 'REMOVE', contractId: 'sync-job-v1' }],
      requestedVerification: { gates: ['build'] },
    })
    const queued = applyDraft(first, baseAir(), parsed)

    const second = draftWith({
      draftId: 'add-retry-dlq',
      baseAirVersion: queued.after.airVersion,
      baseAirDigest: queued.digest,
      componentOps: [
        { op: 'UPGRADE', componentId: 'worker', catalogType: 'WORKER', catalogVersion: '2.0.0' },
        { op: 'ADD', componentId: 'retry', catalogType: 'POLICY', catalogId: 'retry-policy', catalogVersion: '1.0.0' },
        { op: 'ADD', componentId: 'dead-letter', catalogType: 'FAILURE_SINK', catalogId: 'dead-letter', catalogVersion: '1.0.0' },
      ],
      requestedVerification: { gates: ['build', 'unit', 'idempotency', 'retry-contract', 'dlq-contract'] },
    })
    const validation = validateDraft(second, queued.after, parsed)
    expect(validation.issues).toEqual([])

    const compiled = applyDraft(second, queued.after, parsed)
    const ids = compiled.after.components.map(component => `${component.id}@${component.version}`).sort()
    expect(ids).toEqual([
      'api@2.0.0', 'dead-letter@1.0.0', 'queue@1.0.0', 'retry@1.0.0', 'store@1.0.0', 'worker@2.0.0',
    ])
    const bindings = compiled.after.bindings.map(binding => `${binding.consumerId}->${binding.providerId}:${binding.capabilityId}`).sort()
    expect(bindings).toEqual([
      'api->queue:jobs.enqueue',
      'worker->dead-letter:jobs.dead-letter',
      'worker->queue:jobs.dequeue',
      'worker->retry:jobs.retry',
      'worker->store:results.write',
    ])
    expect(() => parseAir(compiled.after)).not.toThrow()
  })

  it('rejects drafts that strand consumers or duplicate components before compilation', () => {
    const parsed = loadCatalog()
    const stranded = draftWith({
      draftId: 'remove-queue-only',
      componentOps: [{ op: 'REMOVE', componentId: 'store' }],
      requestedVerification: { gates: ['build'] },
    })
    const result = validateDraft(stranded, baseAir(), parsed)
    expect(result.valid).toBe(false)
    expect(result.issues.map(issue => issue.code)).toContain('NO_PROVIDER')

    const duplicate = draftWith({
      draftId: 'add-second-store',
      componentOps: [{ op: 'ADD', componentId: 'store', catalogType: 'STORE', catalogId: 'result-store', catalogVersion: '1.0.0' }],
      requestedVerification: { gates: ['build'] },
    })
    expect(validateDraft(duplicate, baseAir(), parsed).issues.map(issue => issue.code)).toContain('COMPONENT_EXISTS')

    const bogusGate = draftWith({
      draftId: 'unknown-gate',
      componentOps: [{ op: 'UPGRADE', componentId: 'worker', catalogType: 'WORKER', catalogVersion: '1.5.0' }],
      requestedVerification: { gates: ['quantum-verification'] },
    })
    expect(validateDraft(bogusGate, baseAir(), parsed).issues.map(issue => issue.code)).toContain('GATE_UNKNOWN')

    expect(() => applyDraft(stranded, baseAir(), parsed)).toThrow(/invalid draft/)
  })
})

describe('draft persistence and immutability', () => {
  it('persists catalogs and drafts, enforces locked-draft immutability, and records events', () => {
    const ledger = new KernlLedger(':memory:')
    try {
      const parsed = loadCatalog()
      for (const manifest of parsed.catalog.manifests) ledger.putCatalogManifest(manifest)
      expect(ledger.listCatalogManifests()).toHaveLength(parsed.catalog.manifests.length)

      const manifest = [...parsed.byTypeVersion.values()][0]
      if (!manifest) throw new Error('catalog empty')
      expect(ledger.putCatalogManifest(manifest).digest).toBe(digestOf(manifest))

      const draft = draftWith({ draftId: 'persist-me', componentOps: [] , requestedVerification: { gates: ['build'] } })
      const created = ledger.createDraft({ draft })
      expect(created.status).toBe('DRAFT')

      const updated = structuredClone(draft) as ArchitectureDraft
      updated.title = 'renamed'
      ledger.updateDraftDocument('persist-me', updated)
      expect(ledger.getDraft('persist-me').title).toBe('renamed')

      ledger.setDraftStatus('persist-me', 'LOCKED')
      expect(() => ledger.updateDraftDocument('persist-me', { ...updated, title: 'x3' })).toThrow(/immutable/)

      const events = ledger.listDraftEvents('persist-me')
      expect(events.map(event => event.type)).toEqual(['DRAFT_CREATED', 'DRAFT_UPDATED', 'DRAFT_STATUS_CHANGED'])
      expect(ledger.listDrafts('jobs-system').map(record => record.draftId)).toContain('persist-me')
    } finally {
      ledger.close()
    }
  })
})

// Reuse compileDraft export surface check so tree-shaking never drops it.
describe('compile pipeline parity', () => {
  it('compileDraft reports issues without throwing', () => {
    const parsed = loadCatalog()
    const bad = draftWith({ draftId: 'parity', componentOps: [], requestedVerification: { gates: ['build'] } })
    const result = compileDraft(bad, baseAir(), parsed)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map(issue => issue.code)).toContain('EMPTY_DRAFT')
  })
})

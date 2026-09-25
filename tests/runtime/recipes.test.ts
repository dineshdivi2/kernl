import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseCatalog, resolveManifest } from '../../packages/core/src/index.js'
import {
  generateFromRecipe,
  registeredRepairFingerprints,
  registeredTemplates,
  repairFor,
  scriptedDefectFor,
  UnknownRecipeError,
  UnknownRepairFingerprintError,
} from '../../packages/runtime/src/index.js'

const fixtureDirectory = new URL('../../fixtures/', import.meta.url)

function fixtureText(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, fixtureDirectory)), 'utf8')
}

function normalized(text: string): string {
  return text.replaceAll('\r\n', '\n')
}

function loadCatalog() {
  return parseCatalog(JSON.parse(fixtureText('catalog/kernl-local-catalog.json')))
}

describe('deterministic catalog recipes', () => {
  it('covers every generation template declared by the catalog', () => {
    const catalog = loadCatalog()
    const declared = new Set(catalog.catalog.manifests.map(manifest => manifest.generation.template))
    const available = new Set(registeredTemplates())
    for (const template of declared) expect(available.has(template), template).toBe(true)
    // Every manifest's recipe must actually run and return its own write scopes.
    for (const manifest of catalog.catalog.manifests) {
      const files = generateFromRecipe(manifest.generation.template, { componentId: manifest.component.id, manifest })
      expect(files.length).toBeGreaterThan(0)
      const scoped = new Set(manifest.sourceLayout.writeScopes)
      for (const file of files) {
        expect(scoped.has(file.path) || file.path === 'src/worker.ts' || file.path === 'src/api.ts', `${manifest.component.id}:${file.path}`).toBe(true)
      }
    }
  })

  it('is byte-stable across repeated runs', () => {
    const request = { componentId: 'queue', manifest: { component: { id: 'queue', version: '1.0.0' }, generation: { template: 'kernl.queue-microtask@1', inputs: {}, generates: [], modifies: [] } } }
    const first = generateFromRecipe('kernl.queue-microtask@1', request)
    const second = generateFromRecipe('kernl.queue-microtask@1', request)
    expect(second).toEqual(first)
    expect(first[0]?.content).toContain('queueMicrotask')
  })

  it('emits scenario-one components with the honest unguarded consumer', () => {
    const queueV2 = generateFromRecipe('kernl.queue-microtask-v2@1', { componentId: 'queue', manifest: { component: { id: 'queue', version: '2.0.0' }, generation: { template: '', inputs: {}, generates: [], modifies: [] } } })
    expect(queueV2[0]?.content).toContain('deliveryReceipts')

    const worker = generateFromRecipe('kernl.worker-queue@1', { componentId: 'worker', manifest: { component: { id: 'worker', version: '1.5.0' }, generation: { template: '', inputs: {}, generates: [], modifies: [] } } })
    expect(worker[0]?.content).not.toContain('processedEventIds')
    expect(worker[0]?.content).toContain('subscribe(processEvent)')
    // The unguarded consumer is byte-identical to the scripted duplicate-event defect.
    expect(worker).toEqual(scriptedDefectFor('duplicate-event-effect'))

    const queuedApi = generateFromRecipe('kernl.http-api-queued@1', { componentId: 'api', manifest: { component: { id: 'http-api', version: '2.0.0' }, generation: { template: '', inputs: {}, generates: [], modifies: [] } } })
    expect(queuedApi[0]?.content).toContain('enqueue(')

    const syncApi = generateFromRecipe('kernl.http-api@1', { componentId: 'api', manifest: { component: { id: 'http-api', version: '1.0.0' }, generation: { template: '', inputs: {}, generates: [], modifies: [] } } })
    expect(syncApi[0]?.content).toContain('processJob(request.id, request.value)')
  })

  it('emits the retry-aware worker and a dead-letter sink wired to the retry outcome', () => {
    const worker = generateFromRecipe('kernl.worker-retry@1', { componentId: 'worker', manifest: { component: { id: 'worker', version: '2.0.0' }, generation: { template: '', inputs: {}, generates: [], modifies: [] } } })
    expect(worker[0]?.content).toContain("from './retry.js'")
    expect(worker[0]?.content).toContain("from './dead-letter.js'")
    expect(worker[0]?.content).toContain('recordDeadLetter(')

    const deadLetter = generateFromRecipe('kernl.dead-letter@1', { componentId: 'dead-letter', manifest: { component: { id: 'dead-letter', version: '1.0.0' }, generation: { template: '', inputs: {}, generates: [], modifies: [] } } })
    expect(deadLetter[0]?.content).toContain('attempts: number')

    const defect = scriptedDefectFor('dead-letter-attempts-missing')
    // The defect compiles against the worker call site but drops attempts at persistence time.
    expect(defect[0]?.content).toContain('as DeadLetterRecord')
    expect(defect[0]?.content).not.toContain('records.push({ ...record })')
    expect(defect[0]?.content).not.toBe(deadLetter[0]?.content)
  })

  it('applies scoped repairs for both planned failure fingerprints', () => {
    const workerRepair = repairFor('duplicate-event-effect')
    expect(workerRepair[0]?.path).toBe('src/worker.ts')
    expect(workerRepair[0]?.content).toContain('processedEventIds.has(event.eventId)')

    const dlqRepair = repairFor('dead-letter-attempts-missing')
    expect(dlqRepair[0]?.path).toBe('src/dead-letter.ts')
    expect(dlqRepair[0]?.content).toContain('attempts: number')
    expect(dlqRepair[0]?.content).not.toContain('reason?: string')

    expect(registeredRepairFingerprints()).toEqual(['dead-letter-attempts-missing', 'duplicate-event-effect'])
    expect(() => repairFor('unknown-fingerprint')).toThrow(UnknownRepairFingerprintError)
    expect(() => generateFromRecipe('kernl.unknown@9', { componentId: 'x', manifest: { component: { id: 'x', version: '0.0.0' }, generation: { template: '', inputs: {}, generates: [], modifies: [] } } })).toThrow(UnknownRecipeError)
  })

  it('keeps recipe outputs aligned with the store contract the tests import', () => {
    const storeRecipe = generateFromRecipe('kernl.result-store@1', { componentId: 'store', manifest: { component: { id: 'result-store', version: '1.0.0' }, generation: { template: '', inputs: {}, generates: [], modifies: [] } } })
    const fixtureStore = fixtureText('job-system-template/src/store.ts')
    expect(normalized(storeRecipe[0]?.content ?? '')).toBe(normalized(fixtureStore))
  })

  it('resolves every manifest through the parsed catalog without ambiguity', () => {
    const catalog = loadCatalog()
    for (const key of catalog.byTypeVersion.keys()) {
      const [typePart, rest] = key.split(':')
      if (!typePart || !rest) continue
      const atIndex = rest.lastIndexOf('@')
      const id = rest.slice(0, atIndex)
      const version = rest.slice(atIndex + 1)
      expect(resolveManifest(catalog, typePart, id, version)).toBeDefined()
    }
  })
})

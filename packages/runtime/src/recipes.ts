export interface RecipeFile {
  path: string
  content: string
}

export interface RecipeRequest {
  componentId: string
  manifest: {
    component: { id: string; version: string; type?: string; description?: string }
    generation: { template: string; inputs?: Record<string, unknown> }
  }
}

/**
 * Deterministic catalog recipes. A recipe maps one catalog manifest's
 * generation template to exact file contents. Recipes are pure: identical
 * inputs produce byte-identical outputs, offline and without any model.
 */
export type Recipe = (request: RecipeRequest) => RecipeFile[]

/* ------------------------------------------------------------------ */
/* Canonical component sources                                        */
/* ------------------------------------------------------------------ */

const SYNC_API_SOURCE = `import type { JobAccepted, JobRecord, JobRequest } from './contracts.js'
import { createJob, getJob } from './store.js'
import { processJob } from './worker.js'

export function submitJob(request: JobRequest): JobAccepted {
  createJob(request.id)
  processJob(request.id, request.value)
  return { id: request.id, status: 'accepted' }
}

export function readJob(id: string): JobRecord | undefined {
  return getJob(id)
}
`

const QUEUED_API_SOURCE = `import type { JobAccepted, JobRecord, JobRequest } from './contracts.js'
import { createJob, getJob } from './store.js'
import { enqueue } from './queue.js'
import './worker.js'

export function submitJob(request: JobRequest): JobAccepted {
  createJob(request.id)
  enqueue({ eventId: \`job-created:\${request.id}\`, jobId: request.id, value: request.value })
  return { id: request.id, status: 'accepted' }
}

export function readJob(id: string): JobRecord | undefined {
  return getJob(id)
}
`

const QUEUE_V1_SOURCE = `import type { JobEvent } from './contracts.js'

type Consumer = (event: JobEvent) => void
let consumer: Consumer | undefined

export function subscribe(next: Consumer): () => void {
  consumer = next
  return () => {
    if (consumer === next) consumer = undefined
  }
}

export function enqueue(event: JobEvent): void {
  queueMicrotask(() => consumer?.(event))
}
`

const QUEUE_V2_SOURCE = `import type { JobEvent } from './contracts.js'

type Consumer = (event: JobEvent) => void

let consumer: Consumer | undefined
const deliveryCounts = new Map<string, number>()

export function subscribe(next: Consumer): () => void {
  consumer = next
  return () => {
    if (consumer === next) consumer = undefined
  }
}

export function enqueue(event: JobEvent): void {
  deliveryCounts.set(event.eventId, (deliveryCounts.get(event.eventId) ?? 0) + 1)
  queueMicrotask(() => consumer?.(event))
}

export function deliveryReceipts(): Array<{ eventId: string; deliveries: number }> {
  return [...deliveryCounts.entries()]
    .map(([eventId, deliveries]) => ({ eventId, deliveries }))
    .sort((left, right) => left.eventId.localeCompare(right.eventId))
}
`

/** The honest simple queue consumer: it does not guard against redelivery. */
const WORKER_QUEUE_SOURCE = `import type { JobEvent } from './contracts.js'
import { subscribe } from './queue.js'
import { completeJob } from './store.js'

export function processEvent(event: JobEvent): void {
  completeJob(event.jobId, event.value.toUpperCase())
}

subscribe(processEvent)
`

const WORKER_RETRY_SOURCE = `import type { JobEvent } from './contracts.js'
import { subscribe } from './queue.js'
import { completeJob } from './store.js'
import { retryPolicy } from './retry.js'
import { recordDeadLetter } from './dead-letter.js'

const processedEventIds = new Set<string>()

export function processEvent(event: JobEvent): void {
  if (processedEventIds.has(event.eventId)) return
  processedEventIds.add(event.eventId)
  const outcome = retryPolicy.run(() => {
    completeJob(event.jobId, event.value.toUpperCase())
    return 'completed'
  })
  if (outcome.status === 'failed') {
    recordDeadLetter({
      eventId: event.eventId,
      jobId: event.jobId,
      reason: outcome.reason ?? 'exhausted-retries',
      attempts: outcome.attempts,
    })
  }
}

export function resetWorkerState(): void {
  processedEventIds.clear()
}

subscribe(processEvent)
`

const STORE_SOURCE = `import type { JobRecord } from './contracts.js'

const jobs = new Map<string, JobRecord>()
const processingCounts = new Map<string, number>()

export function createJob(id: string): void {
  jobs.set(id, { id, status: 'pending' })
}

export function completeJob(id: string, result: string): void {
  const count = processingCounts.get(id) ?? 0
  processingCounts.set(id, count + 1)
  jobs.set(id, { id, status: 'completed', result })
}

export function getJob(id: string): JobRecord | undefined {
  return jobs.get(id)
}

export function getProcessingCount(id: string): number {
  return processingCounts.get(id) ?? 0
}

export function resetStore(): void {
  jobs.clear()
  processingCounts.clear()
}
`

const RETRY_POLICY_SOURCE = `export interface RetryOutcome<T> {
  status: 'completed' | 'failed'
  value?: T
  reason?: string
  attempts: number
}

export interface RetryPolicyOptions {
  maxAttempts?: number
}

const defaultMaxAttempts = 3

function boundedRetry<T>(operation: () => T, options: RetryPolicyOptions = {}): RetryOutcome<T> {
  const maxAttempts = options.maxAttempts ?? defaultMaxAttempts
  let lastReason = 'unknown'
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const value = operation()
      return { status: 'completed', value, attempts: attempt }
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error)
    }
  }
  return { status: 'failed', reason: lastReason, attempts: maxAttempts }
}

export const retryPolicy = {
  run: boundedRetry,
  defaults: { maxAttempts: defaultMaxAttempts },
}
`

const DEAD_LETTER_SOURCE = `export interface DeadLetterRecord {
  eventId: string
  jobId: string
  reason: string
  attempts: number
}

const records: DeadLetterRecord[] = []

export function recordDeadLetter(record: DeadLetterRecord): void {
  records.push({ ...record })
}

export function listDeadLetters(): DeadLetterRecord[] {
  return [...records]
}

export function resetDeadLetter(): void {
  records.length = 0
}
`

/* ------------------------------------------------------------------ */
/* Scripted first-candidate defects (deterministic adapter only)      */
/* ------------------------------------------------------------------ */

/**
 * The scripted first dead-letter candidate compiles cleanly but forgets to
 * persist the attempts count. The dlq-contract gate deterministically rejects
 * the recorded shape; the scoped repair restores canonical persistence. This
 * is the scenario-two analogue of the duplicate-delivery defect: an honest
 * integration mistake, never a weakened test.
 */
const DEAD_LETTER_DEFECT_SOURCE = `export interface DeadLetterRecord {
  eventId: string
  jobId: string
  reason: string
  attempts: number
}

const records: DeadLetterRecord[] = []

export function recordDeadLetter(record: DeadLetterRecord): void {
  records.push({ eventId: record.eventId, jobId: record.jobId, reason: record.reason } as DeadLetterRecord)
}

export function listDeadLetters(): DeadLetterRecord[] {
  return [...records]
}

export function resetDeadLetter(): void {
  records.length = 0
}
`

/* ------------------------------------------------------------------ */
/* Registry                                                           */
/* ------------------------------------------------------------------ */

const single = (path: string, content: string): RecipeFile[] => [{ path, content }]

const registry = new Map<string, Recipe>([
  ['kernl.http-api@1', () => single('src/api.ts', SYNC_API_SOURCE)],
  ['kernl.http-api-queued@1', () => single('src/api.ts', QUEUED_API_SOURCE)],
  ['kernl.queue-microtask@1', () => single('src/queue.ts', QUEUE_V1_SOURCE)],
  ['kernl.queue-microtask-v2@1', () => single('src/queue.ts', QUEUE_V2_SOURCE)],
  ['kernl.worker-queue@1', () => single('src/worker.ts', WORKER_QUEUE_SOURCE)],
  ['kernl.worker-retry@1', () => single('src/worker.ts', WORKER_RETRY_SOURCE)],
  ['kernl.result-store@1', () => single('src/store.ts', STORE_SOURCE)],
  ['kernl.retry-policy@1', () => single('src/retry.ts', RETRY_POLICY_SOURCE)],
  ['kernl.dead-letter@1', () => single('src/dead-letter.ts', DEAD_LETTER_SOURCE)],
])

export class UnknownRecipeError extends Error {
  readonly template: string

  constructor(template: string) {
    super(`no deterministic recipe registered for template ${template}`)
    this.name = 'UnknownRecipeError'
    this.template = template
  }
}

export function generateFromRecipe(template: string, request: RecipeRequest): RecipeFile[] {
  const recipe = registry.get(template)
  if (!recipe) throw new UnknownRecipeError(template)
  return recipe(request).map(file => ({ path: file.path, content: file.content }))
}

export function registeredTemplates(): string[] {
  return [...registry.keys()].sort()
}

/* ------------------------------------------------------------------ */
/* Scoped repairs keyed by deterministic failure fingerprint          */
/* ------------------------------------------------------------------ */

const WORKER_GUARDED_SOURCE = `import type { JobEvent } from './contracts.js'
import { subscribe } from './queue.js'
import { completeJob } from './store.js'

const processedEventIds = new Set<string>()

export function processEvent(event: JobEvent): void {
  if (processedEventIds.has(event.eventId)) return
  processedEventIds.add(event.eventId)
  completeJob(event.jobId, event.value.toUpperCase())
}

export function resetWorkerState(): void {
  processedEventIds.clear()
}

subscribe(processEvent)
`

const repairRegistry = new Map<string, RecipeFile[]>([
  ['duplicate-event-effect', single('src/worker.ts', WORKER_GUARDED_SOURCE)],
  ['dead-letter-attempts-missing', single('src/dead-letter.ts', DEAD_LETTER_SOURCE)],
])

export class UnknownRepairFingerprintError extends Error {
  readonly fingerprint: string

  constructor(fingerprint: string) {
    super(`no scoped repair registered for failure fingerprint ${fingerprint}`)
    this.name = 'UnknownRepairFingerprintError'
    this.fingerprint = fingerprint
  }
}

export function repairFor(fingerprint: string): RecipeFile[] {
  const files = repairRegistry.get(fingerprint)
  if (!files) throw new UnknownRepairFingerprintError(fingerprint)
  return files.map(file => ({ path: file.path, content: file.content }))
}

/** Scripted first-candidate variant for a planned initial failure. */
export function scriptedDefectFor(fingerprint: string): RecipeFile[] {
  switch (fingerprint) {
    case 'duplicate-event-effect':
      // The canonical simple consumer already exhibits honest redelivery behavior.
      return single('src/worker.ts', WORKER_QUEUE_SOURCE)
    case 'dead-letter-attempts-missing':
      return single('src/dead-letter.ts', DEAD_LETTER_DEFECT_SOURCE)
    default:
      throw new UnknownRepairFingerprintError(fingerprint)
  }
}

export function registeredRepairFingerprints(): string[] {
  return [...repairRegistry.keys()].sort()
}

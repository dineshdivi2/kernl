import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

if (!existsSync(new URL('../dist/queue.js', import.meta.url))) {
  console.log('idempotency: not applicable to synchronous baseline')
  process.exit(0)
}

const { resetStore, getProcessingCount } = await import('../dist/store.js')
const { processEvent } = await import('../dist/worker.js')

resetStore()
const duplicate = { eventId: 'event-duplicate', jobId: 'job-duplicate', value: 'once' }
processEvent(duplicate)
processEvent(duplicate)
assert.equal(
  getProcessingCount('job-duplicate'),
  1,
  'the same event must not execute the worker effect twice',
)
console.log('idempotency: duplicate delivery produced one effect')

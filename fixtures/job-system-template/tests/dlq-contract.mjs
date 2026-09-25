import assert from 'node:assert/strict'
import { recordDeadLetter, listDeadLetters, resetDeadLetter } from '../dist/dead-letter.js'

resetDeadLetter()
recordDeadLetter({ eventId: 'evt-1', jobId: 'job-1', reason: 'exhausted-retries', attempts: 3 })
recordDeadLetter({ eventId: 'evt-2', jobId: 'job-2', reason: 'poison-event', attempts: 1 })

const records = listDeadLetters()
assert.equal(records.length, 2)

const first = records[0]
assert.ok(first, 'dead-letter record must exist')
assert.deepEqual(Object.keys(first).sort(), ['attempts', 'eventId', 'jobId', 'reason'])
assert.equal(first.attempts, 3)
assert.equal(first.eventId, 'evt-1')
assert.equal(first.jobId, 'job-1')
assert.equal(first.reason, 'exhausted-retries')

console.log('dlq-contract: dead-letter records match the dead-letter-v1 contract')

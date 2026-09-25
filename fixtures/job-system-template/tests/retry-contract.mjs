import assert from 'node:assert/strict'
import { retryPolicy } from '../dist/retry.js'

let calls = 0
const recovered = retryPolicy.run(() => {
  calls += 1
  if (calls < 3) throw new Error('transient failure')
  return 'ok'
})

assert.deepEqual(recovered, { status: 'completed', value: 'ok', attempts: 3 })

let permanentCalls = 0
const exhausted = retryPolicy.run(() => {
  permanentCalls += 1
  throw new Error('permanent failure')
})

assert.equal(exhausted.status, 'failed')
assert.equal(exhausted.attempts, 3)
assert.equal(exhausted.reason, 'permanent failure')
assert.equal(permanentCalls, 3)
assert.equal(retryPolicy.defaults.maxAttempts, 3)

console.log('retry-contract: bounded retry behavior matches retry-policy-v1')

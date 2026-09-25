import assert from 'node:assert/strict'
import { submitJob, readJob } from '../dist/api.js'
import { resetStore } from '../dist/store.js'

resetStore()
const accepted = submitJob({ id: 'unit-1', value: 'kernl' })
assert.deepEqual(accepted, { id: 'unit-1', status: 'accepted' })

await new Promise(resolve => setTimeout(resolve, 25))
assert.deepEqual(readJob('unit-1'), {
  id: 'unit-1',
  status: 'completed',
  result: 'KERNL',
})

console.log('unit: public behavior preserved')

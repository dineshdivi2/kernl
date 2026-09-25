import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createJobServer } from '../dist/server.js'
import { resetStore } from '../dist/store.js'

resetStore()
const server = createJobServer()
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
assert.ok(address && typeof address === 'object')
const origin = `http://127.0.0.1:${address.port}`

try {
  const post = await fetch(`${origin}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'contract-1', value: 'architecture' }),
  })
  assert.equal(post.status, 202)
  assert.deepEqual(await post.json(), { id: 'contract-1', status: 'accepted' })

  let record
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const get = await fetch(`${origin}/jobs/contract-1`)
    assert.equal(get.status, 200)
    record = await get.json()
    if (record.status === 'completed') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.deepEqual(record, {
    id: 'contract-1',
    status: 'completed',
    result: 'ARCHITECTURE',
  })
  console.log('contract: POST/GET schemas and result preserved')
} finally {
  server.close()
  await once(server, 'close')
}

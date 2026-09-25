import assert from 'node:assert/strict'
import test from 'node:test'

import { apply as provideKernl, createKernlClient, KernlApiError } from '../dist/index.js'
import { apply as registerKernlTools, KernlToolArgsError } from '../dist/tools.js'
import { apply as installLiveSmokeGuard } from '../dist/live-smoke-guard.js'

function fakeContext() {
  const services = new Map()
  const definitions = new Map()
  const disposers = []
  const tools = {
    register(definition) {
      definitions.set(definition.name, definition)
      const dispose = () => definitions.delete(definition.name)
      disposers.push(dispose)
      return dispose
    },
  }
  return {
    context: {
      get(name) { return name === 'tools' ? tools : services.get(name) },
      provide(name, value) {
        services.set(name, value)
        const dispose = () => services.delete(name)
        disposers.push(dispose)
        return dispose
      },
    },
    definitions,
    services,
    dispose() {
      for (const disposer of disposers.reverse()) disposer()
    },
  }
}

test('positive fake context loads provider and exposes exactly five bounded tools', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(input)
    const body = JSON.parse(String(init.body))
    calls.push({ path: url.pathname, body, headers: new Headers(init.headers) })
    return new Response(JSON.stringify({ ok: true, value: { path: url.pathname, body } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const fake = fakeContext()
  try {
    provideKernl(fake.context, { baseUrl: 'http://127.0.0.1:43120' })
    registerKernlTools(fake.context)
    assert.deepEqual([...fake.definitions.keys()], [
      'kernl_validate_change',
      'kernl_compile_plan',
      'kernl_claim_task',
      'kernl_record_result',
      'kernl_verify',
    ])
    assert.equal(fake.definitions.has('kernl_request_approval'), false)
    assert.equal(fake.definitions.has('kernl_promote_workflow'), false)
    assert.deepEqual(fake.services.get('kernlTools').names, [...fake.definitions.keys()])
    assert.ok([...fake.definitions.values()].every(definition => Object.keys(definition.output.schema).length === 0))

    const signal = new AbortController().signal
    for (const definition of fake.definitions.values()) {
      const request = { operation: definition.name }
      const value = await definition.execute({ request }, { signal })
      assert.deepEqual(value.body, request)
    }
    assert.deepEqual(calls.map(call => call.path), [
      '/api/dsh/validate-change',
      '/api/dsh/compile-plan',
      '/api/dsh/claim-task',
      '/api/dsh/record-result',
      '/api/dsh/verify',
    ])
    assert.ok(calls.every(call => call.headers.get('x-kernl-dsh-contract') === '1'))
  } finally {
    fake.dispose()
    globalThis.fetch = originalFetch
  }
  assert.equal(fake.services.has('kernl'), false)
  assert.equal(fake.definitions.size, 0)
})

test('negative fake context fails loud when the provider is absent', () => {
  const fake = fakeContext()
  assert.throws(() => registerKernlTools(fake.context), /requires the ctx\.kernl service/)
})

test('negative fake context rejects malformed tool arguments before HTTP', async () => {
  let called = false
  const client = createKernlClient({ baseUrl: 'http://127.0.0.1:43120' }, async () => {
    called = true
    throw new Error('must not be called')
  })
  const fake = fakeContext()
  fake.context.provide('kernl', client)
  registerKernlTools(fake.context)
  const definition = fake.definitions.get('kernl_validate_change')
  await assert.rejects(
    definition.execute({ request: {}, extra: true }, { signal: new AbortController().signal }),
    KernlToolArgsError,
  )
  assert.equal(called, false)
})

test('HTTP client preserves structured Kernl failures', async () => {
  const client = createKernlClient({ baseUrl: 'http://127.0.0.1:43120' }, async () => new Response(JSON.stringify({
    ok: false,
    error: { code: 'BINDING_INVALID', message: 'consumer requires queue.v2' },
  }), { status: 409, headers: { 'content-type': 'application/json' } }))

  await assert.rejects(
    client.validateChange({ change: 'invalid' }),
    error => error instanceof KernlApiError
      && error.code === 'BINDING_INVALID'
      && error.status === 409
      && error.message === 'consumer requires queue.v2',
  )
})

test('config rejects credential-bearing URLs and unknown fields', () => {
  assert.throws(
    () => createKernlClient({ baseUrl: 'http://user:secret@127.0.0.1:43120' }),
    /must not contain credentials/,
  )
  assert.throws(
    () => createKernlClient({ baseUrl: 'http://127.0.0.1:43120', apiKey: 'not-allowed' }),
    /unknown field: apiKey/,
  )
})

test('opt-in terminal tool mode concludes only after a successful HTTP result', async () => {
  const client = createKernlClient({ baseUrl: 'http://127.0.0.1:43120' }, async () => new Response(JSON.stringify({
    ok: true,
    value: { validated: true },
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  const fake = fakeContext()
  fake.context.provide('kernl', client)
  registerKernlTools(fake.context, { concludeTurnAfterSuccess: true })
  let concluded = 0
  const value = await fake.definitions.get('kernl_validate_change').execute(
    { request: { smoke: 'live' } },
    { signal: new AbortController().signal, concludeTurn() { concluded += 1 } },
  )
  assert.deepEqual(value, { validated: true })
  assert.equal(concluded, 1)
  assert.throws(
    () => registerKernlTools(fake.context, { concludeTurnAfterSuccess: 'yes' }),
    /must be a boolean/,
  )
})

test('live smoke guard narrows the Agent and enforces one request and one successful tool result', async () => {
  const listeners = new Map()
  let guard
  let restriction
  const context = {
    get(name) {
      return name === 'tools' ? {
        guard(check) { guard = check; return () => { guard = undefined } },
      } : undefined
    },
    on(event, listener) { listeners.set(event, listener); return () => listeners.delete(event) },
  }
  installLiveSmokeGuard(context)
  listeners.get('agent/session-start')({
    agent: { ctx: { tools: { restrict(value) { restriction = value; return () => {} } } } },
  })
  assert.deepEqual(restriction, { allow: ['kernl_validate_change'] })
  assert.match(guard({ name: 'pwsh' }), /permits only kernl_validate_change/)
  assert.equal(guard({ name: 'kernl_validate_change' }), undefined)

  await listeners.get('agent/request')({}, async () => ({ provider: 'deepseek-official' }))
  listeners.get('tools/result')({ name: 'kernl_validate_change' }, { isError: false })
  assert.doesNotThrow(() => listeners.get('agent/turn-stopping')())
  assert.match(guard({ name: 'kernl_validate_change' }), /only one/)
  await assert.rejects(
    listeners.get('agent/request')({}, async () => ({})),
    /only one model request/,
  )
})

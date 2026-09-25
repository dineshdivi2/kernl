import { apply as provideKernl } from '../src/index.js'
import { apply as registerTools } from '../src/tools.js'
import type { DshToolDefinition, JsonValue } from '../src/contracts.js'

const originalFetch = globalThis.fetch
const services = new Map<string, unknown>()
const tools = new Map<string, DshToolDefinition>()
const disposers: Array<() => void> = []

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof URL ? input : input.toString())
  const request = JSON.parse(String(init?.body)) as JsonValue
  return new Response(JSON.stringify({
    ok: true,
    value: { route: url.pathname, request },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

const context = {
  get(name: string) {
    if (name === 'tools') return toolRuntime
    return services.get(name)
  },
  provide(name: string, value: unknown) {
    services.set(name, value)
    const dispose = () => { services.delete(name) }
    disposers.push(dispose)
    return dispose
  },
}

const toolRuntime = {
  register(definition: DshToolDefinition) {
    tools.set(definition.name, definition)
    const dispose = () => { tools.delete(definition.name) }
    disposers.push(dispose)
    return dispose
  },
}

try {
  provideKernl(context, { baseUrl: 'http://127.0.0.1:43120' })
  registerTools(context)
  const definition = tools.get('kernl_validate_change')
  if (definition === undefined) throw new Error('kernl_validate_change was not registered')
  const result = await definition.execute(
    { request: { smoke: true } },
    { signal: new AbortController().signal },
  )
  console.log(`KERNL_FAKE_SMOKE_OK ${JSON.stringify(result)}`)
} finally {
  for (const dispose of disposers.reverse()) dispose()
  globalThis.fetch = originalFetch
}

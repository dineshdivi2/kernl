import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const readyIndex = args.indexOf('--ready-file')
if (readyIndex < 0 || readyIndex + 1 >= args.length) {
  throw new Error('usage: node fake-api.mjs --ready-file <absolute-path>')
}
const readyFile = args[readyIndex + 1]
const operations = new Set(['validate-change', 'compile-plan', 'claim-task', 'record-result', 'verify'])

const server = createServer((request, response) => {
  void handle(request, response)
})

async function handle(request, response) {
  const match = /^\/api\/dsh\/([^/]+)$/.exec(request.url ?? '')
  if (request.method !== 'POST' || match === null || !operations.has(match[1])) {
    respond(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'route not found' } })
    return
  }

  let bytes = 0
  const chunks = []
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > 1_048_576) {
      respond(response, 413, { ok: false, error: { code: 'REQUEST_TOO_LARGE', message: 'request too large' } })
      return
    }
    chunks.push(chunk)
  }

  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    respond(response, 400, { ok: false, error: { code: 'INVALID_JSON', message: 'invalid JSON' } })
    return
  }

  respond(response, 200, {
    ok: true,
    value: { operation: match[1], request: body, smoke: true },
  })
}

function respond(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake API did not bind a TCP port')
  writeFileSync(readyFile, JSON.stringify({ port: address.port }), { encoding: 'utf8' })
})

const close = () => server.close(() => process.exit(0))
process.on('SIGINT', close)
process.on('SIGTERM', close)

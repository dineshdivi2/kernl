import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { submitJob, readJob } from './api.js'
import type { JobRequest } from './contracts.js'

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

export function createJobServer() {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (request.method === 'POST' && url.pathname === '/jobs') {
      const payload = JSON.parse(await readBody(request)) as JobRequest
      json(response, 202, submitJob(payload))
      return
    }
    if (request.method === 'GET' && url.pathname.startsWith('/jobs/')) {
      const record = readJob(decodeURIComponent(url.pathname.slice('/jobs/'.length)))
      json(response, record ? 200 : 404, record ?? { error: 'not_found' })
      return
    }
    json(response, 404, { error: 'not_found' })
  })
}

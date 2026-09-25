import { serve } from '@hono/node-server'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export function startServer(port = Number(process.env.KERNL_PORT ?? 3001)) {
  const { app } = createApp(projectRoot)
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, info => {
    console.log(`Kernl is running at http://127.0.0.1:${info.port}`)
  })
  return server
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer()
}

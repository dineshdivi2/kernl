import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const tsxCli = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const viteCli = join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')

const children = [
  spawn(process.execPath, [tsxCli, 'watch', 'apps/server/src/index.ts'], {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: true,
  }),
  spawn(process.execPath, [viteCli, '--host', '127.0.0.1'], {
    cwd: join(projectRoot, 'apps', 'web'),
    stdio: 'inherit',
    windowsHide: true,
  }),
]

let closing = false
function stop(exitCode = 0): void {
  if (closing) return
  closing = true
  for (const child of children) child.kill('SIGTERM')
  setTimeout(() => process.exit(exitCode), 250).unref()
}

process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
for (const child of children) {
  child.on('exit', code => {
    if (!closing && code && code !== 0) stop(code)
  })
}

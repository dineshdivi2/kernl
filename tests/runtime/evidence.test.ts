import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { EvidenceWriter } from '../../packages/runtime/src/evidence.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('portable evidence', () => {
  it('replaces checkout and Windows user paths without changing the live value', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'kernl-evidence-'))
    temporaryRoots.push(temporary)
    const projectRoot = join(temporary, 'workspace with spaces', 'architecture-control-plane-startup', 'kernl-prototype')
    const writer = new EvidenceWriter(projectRoot, join(temporary, 'output'))
    await writer.initialize()

    const livePath = join(projectRoot, '.kernl', 'runs', 'run-1', 'integration')
    const liveFileUrl = pathToFileURL(join(livePath, 'src', 'worker.ts')).href
    const userPath = 'C:\\Users\\example-user\\AppData\\Local\\Temp\\kernl'
    const source = { liveFileUrl, livePath, userPath }
    await writer.json('paths.json', source)
    await writer.text('command.txt', `at worker (${liveFileUrl}:12:3) command=${JSON.stringify(livePath)} user=${JSON.stringify(userPath)}\n`)

    const exported = `${await readFile(join(writer.outputDir, 'paths.json'), 'utf8')}\n${await readFile(join(writer.outputDir, 'command.txt'), 'utf8')}`
    expect(exported).toContain('<KERNL_ROOT>')
    expect(exported).toContain('<USER_HOME>')
    expect(exported).not.toContain(temporary)
    expect(exported).not.toContain(liveFileUrl)
    expect(exported).not.toContain('file:///<USER_HOME>')
    expect(exported).not.toContain('%20')
    expect(exported).not.toContain('example-user')
    expect(exported).not.toContain('C:\\\\Users\\\\')
    expect(source).toEqual({ liveFileUrl, livePath, userPath })
  })
})

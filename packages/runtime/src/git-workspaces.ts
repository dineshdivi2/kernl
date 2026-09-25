import { createHash } from 'node:crypto'
import { cp, mkdir, writeFile, access, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { assertChangedPathsAuthorized, authorizeMutations } from './policy.js'
import { requireSuccessful, runCommand } from './process.js'
import type { AgentResult, GitTaskResult, RuntimeTask } from './types.js'

const GIT_IDENTITY = [
  '-c', 'user.name=Kernl',
  '-c', 'user.email=kernl@local',
  '-c', 'core.autocrlf=false',
  '-c', 'core.longpaths=true',
]

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

function compactId(value: string): string {
  const prefix = (safeId(value) || 'id').slice(0, 7)
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 12)
  return `${prefix}-${digest}`
}

export interface RunRepository {
  runRoot: string
  integrationDir: string
  baseCommit: string
}

export class GitWorkspaceManager {
  constructor(private readonly projectRoot: string) {}

  runRepositoryPath(runId: string): string {
    return resolve(this.projectRoot, '.kernl', 'runs', compactId(runId))
  }

  private git(cwd: string, args: string[]) {
    return runCommand('git', [...GIT_IDENTITY, ...args], cwd, { timeoutMs: 30_000 })
  }

  async createRunRepository(runId: string, fixtureDir: string, recover = false): Promise<RunRepository> {
    const runRoot = this.runRepositoryPath(runId)
    const integrationDir = join(runRoot, 'integration')
    await mkdir(runRoot, { recursive: true })
    const exists = await access(join(integrationDir,'.git')).then(()=>true,()=>false)
    if (!exists) await cp(resolve(fixtureDir), integrationDir, { recursive: true, errorOnExist: !recover,
      filter: source => !source.slice(resolve(fixtureDir).length).split(/[\\/]/).some(part=>['.git','node_modules','dist'].includes(part)) })
    await requireSuccessful(this.git(integrationDir, ['init', '-b', 'main']))
    await requireSuccessful(this.git(integrationDir, ['add', '--all']))
    const head = await this.git(integrationDir, ['rev-parse', '--verify', 'HEAD'])
    if (head.exitCode !== 0) await requireSuccessful(this.git(integrationDir, ['commit', '-m', 'fixture: architecture baseline']))
    const baseCommit = (await requireSuccessful(this.git(integrationDir, ['rev-parse', 'HEAD']))).stdout.trim()
    return { runRoot, integrationDir, baseCommit }
  }

  async currentCommit(integrationDir: string): Promise<string> {
    return (await requireSuccessful(this.git(integrationDir, ['rev-parse', 'HEAD']))).stdout.trim()
  }

  async assertClean(integrationDir:string):Promise<void> {
    if((await requireSuccessful(this.git(integrationDir,['status','--porcelain']))).stdout.trim()) throw new Error('candidate has uncommitted changes and cannot be promoted')
  }

  async executeTask(
    repository: RunRepository,
    task: RuntimeTask,
    result: AgentResult,
    options: { recover?: boolean; baseCommit?: string; checkpoint?: (phase: string) => void; guard?: () => void } = {},
  ): Promise<GitTaskResult> {
    const taskSlug = compactId(`${task.id}-attempt-${task.attempt}`)
    const branch = `task/${taskSlug}`
    const worktree = join(repository.runRoot, 'tasks', taskSlug)
    const baseCommit = options.baseCommit ?? await this.currentCommit(repository.integrationDir)

    await mkdir(dirname(worktree), { recursive: true })
    options.guard?.()
    const branchExists = options.recover && (await this.git(repository.integrationDir, ['show-ref','--verify',`refs/heads/${branch}`])).exitCode === 0
    if (!branchExists) await requireSuccessful(this.git(repository.integrationDir, ['worktree', 'add', '-b', branch, worktree, baseCommit]))
    options.checkpoint?.('worktree-created')
    authorizeMutations(task, worktree, result.mutations)

    const alreadyCommitted = options.recover && await this.currentCommit(worktree) !== baseCommit
    for (const mutation of result.mutations) {
      options.guard?.()
      const target = resolve(worktree, mutation.path)
      if (alreadyCommitted) {
        if (await readFile(target,'utf8') !== mutation.content) throw new Error('recovered task content does not match the frozen proposal')
        continue
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, mutation.content, 'utf8')
    }
    options.checkpoint?.('files-written')

    const changed = await requireSuccessful(this.git(worktree, ['status', '--porcelain']))
    const changedPaths = changed.stdout.split(/\r?\n/)
      .map(value => value.length >= 4 ? value.slice(3).trim() : '')
      .map(value => value.includes(' -> ') ? value.split(' -> ').at(-1) ?? value : value)
      .filter(Boolean)
    assertChangedPathsAuthorized(task, changedPaths)
    options.guard?.()
    if (changedPaths.length) {
      await requireSuccessful(this.git(worktree, ['add', '--', ...changedPaths]))
      await requireSuccessful(this.git(worktree, ['commit', '-m', `kernl: ${task.title}`]))
    }
    const taskCommit = (await requireSuccessful(this.git(worktree, ['rev-parse', 'HEAD']))).stdout.trim()
    options.checkpoint?.('task-committed')
    const patch = (await requireSuccessful(this.git(worktree, ['diff', '--binary', baseCommit, taskCommit]))).stdout

    options.guard?.()
    const merged = (await this.git(repository.integrationDir, ['merge-base','--is-ancestor',taskCommit,'HEAD'])).exitCode === 0
    if (!merged) {
      if (await this.currentCommit(repository.integrationDir) !== baseCommit) throw new Error('integration head changed outside the frozen task')
      await requireSuccessful(this.git(repository.integrationDir, ['merge', '--no-ff', branch, '-m', `integrate: ${task.title}`]))
    }
    const integratedCommit = await this.currentCommit(repository.integrationDir)
    options.checkpoint?.('integrated')
    const committedPaths = (await requireSuccessful(this.git(worktree,['diff','--name-only',baseCommit,taskCommit]))).stdout.trim().split(/\r?\n/).filter(Boolean)

    return {
      taskId: task.id,
      branch,
      baseCommit,
      taskCommit,
      integratedCommit,
      changedPaths: committedPaths,
      patch,
      worktree,
    }
  }

  async diff(repository: RunRepository): Promise<string> {
    return (await requireSuccessful(this.git(repository.integrationDir, [
      'diff', '--binary', repository.baseCommit, 'HEAD',
    ]))).stdout
  }
}

export type TaskKind = 'queue-contract' | 'api-refactor' | 'worker-refactor' | 'worker-repair'

export interface RuntimeTask {
  id: string
  title: string
  kind: TaskKind
  dependencies: string[]
  allowedPaths: string[]
  architectureNodeIds: string[]
  contracts: string[]
  acceptanceGates: string[]
  forbiddenActions: string[]
  attempt: number
  maxAttempts: number
}

export interface CommandResult {
  command: string
  args: string[]
  cwd: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

export interface AgentMutation {
  path: string
  content: string
}

export interface AgentResult {
  adapter: 'deterministic'
  taskId: string
  summary: string
  mutations: AgentMutation[]
}

export interface GateResult {
  name: string
  status: 'passed' | 'failed'
  exitCode: number
  durationMs: number
  summary: string
  stdout: string
  stderr: string
  evidencePath?: string
  failureFingerprint?: string
  repairScope?: string[]
}

export interface VerificationReport {
  attempt: number
  status: 'passed' | 'failed'
  startedAt: string
  finishedAt: string
  gates: GateResult[]
  digest?: string
}

export interface GitTaskResult {
  taskId: string
  branch: string
  baseCommit: string
  taskCommit: string
  integratedCommit: string
  changedPaths: string[]
  patch: string
  worktree: string
}

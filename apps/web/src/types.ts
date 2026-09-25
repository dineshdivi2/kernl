export type LifecycleState =
  | 'PENDING'
  | 'LOADING'
  | 'ACTIVE'
  | 'RETIRING'
  | 'DRAINING'
  | 'INACTIVE'
  | 'FAILED'

export type Status =
  | 'idle'
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'waiting_approval'
  | 'approved'
  | 'promoted'
  | 'completed'
  | string

export interface Capability {
  name: string
  version?: string
  contract?: string
}

export interface ArchitectureComponent {
  id: string
  name: string
  kind?: string
  version: string
  lifecycle: LifecycleState | string
  provides?: Capability[]
  requires?: Capability[]
  x?: number
  y?: number
}

export interface ArchitectureBinding {
  id?: string
  from: string
  to: string
  capability: string
  version?: string
  contract?: string
  status?: string
}

export interface ArchitectureGraph {
  version?: string
  components: ArchitectureComponent[]
  bindings: ArchitectureBinding[]
}

export interface ArchitectureChange {
  id?: string
  summary?: string
  before: ArchitectureGraph
  after: ArchitectureGraph
  affectedComponents?: string[]
}

export interface RunTask {
  id: string
  title: string
  status: Status
  agent?: string
  kind?: string
  writeScopes?: string[]
  dependencies?: string[]
  attempt?: number
  evidence?: string
}

export interface RunState {
  id: string
  status: Status
  mode?: string
  airVersion?: string
  startedAt?: string
  completedAt?: string
  repairCount?: number
  maxRepairAttempts?: number
  tasks: RunTask[]
}

export interface VerificationGate {
  id: string
  name: string
  status: Status
  summary?: string
  evidencePath?: string
  durationMs?: number
}

export interface EffectReceipt {
  id: string
  sequence?: number
  componentId?: string
  taskId?: string
  effectType: string
  resource: string
  status?: Status
  recoveryClass: string
  idempotencyKey: string
  resultingState?: string
  createdAt?: string
}

export interface ProviderLifecycle {
  providerId: string
  version?: string
  state: LifecycleState | string
  relianceCount?: number
  acceptsNewBindings?: boolean
}

export interface ApprovalState {
  id?: string
  status: Status
  requestedAt?: string
  decidedAt?: string
  actor?: string
  gateId?: string
  requiredRole?: string
}

export interface PromotionState {
  status: Status
  workflowVersion?: string
  workflowPath?: string
  airVersion?: string
  gitCommit?: string
  verificationId?: string
  evidenceCore?: string
  evidenceManifest?: string
  artifactDir?: string
}

export interface ReplayState {
  status?: Status
  eventCount?: number
  effectCount?: number
  duplicateEffects?: number
  replayedAt?: string
  stableAcrossRestart?: boolean
}

export interface KernlState {
  architecture: ArchitectureGraph
  change?: ArchitectureChange
  run?: RunState
  verification: VerificationGate[]
  effects: EffectReceipt[]
  lifecycle?: ProviderLifecycle[]
  approval?: ApprovalState
  promotion?: PromotionState
  replay?: ReplayState
  updatedAt?: string
}

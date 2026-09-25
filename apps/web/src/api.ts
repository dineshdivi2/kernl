import type {
  ArchitectureBinding,
  ArchitectureComponent,
  ArchitectureGraph,
  Capability,
  EffectReceipt,
  KernlState,
  LifecycleState,
  ProviderLifecycle,
  ReplayState,
  RunTask,
  Status,
  VerificationGate,
} from './types'

type JsonRecord = Record<string, unknown>

interface WireAir {
  version?: string
  digest?: string
  nodes?: JsonRecord[]
  components?: JsonRecord[]
  edges?: JsonRecord[]
  bindings?: JsonRecord[]
}

interface WireState {
  system?: JsonRecord
  architecture?: {
    before?: WireAir
    after?: WireAir
    diff?: { changedNodeIds?: string[]; changedEdgeIds?: string[]; summary?: string }
  }
  tasks?: JsonRecord[]
  events?: JsonRecord[]
  effects?: JsonRecord[]
  lifecycle?: JsonRecord[]
  bindings?: JsonRecord[]
  verification?: { attempts?: number; latestGates?: JsonRecord[]; history?: JsonRecord[] }
  approval?: JsonRecord | null
  promotion?: JsonRecord | null
  evidence?: JsonRecord | null
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function objectCount(value: unknown): number | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : undefined
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function capability(value: unknown): Capability {
  if (typeof value !== 'string') return { name: 'unknown' }
  const separator = value.lastIndexOf('@')
  return separator > 0
    ? { name: value.slice(0, separator), version: value.slice(separator + 1) }
    : { name: value }
}

function lifecycleSnapshots(raw: JsonRecord[] = []): ProviderLifecycle[] {
  return raw.map((entry, index) => ({
    providerId: text(entry.providerId, text(entry.componentId, text(entry.id, `provider-${index + 1}`))),
    version: text(entry.version) || undefined,
    state: text(entry.state, text(entry.lifecycleState, 'PENDING')),
    relianceCount: number(entry.relianceCount ?? entry.reliance),
    acceptsNewBindings: boolean(entry.acceptsNewBindings),
  }))
}

function graph(raw: WireAir | undefined, fallbackBindings: JsonRecord[], lifecycle: ProviderLifecycle[]): ArchitectureGraph {
  const nodes = raw?.nodes ?? raw?.components ?? []
  const lifecycleById = new Map(lifecycle.map((snapshot) => [snapshot.providerId, snapshot]))
  const components: ArchitectureComponent[] = nodes.map((node, index) => {
    const id = text(node.id, `component-${index + 1}`)
    const position = typeof node.position === 'object' && node.position ? node.position as JsonRecord : undefined
    const snapshot = lifecycleById.get(id) ?? lifecycle.find(candidate =>
      (candidate.providerId.startsWith(`${id}-v`) || candidate.providerId === `${id}@${text(node.version)}`)
      && candidate.version === text(node.version),
    )
    return {
      id,
      name: text(node.label, text(node.name, id)),
      kind: text(node.kind) || undefined,
      version: text(node.version, snapshot?.version ?? 'unversioned'),
      lifecycle: text(node.lifecycle, snapshot?.state ?? 'PENDING') as LifecycleState,
      provides: stringList(node.provides).map(capability),
      requires: stringList(node.requires).map(capability),
      x: number(position?.x ?? node.x),
      y: number(position?.y ?? node.y),
    }
  })
  const rawBindings = raw?.edges ?? raw?.bindings ?? fallbackBindings
  const bindings: ArchitectureBinding[] = rawBindings.map((binding, index) => ({
    id: text(binding.id) || undefined,
    from: text(binding.from),
    to: text(binding.to),
    capability: text(binding.capability, 'untyped'),
    version: text(binding.providerVersion, text(binding.version)) || undefined,
    contract: text(binding.contract) || undefined,
    status: text(binding.status) || undefined,
  })).filter((binding) => binding.from && binding.to)

  return { version: raw?.version ?? raw?.digest, components, bindings }
}

function task(raw: JsonRecord, index: number): RunTask {
  return {
    id: text(raw.id, `task-${index + 1}`),
    title: text(raw.title, text(raw.kind, `Task ${index + 1}`)),
    status: text(raw.status, 'pending') as Status,
    agent: text(raw.agent, text(raw.claimedBy)) || undefined,
    kind: text(raw.kind) || undefined,
    writeScopes: stringList(raw.allowedPaths ?? raw.writeScopes),
    dependencies: stringList(raw.dependencies),
    attempt: number(raw.attempt),
    evidence: text(raw.evidence) || undefined,
  }
}

function gate(raw: JsonRecord, index: number): VerificationGate {
  const name = text(raw.name, `Gate ${index + 1}`)
  return {
    id: text(raw.id, `${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}-${index}`),
    name,
    status: text(raw.status, 'pending') as Status,
    summary: text(raw.summary) || undefined,
    evidencePath: text(raw.evidencePath) || undefined,
    durationMs: number(raw.durationMs),
  }
}

function effect(raw: JsonRecord, index: number): EffectReceipt {
  const result = typeof raw.result === 'object' && raw.result ? raw.result as JsonRecord : undefined
  const rawStatus = text(raw.status, text(result?.status))
  return {
    id: text(raw.id, `effect-${index + 1}`),
    sequence: number(raw.sequence),
    componentId: text(raw.componentId) || undefined,
    taskId: text(raw.taskId) || undefined,
    effectType: text(raw.effectType, text(raw.type, 'UNKNOWN_EFFECT')),
    resource: text(raw.resource, text(raw.resourceIdentity, text(raw.resourceId, 'unknown-resource'))),
    status: rawStatus ? rawStatus as Status : undefined,
    recoveryClass: text(raw.recoveryClass, text(raw.recoveryClassification, text(raw.classification, 'RETRY_SAFE'))),
    idempotencyKey: text(raw.idempotencyKey, `missing:${index + 1}`),
    resultingState: text(raw.resultingState, text(result?.state)) || undefined,
    createdAt: text(raw.createdAt, text(raw.committedAt)) || undefined,
  }
}

export function normalizeWireState(wire: WireState): KernlState {
  const system = wire.system ?? {}
  const tasks = (wire.tasks ?? []).map(task)
  const lifecycle = lifecycleSnapshots(wire.lifecycle)
  const after = graph(wire.architecture?.after, wire.bindings ?? [], lifecycle)
  const before = wire.architecture?.before ? graph(wire.architecture.before, [], lifecycle) : undefined
  const latestEvent = wire.events?.at(-1)
  const attempts = wire.verification?.attempts
  const highestTaskAttempt = Math.max(1, ...tasks.map((item) => item.attempt ?? 1))
  const approval = wire.approval
  const promotion = wire.promotion
  const evidence = wire.evidence
  const runId = text(system.runId)

  return {
    architecture: after,
    change: before ? {
      summary: wire.architecture?.diff?.summary,
      before,
      after,
      affectedComponents: wire.architecture?.diff?.changedNodeIds ?? [],
    } : undefined,
    run: runId ? {
      id: runId,
      status: text(system.status, 'idle') as Status,
      mode: text(system.mode) || undefined,
      airVersion: after.version,
      repairCount: Math.max(0, (attempts ?? highestTaskAttempt) - 1),
      tasks,
    } : undefined,
    verification: (wire.verification?.latestGates ?? []).map(gate),
    effects: (wire.effects ?? []).map(effect),
    lifecycle,
    approval: approval ? {
      id: text(approval.id) || undefined,
      status: text(approval.decision, 'waiting_approval') as Status,
      actor: text(approval.actor) || undefined,
      gateId: text(approval.gateId) || undefined,
      requiredRole: text(approval.requiredRole) || undefined,
      requestedAt: text(approval.requestedAt) || undefined,
      decidedAt: text(approval.decidedAt, text(approval.createdAt)) || undefined,
    } : undefined,
    promotion: promotion ? {
      status: 'promoted',
      workflowVersion: text(promotion.workflowVersion) || undefined,
      airVersion: text(promotion.airVersion, text(promotion.airDigest)) || undefined,
      gitCommit: text(promotion.candidateCommit, text(promotion.gitCommit)) || undefined,
      verificationId: text(promotion.verificationDigest, text(promotion.verificationId)) || undefined,
      evidenceCore: text(evidence?.coreDigest, text(promotion.evidenceDigest)) || undefined,
      evidenceManifest: text(evidence?.manifestDigest) || undefined,
      workflowPath: text(promotion.workflowArtifactPath, text(promotion.workflowPath, text(evidence?.workflowPath))) || undefined,
      artifactDir: text(evidence?.artifactDir) || undefined,
    } : undefined,
    updatedAt: text(latestEvent?.createdAt, text(latestEvent?.timestamp)) || undefined,
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    let detail = ''
    try {
      const body = (await response.json()) as { error?: string; message?: string }
      detail = body.error ?? body.message ?? ''
    } catch {
      detail = await response.text().catch(() => '')
    }
    throw new Error(detail || `Request failed with status ${response.status}`)
  }
  return response.json()
}

async function command(path: string, body: JsonRecord): Promise<unknown> {
  return readJson(await fetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

export async function loadState(): Promise<KernlState> {
  const response = await fetch('/api/state', { headers: { Accept: 'application/json' } })
  return normalizeWireState(await readJson(response) as WireState)
}

export async function runDemo(): Promise<KernlState> {
  await command('/api/demo', {})
  return loadState()
}

export async function approveRun(runId: string, actor: string): Promise<KernlState> {
  await command('/api/approve', { runId, actor, role: 'architect' })
  return loadState()
}

function replayReport(raw: unknown): ReplayState {
  const report = typeof raw === 'object' && raw ? raw as JsonRecord : {}
  const projection = typeof report.projection === 'object' && report.projection ? report.projection as JsonRecord : {}
  const stable = boolean(report.stableAcrossRestart)
  return {
    status: stable === false ? 'failed' : stable === true ? 'passed' : text(report.status, 'completed'),
    eventCount: number(report.eventCount ?? report.eventsReplayed),
    effectCount: number(report.effectCount ?? report.effectsReconstructed) ?? objectCount(projection.effects),
    duplicateEffects: number(report.duplicateEffects ?? report.effectsReexecuted ?? report.duplicatesPrevented),
    replayedAt: text(report.replayedAt, new Date().toISOString()),
    stableAcrossRestart: stable,
  }
}

export async function replayRun(runId: string): Promise<KernlState> {
  const report = await command('/api/replay', { runId })
  const state = await loadState()
  return { ...state, replay: replayReport(report) }
}

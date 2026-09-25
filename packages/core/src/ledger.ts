import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { airDigest, parseAir, type AirDocument, type RecoveryClassification } from './air.js'
import type { ArchitectureDraft, DraftStatus } from './draft.js'
import type { CatalogManifest } from './catalog.js'
import { canonicalJson, digestJson } from './hashing.js'
import { redactSecrets } from './redaction.js'
import type { CompiledTask } from './task-dag.js'

export type RunStatus = 'PENDING' | 'PLANNING' | 'RUNNING' | 'VERIFYING' | 'AWAITING_APPROVAL' | 'PROMOTED' | 'FAILED' | 'CANCELLED'
export type TaskStatus = 'PENDING' | 'CLAIMED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'CANCELLED'
export type ApprovalDecision = 'PENDING' | 'APPROVED' | 'REJECTED'

export interface StoredAirVersion {
  digest: string
  systemId: string
  airVersion: string
  document: AirDocument
  createdAt: string
}

export interface RunRecord {
  id: string
  airDigest: string
  sourceCommit: string
  status: RunStatus
  traceId: string
  createdAt: string
  updatedAt: string
}

export interface TaskRecord {
  id: string
  runId: string
  kind: string
  status: TaskStatus
  dependencies: string[]
  writeScopes: string[]
  provenance: Record<string, unknown>
  attempt: number
  maxAttempts: number
  claimedBy?: string
  claimCapabilities?: string[]
  claimWriteScopes?: string[]
  createdAt: string
  updatedAt: string
}

export interface TaskClaimInput {
  runId: string
  taskId: string
  workerId: string
  capabilities: string[]
  writeScopes: string[]
}

export type TaskClaimResult =
  | { claimed: true; task: TaskRecord; requiredCapability: string }
  | { claimed: false; taskId: string; reason: 'TASK_NOT_PENDING' | 'DEPENDENCIES_NOT_READY' }

export interface EventRecord<T = unknown> {
  sequence: number
  eventId: string
  runId: string
  taskId?: string
  type: string
  payload: T
  traceId: string
  createdAt: string
}

export interface EffectReceipt {
  id: string
  runId: string
  episodeId: string
  componentId: string
  taskId: string
  effectType: string
  resourceIdentity: string
  idempotencyKey: string
  preconditions: unknown
  result: unknown
  resultingState: string
  recoveryClassification: RecoveryClassification
  recoveryMetadata: unknown
  provenance: unknown
  committedAt: string
}

export interface EffectReceiptInput extends Omit<EffectReceipt, 'id' | 'committedAt'> {
  id?: string
  committedAt?: string
}

export interface BindingLedgerRecord {
  id: string
  runId: string
  consumerId: string
  requirementId: string
  providerId: string
  providerVersion: string
  state: 'COMMITTED' | 'RELEASED'
  relianceCount: number
  updatedAt: string
}

export interface ApprovalRecord {
  id: string
  runId: string
  gateId: string
  decision: ApprovalDecision
  actor?: string
  evidenceDigest?: string
  requestedAt: string
  decidedAt?: string
}

export interface PromotionRecord {
  id: string
  runId: string
  airDigest: string
  sourceCommit: string
  verificationDigest: string
  evidenceDigest: string
  workflowDigest: string
  workflow: unknown
  createdAt: string
}

export interface LedgerExport {
  exportedAt: string
  air: StoredAirVersion
  run: RunRecord
  tasks: TaskRecord[]
  events: EventRecord[]
  effects: EffectReceipt[]
  bindings: BindingLedgerRecord[]
  approvals: ApprovalRecord[]
  promotion?: PromotionRecord
  manifestDigest: string
}

export const DRAFT_MUTABLE_STATUSES: readonly DraftStatus[] = ['DRAFT', 'INVALID', 'VALID']

export interface ArchitectureDraftRecord {
  draftId: string
  systemId: string
  baseAirVersion: string
  baseAirDigest: string
  title: string
  status: DraftStatus
  draft: ArchitectureDraft
  compiledAirDigest?: string
  createdAt: string
  updatedAt: string
}

export interface CatalogManifestRecord {
  digest: string
  componentType: string
  componentId: string
  componentVersion: string
  manifest: CatalogManifest
  createdAt: string
}

export interface DraftEventRecord {
  sequence: number
  draftId: string
  type: string
  payload: unknown
  createdAt: string
}

export interface RunProjection {
  runId: string
  status: RunStatus | 'UNKNOWN'
  airDigest?: string
  sourceCommit?: string
  traceId?: string
  tasks: Record<string, Pick<TaskRecord, 'id' | 'kind' | 'status' | 'attempt' | 'maxAttempts'>>
  approvals: Record<string, ApprovalDecision>
  effects: Record<string, EffectReceipt>
  bindings: Record<string, BindingLedgerRecord>
  promotion?: PromotionRecord
  lastSequence: number
}

export interface LedgerOptions {
  clock?: () => string
  idFactory?: () => string
  knownSecrets?: readonly string[]
}

export class LedgerNotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} was not found`)
    this.name = 'LedgerNotFoundError'
  }
}

export class IdempotencyConflictError extends Error {
  readonly idempotencyKey: string

  constructor(idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was already committed with different effect data`)
    this.name = 'IdempotencyConflictError'
    this.idempotencyKey = idempotencyKey
  }
}

export class TaskClaimInputError extends Error {
  readonly code = 'KERNL_INVALID_TASK_CLAIM'

  constructor(message: string) {
    super(message)
    this.name = 'TaskClaimInputError'
  }
}

export class TaskClaimAuthorityError extends Error {
  readonly code = 'KERNL_TASK_AUTHORITY_DENIED'
  readonly details: Readonly<Record<string, unknown>>

  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message)
    this.name = 'TaskClaimAuthorityError'
    this.details = details
  }
}

export const LEDGER_MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS air_versions (
        digest TEXT PRIMARY KEY,
        system_id TEXT NOT NULL,
        air_version TEXT NOT NULL,
        document_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(system_id, air_version)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        air_digest TEXT NOT NULL REFERENCES air_versions(digest),
        source_commit TEXT NOT NULL,
        status TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        dependencies_json TEXT NOT NULL,
        write_scopes_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id, id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        task_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS events_run_sequence_idx ON events(run_id, sequence);
      CREATE INDEX IF NOT EXISTS events_run_task_idx ON events(run_id, task_id, sequence);

      CREATE TABLE IF NOT EXISTS effect_receipts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        episode_id TEXT NOT NULL,
        component_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        effect_type TEXT NOT NULL,
        resource_identity TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        preconditions_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        resulting_state TEXT NOT NULL,
        recovery_classification TEXT NOT NULL,
        recovery_metadata_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        committed_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS effect_receipts_run_idx ON effect_receipts(run_id, committed_at);

      CREATE TABLE IF NOT EXISTS bindings (
        id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        consumer_id TEXT NOT NULL,
        requirement_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        provider_version TEXT NOT NULL,
        state TEXT NOT NULL,
        reliance_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id, id)
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS bindings_one_committed_exact_idx
      ON bindings(run_id, consumer_id, requirement_id)
      WHERE state = 'COMMITTED';

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        gate_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        actor TEXT,
        evidence_digest TEXT,
        requested_at TEXT NOT NULL,
        decided_at TEXT,
        PRIMARY KEY(run_id, id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS promotions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
        air_digest TEXT NOT NULL REFERENCES air_versions(digest),
        source_commit TEXT NOT NULL,
        verification_digest TEXT NOT NULL,
        evidence_digest TEXT NOT NULL,
        workflow_digest TEXT NOT NULL,
        workflow_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE tasks ADD COLUMN claimed_by TEXT;
      ALTER TABLE tasks ADD COLUMN claim_capabilities_json TEXT;
      ALTER TABLE tasks ADD COLUMN claim_write_scopes_json TEXT;
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS catalog_manifests (
        digest TEXT PRIMARY KEY,
        component_type TEXT NOT NULL,
        component_id TEXT NOT NULL,
        component_version TEXT NOT NULL,
        document_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(component_type, component_id, component_version)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS architecture_drafts (
        draft_id TEXT PRIMARY KEY,
        system_id TEXT NOT NULL,
        base_air_version TEXT NOT NULL,
        base_air_digest TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        document_json TEXT NOT NULL,
        compiled_air_digest TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS architecture_drafts_system_idx ON architecture_drafts(system_id, updated_at);

      CREATE TABLE IF NOT EXISTS draft_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        draft_id TEXT NOT NULL REFERENCES architecture_drafts(draft_id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS draft_events_draft_idx ON draft_events(draft_id, sequence);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE run_inputs (
        run_id TEXT PRIMARY KEY REFERENCES runs(id), digest TEXT NOT NULL, document_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE operations (
        run_id TEXT NOT NULL REFERENCES runs(id), key TEXT NOT NULL, intent_digest TEXT NOT NULL,
        intent_json TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT,
        PRIMARY KEY(run_id, key)
      ) STRICT;
      CREATE TABLE execution_leases (
        run_id TEXT PRIMARY KEY REFERENCES runs(id), owner TEXT NOT NULL, epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
]

type SqlRow = Record<string, string | number | null>

function json<T>(text: string | number | null | undefined): T {
  if (typeof text !== 'string') throw new TypeError('Expected persisted JSON text')
  return JSON.parse(text) as T
}

function optionalString(value: string | number | null | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function nonEmptyClaimString(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) throw new TaskClaimInputError(`${field} is required`)
  return normalized
}

function normalizedStringSet(values: readonly string[], field: string): string[] {
  if (!Array.isArray(values)) throw new TaskClaimInputError(`${field} must be an array`)
  const normalized = values.map((value, index) => {
    if (typeof value !== 'string') throw new TaskClaimInputError(`${field}.${index} must be a string`)
    return nonEmptyClaimString(value, `${field}.${index}`)
  })
  if (new Set(normalized).size !== normalized.length) throw new TaskClaimInputError(`${field} must not contain duplicates`)
  return normalized.sort()
}

function normalizedClaimScopes(values: readonly string[]): string[] {
  return normalizedStringSet(values, 'writeScopes').map((scope) => scope.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')).sort()
}

export function taskClaimCapability(kind: string): string {
  return `task:${kind.toLowerCase()}`
}

function airFromRow(row: SqlRow): StoredAirVersion {
  return {
    digest: String(row.digest),
    systemId: String(row.system_id),
    airVersion: String(row.air_version),
    document: parseAir(json(row.document_json)),
    createdAt: String(row.created_at),
  }
}

function runFromRow(row: SqlRow): RunRecord {
  return {
    id: String(row.id), airDigest: String(row.air_digest), sourceCommit: String(row.source_commit), status: String(row.status) as RunStatus,
    traceId: String(row.trace_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function taskFromRow(row: SqlRow): TaskRecord {
  const record: TaskRecord = {
    id: String(row.id), runId: String(row.run_id), kind: String(row.kind), status: String(row.status) as TaskStatus,
    dependencies: json(row.dependencies_json), writeScopes: json(row.write_scopes_json), provenance: json(row.provenance_json),
    attempt: Number(row.attempt), maxAttempts: Number(row.max_attempts), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
  const claimedBy = optionalString(row.claimed_by)
  const claimCapabilities = optionalString(row.claim_capabilities_json)
  const claimWriteScopes = optionalString(row.claim_write_scopes_json)
  return {
    ...record,
    ...(claimedBy ? { claimedBy } : {}),
    ...(claimCapabilities ? { claimCapabilities: json<string[]>(claimCapabilities) } : {}),
    ...(claimWriteScopes ? { claimWriteScopes: json<string[]>(claimWriteScopes) } : {}),
  }
}

function eventFromRow(row: SqlRow): EventRecord {
  const base: EventRecord = {
    sequence: Number(row.sequence), eventId: String(row.event_id), runId: String(row.run_id), type: String(row.type),
    payload: json(row.payload_json), traceId: String(row.trace_id), createdAt: String(row.created_at),
  }
  const taskId = optionalString(row.task_id)
  return taskId ? { ...base, taskId } : base
}

function effectFromRow(row: SqlRow): EffectReceipt {
  return {
    id: String(row.id), runId: String(row.run_id), episodeId: String(row.episode_id), componentId: String(row.component_id),
    taskId: String(row.task_id), effectType: String(row.effect_type), resourceIdentity: String(row.resource_identity),
    idempotencyKey: String(row.idempotency_key), preconditions: json(row.preconditions_json), result: json(row.result_json),
    resultingState: String(row.resulting_state), recoveryClassification: String(row.recovery_classification) as RecoveryClassification,
    recoveryMetadata: json(row.recovery_metadata_json), provenance: json(row.provenance_json), committedAt: String(row.committed_at),
  }
}

function bindingFromRow(row: SqlRow): BindingLedgerRecord {
  return {
    id: String(row.id), runId: String(row.run_id), consumerId: String(row.consumer_id), requirementId: String(row.requirement_id),
    providerId: String(row.provider_id), providerVersion: String(row.provider_version), state: String(row.state) as BindingLedgerRecord['state'],
    relianceCount: Number(row.reliance_count), updatedAt: String(row.updated_at),
  }
}

function approvalFromRow(row: SqlRow): ApprovalRecord {
  const base: ApprovalRecord = {
    id: String(row.id), runId: String(row.run_id), gateId: String(row.gate_id), decision: String(row.decision) as ApprovalDecision,
    requestedAt: String(row.requested_at),
  }
  const actor = optionalString(row.actor)
  const evidenceDigest = optionalString(row.evidence_digest)
  const decidedAt = optionalString(row.decided_at)
  return { ...base, ...(actor ? { actor } : {}), ...(evidenceDigest ? { evidenceDigest } : {}), ...(decidedAt ? { decidedAt } : {}) }
}

function promotionFromRow(row: SqlRow): PromotionRecord {
  return {
    id: String(row.id), runId: String(row.run_id), airDigest: String(row.air_digest), sourceCommit: String(row.source_commit),
    verificationDigest: String(row.verification_digest), evidenceDigest: String(row.evidence_digest), workflowDigest: String(row.workflow_digest),
    workflow: json(row.workflow_json), createdAt: String(row.created_at),
  }
}

function draftRecordFromRow(row: SqlRow): ArchitectureDraftRecord {
  const compiled = optionalString(row.compiled_air_digest)
  return {
    draftId: String(row.draft_id),
    systemId: String(row.system_id),
    baseAirVersion: String(row.base_air_version),
    baseAirDigest: String(row.base_air_digest),
    title: String(row.title),
    status: String(row.status) as DraftStatus,
    draft: json(row.document_json) as ArchitectureDraft,
    ...(compiled ? { compiledAirDigest: compiled } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function catalogManifestFromRow(row: SqlRow): CatalogManifestRecord {
  return {
    digest: String(row.digest),
    componentType: String(row.component_type),
    componentId: String(row.component_id),
    componentVersion: String(row.component_version),
    manifest: json(row.document_json) as CatalogManifest,
    createdAt: String(row.created_at),
  }
}

function draftEventFromRow(row: SqlRow): DraftEventRecord {
  return {
    sequence: Number(row.sequence),
    draftId: String(row.draft_id),
    type: String(row.type),
    payload: json(row.payload_json),
    createdAt: String(row.created_at),
  }
}

export class KernlLedger {
  readonly database: DatabaseSync
  readonly #clock: () => string
  readonly #idFactory: () => string
  readonly #knownSecrets: readonly string[]

  constructor(path = ':memory:', options: LedgerOptions = {}) {
    this.database = new DatabaseSync(path)
    this.#clock = options.clock ?? (() => new Date().toISOString())
    this.#idFactory = options.idFactory ?? randomUUID
    this.#knownSecrets = options.knownSecrets ?? []
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.migrate()
  }

  close(): void {
    this.database.close()
  }

  freezeRunInputs<T>(runId: string, input: T): T {
    this.getRun(runId)
    const document = canonicalJson(input)
    const digest = digestJson(input)
    const existing = this.database.prepare('SELECT digest, document_json FROM run_inputs WHERE run_id = ?').get(runId) as SqlRow | undefined
    if (existing) {
      if (existing.digest !== digest) throw new Error('run inputs are immutable; context differs from frozen plan')
      return json<T>(existing.document_json)
    }
    this.database.prepare('INSERT INTO run_inputs VALUES (?, ?, ?)').run(runId, digest, document)
    this.appendEvent(runId, 'RUN_INPUTS_FROZEN', { digest })
    return input
  }

  getRunInputs<T>(runId: string): T {
    const row = this.database.prepare('SELECT document_json FROM run_inputs WHERE run_id = ?').get(runId) as SqlRow | undefined
    if (!row) throw new Error('frozen run inputs were not found')
    return json<T>(row.document_json)
  }

  operation<T = unknown>(runId: string, key: string): { intent: unknown; state: string; result?: T } | undefined {
    const row = this.database.prepare('SELECT intent_json,state,result_json FROM operations WHERE run_id = ? AND key = ?').get(runId, key) as SqlRow | undefined
    return row ? { intent: json(row.intent_json), state: String(row.state), ...(row.result_json ? { result: json<T>(row.result_json) } : {}) } : undefined
  }

  planOperation(runId: string, key: string, intent: unknown): void {
    const prior = this.database.prepare('SELECT intent_digest FROM operations WHERE run_id = ? AND key = ?').get(runId, key) as SqlRow | undefined
    const digest = digestJson(intent)
    if (prior) {
      if (prior.intent_digest !== digest) throw new Error('operation intent changed during recovery')
      return
    }
    this.transaction(() => {
      this.database.prepare("INSERT INTO operations VALUES (?, ?, ?, ?, 'PLANNED', NULL)").run(runId,key,digest,canonicalJson(intent))
      this.rawEvent(runId, 'OPERATION_PLANNED', { key, digest })
    })
  }

  commitOperation(runId: string, key: string, result: unknown): void {
    const prior = this.operation(runId,key)
    if (!prior) throw new Error('operation must be planned before it can commit')
    if (prior.state === 'COMMITTED') {
      if (digestJson(prior.result) !== digestJson(result)) throw new Error('committed operation result changed')
      return
    }
    this.transaction(() => {
      this.database.prepare("UPDATE operations SET state='COMMITTED', result_json=? WHERE run_id=? AND key=?").run(canonicalJson(result),runId,key)
      this.rawEvent(runId, 'OPERATION_COMMITTED', { key, resultDigest: digestJson(result) })
    })
  }

  acquireExecution(runId: string, owner: string, durationMs = 120_000): number {
    return this.transaction(() => {
      const now = Date.now()
      const prior = this.database.prepare('SELECT * FROM execution_leases WHERE run_id=?').get(runId) as SqlRow | undefined
      if (prior && Number(prior.expires_at) > now) throw new Error('run execution is already leased')
      const epoch = Number(prior?.epoch ?? 0) + 1
      this.database.prepare('INSERT INTO execution_leases VALUES (?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET owner=excluded.owner,epoch=excluded.epoch,expires_at=excluded.expires_at').run(runId,owner,epoch,now+durationMs)
      return epoch
    })
  }

  renewExecution(runId: string, owner: string, epoch: number): void {
    const result = this.database.prepare('UPDATE execution_leases SET expires_at=? WHERE run_id=? AND owner=? AND epoch=? AND expires_at>?').run(Date.now()+120_000,runId,owner,epoch,Date.now())
    if (Number(result.changes) !== 1) throw new Error('execution lease lost; stale worker fenced')
  }

  releaseExecution(runId: string, owner: string, epoch: number): void {
    this.database.prepare('UPDATE execution_leases SET expires_at=0 WHERE run_id=? AND owner=? AND epoch=?').run(runId,owner,epoch)
  }

  migrate(): void {
    this.database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;')
    const appliedRows = this.database.prepare('SELECT version FROM schema_migrations').all() as SqlRow[]
    const applied = new Set(appliedRows.map((row) => Number(row.version)))
    for (const migration of LEDGER_MIGRATIONS) {
      if (applied.has(migration.version)) continue
      this.transaction(() => {
        this.database.exec(migration.sql)
        this.database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(migration.version, this.#clock())
      })
    }
  }

  private transaction<T>(action: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private rawEvent(runId: string, type: string, payload: unknown, taskId?: string, traceId?: string): EventRecord {
    const run = this.getRun(runId)
    const eventId = this.#idFactory()
    const createdAt = this.#clock()
    const safePayload = redactSecrets(payload, { knownSecrets: this.#knownSecrets })
    this.database.prepare(`
      INSERT INTO events(event_id, run_id, task_id, type, payload_json, trace_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, runId, taskId ?? null, type, canonicalJson(safePayload), traceId ?? run.traceId, createdAt)
    const row = this.database.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId) as SqlRow | undefined
    if (!row) throw new LedgerNotFoundError('event', eventId)
    return eventFromRow(row)
  }

  putAir(document: AirDocument): StoredAirVersion {
    const validated = parseAir(document)
    const digest = airDigest(validated)
    const existingVersion = this.database.prepare(
      'SELECT * FROM air_versions WHERE system_id = ? AND air_version = ?',
    ).get(validated.system.id, validated.airVersion) as SqlRow | undefined
    if (existingVersion) {
      const stored = airFromRow(existingVersion)
      if (stored.digest !== digest) {
        throw new Error(`AIR ${validated.system.id}@${validated.airVersion} is immutable and already bound to digest ${stored.digest}`)
      }
      return stored
    }
    const createdAt = this.#clock()
    this.database.prepare(`
      INSERT INTO air_versions(digest, system_id, air_version, document_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(digest) DO NOTHING
    `).run(digest, validated.system.id, validated.airVersion, canonicalJson(validated), createdAt)
    return this.getAir(digest)
  }

  getAir(digest: string): StoredAirVersion {
    const row = this.database.prepare('SELECT * FROM air_versions WHERE digest = ?').get(digest) as SqlRow | undefined
    if (!row) throw new LedgerNotFoundError('AIR version', digest)
    return airFromRow(row)
  }

  createRun(input: { id?: string; airDigest: string; sourceCommit: string; traceId?: string; status?: RunStatus }): RunRecord {
    this.getAir(input.airDigest)
    const id = input.id ?? this.#idFactory()
    const traceId = input.traceId ?? this.#idFactory()
    const status = input.status ?? 'PENDING'
    const now = this.#clock()
    return this.transaction(() => {
      this.database.prepare(`INSERT INTO runs(id, air_digest, source_commit, status, trace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.airDigest, input.sourceCommit, status, traceId, now, now)
      const run = this.getRun(id)
      this.rawEvent(id, 'RUN_CREATED', run, undefined, traceId)
      return run
    })
  }

  getRun(runId: string): RunRecord {
    const row = this.database.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as SqlRow | undefined
    if (!row) throw new LedgerNotFoundError('run', runId)
    return runFromRow(row)
  }

  setRunStatus(runId: string, status: RunStatus): RunRecord {
    const now = this.#clock()
    return this.transaction(() => {
      const result = this.database.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE id = ?').run(status, now, runId)
      if (Number(result.changes) !== 1) throw new LedgerNotFoundError('run', runId)
      const run = this.getRun(runId)
      this.rawEvent(runId, 'RUN_STATUS_CHANGED', { status })
      return run
    })
  }

  /** Bind the run to the verified integration commit before approval/promotion. */
  setRunSourceCommit(runId: string, sourceCommit: string): RunRecord {
    if (sourceCommit.trim().length < 7) throw new RangeError('sourceCommit must contain at least 7 characters')
    const current = this.getRun(runId)
    if (current.status === 'PROMOTED') throw new Error('A promoted run cannot be rebound to another source commit')
    return this.transaction(() => {
      const updatedAt = this.#clock()
      this.database.prepare('UPDATE runs SET source_commit = ?, updated_at = ? WHERE id = ?').run(sourceCommit, updatedAt, runId)
      const run = this.getRun(runId)
      this.rawEvent(runId, 'RUN_SOURCE_COMMIT_CHANGED', { previousSourceCommit: current.sourceCommit, sourceCommit })
      return run
    })
  }

  putTask(runId: string, task: CompiledTask, status: TaskStatus = 'PENDING', attempt = 1): TaskRecord {
    this.getRun(runId)
    const now = this.#clock()
    const safeProvenance = redactSecrets(task.provenance, { knownSecrets: this.#knownSecrets }) as unknown as Record<string, unknown>
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO tasks(id, run_id, kind, status, dependencies_json, write_scopes_json, provenance_json, attempt, max_attempts, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, id) DO UPDATE SET
          kind = excluded.kind, status = excluded.status, dependencies_json = excluded.dependencies_json,
          write_scopes_json = excluded.write_scopes_json, provenance_json = excluded.provenance_json,
          attempt = excluded.attempt, max_attempts = excluded.max_attempts, claimed_by = NULL,
          claim_capabilities_json = NULL, claim_write_scopes_json = NULL, updated_at = excluded.updated_at
      `).run(task.id, runId, task.kind, status, canonicalJson(task.dependsOn), canonicalJson(task.writeScopes), canonicalJson(safeProvenance), attempt, task.maxAttempts, now, now)
      const record = this.getTask(runId, task.id)
      this.rawEvent(runId, 'TASK_UPSERTED', record, task.id)
      return record
    })
  }

  getTask(runId: string, taskId: string): TaskRecord {
    const row = this.database.prepare('SELECT * FROM tasks WHERE run_id = ? AND id = ?').get(runId, taskId) as SqlRow | undefined
    if (!row) throw new LedgerNotFoundError('task', `${runId}/${taskId}`)
    return taskFromRow(row)
  }

  listTasks(runId: string): TaskRecord[] {
    return (this.database.prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY id').all(runId) as SqlRow[]).map(taskFromRow)
  }

  /**
   * Atomically grant one worker the exact authority declared by a mutable task.
   *
   * Worker capabilities may be a superset of the task capability, but the
   * requested write scopes must exactly equal the compiler-produced scopes.
   * This prevents a model from widening its own filesystem authority.
   */
  claimTask(input: TaskClaimInput): TaskClaimResult {
    const runId = nonEmptyClaimString(input.runId, 'runId')
    const taskId = nonEmptyClaimString(input.taskId, 'taskId')
    const workerId = nonEmptyClaimString(input.workerId, 'workerId')
    const capabilities = normalizedStringSet(input.capabilities, 'capabilities')
    const declaredWriteScopes = normalizedClaimScopes(input.writeScopes)

    return this.transaction(() => {
      const task = this.getTask(runId, taskId)
      if (task.kind !== 'IMPLEMENT' && task.kind !== 'REPAIR') {
        throw new TaskClaimAuthorityError(`task ${taskId} is ${task.kind} and cannot be claimed by an implementation worker`, {
          taskId,
          taskKind: task.kind,
        })
      }

      const requiredCapability = taskClaimCapability(task.kind)
      if (!capabilities.includes(requiredCapability)) {
        throw new TaskClaimAuthorityError(`worker ${workerId} does not declare required capability ${requiredCapability}`, {
          taskId,
          workerId,
          requiredCapability,
        })
      }

      const taskWriteScopes = normalizedClaimScopes(task.writeScopes)
      if (canonicalJson(declaredWriteScopes) !== canonicalJson(taskWriteScopes)) {
        throw new TaskClaimAuthorityError(`worker ${workerId} requested write scopes that do not exactly match task ${taskId}`, {
          taskId,
          workerId,
          declaredWriteScopes,
          taskWriteScopes,
        })
      }

      if (task.status !== 'PENDING') return { claimed: false, taskId, reason: 'TASK_NOT_PENDING' }
      const dependencyStatuses = task.dependencies.map((dependency) => this.getTask(runId, dependency))
      if (dependencyStatuses.some((dependency) => dependency.status !== 'SUCCEEDED')) {
        return { claimed: false, taskId, reason: 'DEPENDENCIES_NOT_READY' }
      }

      const now = this.#clock()
      const result = this.database.prepare(`
        UPDATE tasks
        SET status = 'CLAIMED', claimed_by = ?, claim_capabilities_json = ?, claim_write_scopes_json = ?, updated_at = ?
        WHERE run_id = ? AND id = ? AND status = 'PENDING'
      `).run(workerId, canonicalJson(capabilities), canonicalJson(declaredWriteScopes), now, runId, taskId)
      if (Number(result.changes) !== 1) return { claimed: false, taskId, reason: 'TASK_NOT_PENDING' }

      const claimed = this.getTask(runId, taskId)
      this.rawEvent(runId, 'TASK_CLAIMED', {
        taskId,
        workerId,
        requiredCapability,
        declaredCapabilities: capabilities,
        declaredWriteScopes,
      }, taskId)
      return { claimed: true, task: claimed, requiredCapability }
    })
  }

  setTaskStatus(runId: string, taskId: string, status: TaskStatus, attempt?: number): TaskRecord {
    const current = this.getTask(runId, taskId)
    const nextAttempt = attempt ?? current.attempt
    if (nextAttempt > current.maxAttempts) throw new RangeError(`Task ${taskId} attempt ${nextAttempt} exceeds ${current.maxAttempts}`)
    return this.transaction(() => {
      this.database.prepare('UPDATE tasks SET status = ?, attempt = ?, updated_at = ? WHERE run_id = ? AND id = ?')
        .run(status, nextAttempt, this.#clock(), runId, taskId)
      const record = this.getTask(runId, taskId)
      this.rawEvent(runId, 'TASK_STATUS_CHANGED', { taskId, status, attempt: nextAttempt }, taskId)
      return record
    })
  }

  appendEvent(runId: string, type: string, payload: unknown, taskId?: string): EventRecord {
    return this.rawEvent(runId, type, payload, taskId)
  }

  listEvents(runId: string, options: { afterSequence?: number; type?: string; taskId?: string } = {}): EventRecord[] {
    this.getRun(runId)
    const clauses = ['run_id = ?']
    const parameters: Array<string | number> = [runId]
    if (options.afterSequence !== undefined) {
      clauses.push('sequence > ?')
      parameters.push(options.afterSequence)
    }
    if (options.type !== undefined) {
      clauses.push('type = ?')
      parameters.push(options.type)
    }
    if (options.taskId !== undefined) {
      clauses.push('task_id = ?')
      parameters.push(options.taskId)
    }
    const rows = this.database.prepare(`SELECT * FROM events WHERE ${clauses.join(' AND ')} ORDER BY sequence`).all(...parameters) as SqlRow[]
    return rows.map(eventFromRow)
  }

  appendEffectReceipt(input: EffectReceiptInput): { receipt: EffectReceipt; inserted: boolean } {
    this.getRun(input.runId)
    const safeInput = redactSecrets(input, { knownSecrets: this.#knownSecrets })
    const existingRow = this.database.prepare('SELECT * FROM effect_receipts WHERE idempotency_key = ?').get(input.idempotencyKey) as SqlRow | undefined
    if (existingRow) {
      const existing = effectFromRow(existingRow)
      if (this.effectFingerprint(existing) !== this.effectFingerprint(safeInput)) throw new IdempotencyConflictError(input.idempotencyKey)
      return { receipt: existing, inserted: false }
    }

    const receipt: EffectReceipt = {
      ...safeInput,
      id: safeInput.id ?? this.#idFactory(),
      committedAt: safeInput.committedAt ?? this.#clock(),
    }
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO effect_receipts(
          id, run_id, episode_id, component_id, task_id, effect_type, resource_identity, idempotency_key,
          preconditions_json, result_json, resulting_state, recovery_classification, recovery_metadata_json, provenance_json, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receipt.id, receipt.runId, receipt.episodeId, receipt.componentId, receipt.taskId, receipt.effectType, receipt.resourceIdentity,
        receipt.idempotencyKey, canonicalJson(receipt.preconditions), canonicalJson(receipt.result), receipt.resultingState,
        receipt.recoveryClassification, canonicalJson(receipt.recoveryMetadata), canonicalJson(receipt.provenance), receipt.committedAt,
      )
      this.rawEvent(receipt.runId, 'EFFECT_COMMITTED', receipt, receipt.taskId)
      return { receipt, inserted: true }
    })
  }

  private effectFingerprint(receipt: EffectReceiptInput | EffectReceipt): string {
    return digestJson({
      runId: receipt.runId, episodeId: receipt.episodeId, componentId: receipt.componentId, taskId: receipt.taskId,
      effectType: receipt.effectType, resourceIdentity: receipt.resourceIdentity, idempotencyKey: receipt.idempotencyKey,
      preconditions: receipt.preconditions, result: receipt.result, resultingState: receipt.resultingState,
      recoveryClassification: receipt.recoveryClassification, recoveryMetadata: receipt.recoveryMetadata, provenance: receipt.provenance,
    })
  }

  listEffects(runId: string): EffectReceipt[] {
    return (this.database.prepare('SELECT * FROM effect_receipts WHERE run_id = ? ORDER BY committed_at, id').all(runId) as SqlRow[]).map(effectFromRow)
  }

  putBinding(input: Omit<BindingLedgerRecord, 'updatedAt'> & { updatedAt?: string }): BindingLedgerRecord {
    this.getRun(input.runId)
    const updatedAt = input.updatedAt ?? this.#clock()
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO bindings(id, run_id, consumer_id, requirement_id, provider_id, provider_version, state, reliance_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, id) DO UPDATE SET provider_id = excluded.provider_id, provider_version = excluded.provider_version,
          state = excluded.state, reliance_count = excluded.reliance_count, updated_at = excluded.updated_at
      `).run(input.id, input.runId, input.consumerId, input.requirementId, input.providerId, input.providerVersion, input.state, input.relianceCount, updatedAt)
      const row = this.database.prepare('SELECT * FROM bindings WHERE run_id = ? AND id = ?').get(input.runId, input.id) as SqlRow | undefined
      if (!row) throw new LedgerNotFoundError('binding', input.id)
      const record = bindingFromRow(row)
      this.rawEvent(input.runId, 'BINDING_RECORDED', record)
      return record
    })
  }

  listBindings(runId: string): BindingLedgerRecord[] {
    return (this.database.prepare('SELECT * FROM bindings WHERE run_id = ? ORDER BY id').all(runId) as SqlRow[]).map(bindingFromRow)
  }

  requestApproval(input: { id?: string; runId: string; gateId: string }): ApprovalRecord {
    this.getRun(input.runId)
    const id = input.id ?? this.#idFactory()
    const requestedAt = this.#clock()
    return this.transaction(() => {
      this.database.prepare(`INSERT INTO approvals(id, run_id, gate_id, decision, requested_at) VALUES (?, ?, ?, 'PENDING', ?)`)
        .run(id, input.runId, input.gateId, requestedAt)
      const approval = this.getApproval(input.runId, id)
      this.rawEvent(input.runId, 'APPROVAL_REQUESTED', approval)
      return approval
    })
  }

  decideApproval(input: { runId: string; approvalId: string; decision: Exclude<ApprovalDecision, 'PENDING'>; actor: string; evidenceDigest: string }): ApprovalRecord {
    const existing = this.getApproval(input.runId, input.approvalId)
    if (existing.decision !== 'PENDING') throw new Error(`Approval ${input.approvalId} was already decided`)
    return this.transaction(() => {
      this.database.prepare(`UPDATE approvals SET decision = ?, actor = ?, evidence_digest = ?, decided_at = ? WHERE run_id = ? AND id = ?`)
        .run(input.decision, input.actor, input.evidenceDigest, this.#clock(), input.runId, input.approvalId)
      const approval = this.getApproval(input.runId, input.approvalId)
      this.rawEvent(input.runId, 'APPROVAL_DECIDED', approval)
      return approval
    })
  }

  getApproval(runId: string, approvalId: string): ApprovalRecord {
    const row = this.database.prepare('SELECT * FROM approvals WHERE run_id = ? AND id = ?').get(runId, approvalId) as SqlRow | undefined
    if (!row) throw new LedgerNotFoundError('approval', approvalId)
    return approvalFromRow(row)
  }

  listApprovals(runId: string): ApprovalRecord[] {
    return (this.database.prepare('SELECT * FROM approvals WHERE run_id = ? ORDER BY requested_at, id').all(runId) as SqlRow[]).map(approvalFromRow)
  }

  recordPromotion(input: Omit<PromotionRecord, 'id' | 'workflowDigest' | 'createdAt'> & { id?: string; createdAt?: string }): PromotionRecord {
    const run = this.getRun(input.runId)
    if (run.airDigest !== input.airDigest || run.sourceCommit !== input.sourceCommit) {
      throw new Error('Promotion must bind the exact AIR digest and source commit from the run')
    }
    if (!this.listApprovals(input.runId).some((approval) =>
      approval.decision === 'APPROVED' && approval.evidenceDigest === input.evidenceDigest,
    )) {
      throw new Error('Promotion requires an approved gate bound to the exact evidence digest')
    }
    const safeWorkflow = redactSecrets(input.workflow, { knownSecrets: this.#knownSecrets })
    const promotion: PromotionRecord = {
      ...input,
      id: input.id ?? this.#idFactory(),
      workflowDigest: digestJson(safeWorkflow),
      workflow: safeWorkflow,
      createdAt: input.createdAt ?? this.#clock(),
    }
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO promotions(id, run_id, air_digest, source_commit, verification_digest, evidence_digest, workflow_digest, workflow_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        promotion.id, promotion.runId, promotion.airDigest, promotion.sourceCommit, promotion.verificationDigest,
        promotion.evidenceDigest, promotion.workflowDigest, canonicalJson(promotion.workflow), promotion.createdAt,
      )
      this.rawEvent(input.runId, 'WORKFLOW_PROMOTED', promotion)
      this.database.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE id = ?').run('PROMOTED', this.#clock(), input.runId)
      return promotion
    })
  }

  getPromotion(runId: string): PromotionRecord | undefined {
    const row = this.database.prepare('SELECT * FROM promotions WHERE run_id = ?').get(runId) as SqlRow | undefined
    return row ? promotionFromRow(row) : undefined
  }

  putCatalogManifest(manifest: CatalogManifest, digest?: string): CatalogManifestRecord {
    const computed = digest ?? digestJson(manifest)
    const existing = this.database.prepare(
      'SELECT * FROM catalog_manifests WHERE component_type = ? AND component_id = ? AND component_version = ?',
    ).get(manifest.component.type, manifest.component.id, manifest.component.version) as SqlRow | undefined
    if (existing) {
      const stored = catalogManifestFromRow(existing)
      if (stored.digest !== computed) {
        throw new Error(`catalog manifest ${stored.digest} is immutable and differs from ${computed}`)
      }
      return stored
    }
    const createdAt = this.#clock()
    this.database.prepare(`
      INSERT INTO catalog_manifests(digest, component_type, component_id, component_version, document_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(digest) DO NOTHING
    `).run(computed, manifest.component.type, manifest.component.id, manifest.component.version, canonicalJson(manifest), createdAt)
    const row = this.database.prepare('SELECT * FROM catalog_manifests WHERE digest = ?').get(computed) as SqlRow | undefined
    if (!row) throw new LedgerNotFoundError('catalog manifest', computed)
    return catalogManifestFromRow(row)
  }

  getCatalogManifest(digest: string): CatalogManifestRecord {
    const row = this.database.prepare('SELECT * FROM catalog_manifests WHERE digest = ?').get(digest) as SqlRow | undefined
    if (!row) throw new LedgerNotFoundError('catalog manifest', digest)
    return catalogManifestFromRow(row)
  }

  listCatalogManifests(): CatalogManifestRecord[] {
    return (this.database.prepare('SELECT * FROM catalog_manifests ORDER BY component_type, component_id, component_version').all() as SqlRow[])
      .map(catalogManifestFromRow)
  }

  createDraft(input: { draft: ArchitectureDraft; status?: DraftStatus }): ArchitectureDraftRecord {
    const status = input.status ?? 'DRAFT'
    const now = this.#clock()
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO architecture_drafts(draft_id, system_id, base_air_version, base_air_digest, title, status, document_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(draft_id) DO NOTHING
      `).run(input.draft.draftId, input.draft.systemId, input.draft.baseAirVersion, input.draft.baseAirDigest,
        input.draft.title, status, canonicalJson(input.draft), now, now)
      const record = this.getDraft(input.draft.draftId)
      this.appendDraftEvent(record.draftId, 'DRAFT_CREATED', { draftId: record.draftId, title: record.title, status: record.status })
      return record
    })
  }

  getDraft(draftId: string): ArchitectureDraftRecord {
    const row = this.database.prepare('SELECT * FROM architecture_drafts WHERE draft_id = ?').get(draftId) as SqlRow | undefined
    if (!row) throw new LedgerNotFoundError('architecture draft', draftId)
    return draftRecordFromRow(row)
  }

  listDrafts(systemId?: string): ArchitectureDraftRecord[] {
    const rows = systemId
      ? (this.database.prepare('SELECT * FROM architecture_drafts WHERE system_id = ? ORDER BY updated_at DESC').all(systemId) as SqlRow[])
      : (this.database.prepare('SELECT * FROM architecture_drafts ORDER BY updated_at DESC').all() as SqlRow[])
    return rows.map(draftRecordFromRow)
  }

  /** Replace the editable draft body. Locked or decided drafts are immutable. */
  updateDraftDocument(draftId: string, draft: ArchitectureDraft): ArchitectureDraftRecord {
    const current = this.getDraft(draftId)
    if (!DRAFT_MUTABLE_STATUSES.includes(current.status)) {
      throw new Error(`draft ${draftId} is ${current.status} and is immutable; create a new draft instead`)
    }
    if (draft.draftId !== draftId) throw new Error('draft id mismatch')
    const now = this.#clock()
    return this.transaction(() => {
      this.database.prepare(`
        UPDATE architecture_drafts SET system_id = ?, base_air_version = ?, base_air_digest = ?, title = ?,
          document_json = ?, updated_at = ?, status = 'DRAFT', compiled_air_digest = NULL
        WHERE draft_id = ?
      `).run(draft.systemId, draft.baseAirVersion, draft.baseAirDigest, draft.title, canonicalJson(draft), now, draftId)
      const record = this.getDraft(draftId)
      this.appendDraftEvent(draftId, 'DRAFT_UPDATED', { draftId, updatedAt: now })
      return record
    })
  }

  setDraftStatus(draftId: string, status: DraftStatus): ArchitectureDraftRecord {
    const current = this.getDraft(draftId)
    const allowed: Record<DraftStatus, DraftStatus[]> = {
      DRAFT: ['VALID', 'INVALID', 'LOCKED'], VALID: ['INVALID', 'LOCKED'],
      INVALID: ['VALID', 'LOCKED'], LOCKED: ['EXECUTED', 'REJECTED'], EXECUTED: [], REJECTED: [],
    }
    if (current.status === status) return current
    if (!allowed[current.status].includes(status)) throw new Error(`draft ${draftId} is immutable in ${current.status}; cannot transition to ${status}`)
    return this.transaction(() => {
      const result = this.database.prepare('UPDATE architecture_drafts SET status = ?, updated_at = ? WHERE draft_id = ?')
        .run(status, this.#clock(), draftId)
      if (Number(result.changes) !== 1) throw new LedgerNotFoundError('architecture draft', draftId)
      const record = this.getDraft(draftId)
      this.appendDraftEvent(draftId, 'DRAFT_STATUS_CHANGED', { draftId, status })
      return record
    })
  }

  setDraftCompiledDigest(draftId: string, compiledAirDigest: string): ArchitectureDraftRecord {
    const current = this.getDraft(draftId)
    // Compilation binds an editable draft's identity; only locked or decided
    // drafts refuse rebinding.
    if (!['DRAFT', 'INVALID', 'VALID'].includes(current.status)) {
      throw new Error(`draft ${draftId} is ${current.status}; its compilation is already bound`)
    }
    return this.transaction(() => {
      this.database.prepare('UPDATE architecture_drafts SET compiled_air_digest = ?, updated_at = ? WHERE draft_id = ?')
        .run(compiledAirDigest, this.#clock(), draftId)
      const record = this.getDraft(draftId)
      this.appendDraftEvent(draftId, 'DRAFT_COMPILED', { draftId, compiledAirDigest })
      return record
    })
  }

  appendDraftEvent(draftId: string, type: string, payload: unknown): DraftEventRecord {
    this.getDraft(draftId)
    const safePayload = redactSecrets(payload, { knownSecrets: this.#knownSecrets })
    const createdAt = this.#clock()
    this.database.prepare(`
      INSERT INTO draft_events(draft_id, type, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(draftId, type, canonicalJson(safePayload), createdAt)
    const row = this.database.prepare(
      'SELECT * FROM draft_events WHERE draft_id = ? ORDER BY sequence DESC LIMIT 1',
    ).get(draftId) as SqlRow | undefined
    if (!row) throw new LedgerNotFoundError('draft event', draftId)
    return draftEventFromRow(row)
  }

  listDraftEvents(draftId: string): DraftEventRecord[] {
    return (this.database.prepare('SELECT * FROM draft_events WHERE draft_id = ? ORDER BY sequence').all(draftId) as SqlRow[])
      .map(draftEventFromRow)
  }

  listRuns(): RunRecord[] {
    const rows=this.database.prepare('SELECT id FROM runs ORDER BY created_at DESC LIMIT 200').all() as Array<{id:string}>
    return rows.map(row=>this.getRun(row.id))
  }

  exportRun(runId: string): LedgerExport {
    const run = this.getRun(runId)
    const air = this.getAir(run.airDigest)
    const draft = {
      exportedAt: this.#clock(), air, run, tasks: this.listTasks(runId), events: this.listEvents(runId), effects: this.listEffects(runId),
      bindings: this.listBindings(runId), approvals: this.listApprovals(runId), promotion: this.getPromotion(runId),
    }
    const safeDraft = redactSecrets(draft, { knownSecrets: this.#knownSecrets })
    const withoutMissingPromotion = safeDraft.promotion ? safeDraft : Object.fromEntries(Object.entries(safeDraft).filter(([key]) => key !== 'promotion'))
    return { ...(withoutMissingPromotion as Omit<LedgerExport, 'manifestDigest'>), manifestDigest: digestJson(withoutMissingPromotion) }
  }

  exportRunJson(runId: string): string {
    return canonicalJson(this.exportRun(runId))
  }

  replayRun(runId: string): RunProjection {
    const projection: RunProjection = {
      runId, status: 'UNKNOWN', tasks: {}, approvals: {}, effects: {}, bindings: {}, lastSequence: 0,
    }
    for (const event of this.listEvents(runId)) {
      const payload = event.payload as Record<string, unknown>
      projection.lastSequence = event.sequence
      switch (event.type) {
        case 'RUN_CREATED': {
          projection.status = payload.status as RunStatus
          projection.airDigest = String(payload.airDigest)
          projection.sourceCommit = String(payload.sourceCommit)
          projection.traceId = String(payload.traceId)
          break
        }
        case 'RUN_STATUS_CHANGED':
          projection.status = payload.status as RunStatus
          break
        case 'RUN_SOURCE_COMMIT_CHANGED':
          projection.sourceCommit = String(payload.sourceCommit)
          break
        case 'TASK_UPSERTED': {
          const task = payload as unknown as TaskRecord
          projection.tasks[task.id] = { id: task.id, kind: task.kind, status: task.status, attempt: task.attempt, maxAttempts: task.maxAttempts }
          break
        }
        case 'TASK_STATUS_CHANGED': {
          const id = String(payload.taskId)
          const task = projection.tasks[id]
          if (task) projection.tasks[id] = { ...task, status: payload.status as TaskStatus, attempt: Number(payload.attempt) }
          break
        }
        case 'TASK_CLAIMED': {
          const id = String(payload.taskId)
          const task = projection.tasks[id]
          if (task) projection.tasks[id] = { ...task, status: 'CLAIMED' }
          break
        }
        case 'APPROVAL_REQUESTED':
        case 'APPROVAL_DECIDED': {
          const approval = payload as unknown as ApprovalRecord
          projection.approvals[approval.id] = approval.decision
          break
        }
        case 'EFFECT_COMMITTED': {
          const receipt = payload as unknown as EffectReceipt
          projection.effects[receipt.idempotencyKey] = receipt
          break
        }
        case 'BINDING_RECORDED': {
          const binding = payload as unknown as BindingLedgerRecord
          projection.bindings[binding.id] = binding
          break
        }
        case 'WORKFLOW_PROMOTED':
          projection.promotion = payload as unknown as PromotionRecord
          projection.status = 'PROMOTED'
          break
      }
    }
    return projection
  }
}

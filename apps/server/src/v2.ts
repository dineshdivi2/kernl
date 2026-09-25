import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  KernlLedger,
  airDigest,
  applyDraft,
  compileArchitecturePlan,
  parseCatalog,
  validateDraft,
  type AirDocument,
  type ArchitectureDraft,
  type ParsedCatalog,
} from '@kernl/core'
import { ArchitecturePlanExecutor, GitWorkspaceManager, loadPlanRunContext, providerStatus, knownProviderSecrets, assertNoProviderSecrets, type PlanRunContext } from '@kernl/runtime'

const draftOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('ADD'),
    componentId: z.string().min(1).max(128),
    catalogType: z.enum(['HTTP_API', 'WORKER', 'QUEUE', 'STORE', 'POLICY', 'FAILURE_SINK']),
    catalogId: z.string().min(1).max(128),
    catalogVersion: z.string().min(1).max(64),
  }).strict(),
  z.object({
    op: z.literal('UPGRADE'),
    componentId: z.string().min(1).max(128),
    catalogType: z.enum(['HTTP_API', 'WORKER', 'QUEUE', 'STORE', 'POLICY', 'FAILURE_SINK']),
    catalogVersion: z.string().min(1).max(64),
  }).strict(),
  z.object({ op: z.literal('REMOVE'), componentId: z.string().min(1).max(128) }).strict(),
  z.object({
    op: z.literal('REBIND'),
    componentId: z.string().min(1).max(128),
    requirementId: z.string().min(1).max(128),
    providerComponentId: z.string().min(1).max(128),
    providerCapabilityId: z.string().min(1).max(128).optional(),
  }).strict(),
])

const createDraftSchema = z.object({
  title: z.string().min(1).max(200),
  intent: z.string().min(1).max(2_000),
  baseAirVersion: z.string().min(1).max(64).optional(),
  baseAirDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  componentOps: z.array(draftOpSchema).default([]),
  contractChanges: z.array(z.any()).default([]),
  requestedVerification: z.object({ gates: z.array(z.string().min(1)).min(1) }).strict(),
  expectedFailure: z.object({
    fingerprint: z.string().min(1),
    repairStepId: z.string().min(1),
    repairScope: z.array(z.string().min(1)).min(1),
  }).strict().optional(),
  changeNotes: z.string().max(4_000).default(''),
  requestedBy: z.string().min(1).max(128),
}).strict()

const updateDraftSchema = createDraftSchema

const decisionSchema = z.object({
  actor: z.string().min(1).max(128),
  role: z.string().min(1).max(128),
  reason: z.string().max(2_000).optional(),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()

function loadCatalog(root: string): ParsedCatalog {
  return parseCatalog(JSON.parse(readFileSync(join(root, 'fixtures', 'catalog', 'kernl-local-catalog.json'), 'utf8')) as unknown)
}

const catalogCache = new Map<string, ParsedCatalog>()

/** Lazy per-root load: environments without the local catalog simply never use v2 routes. */
function getCatalog(root: string): ParsedCatalog {
  const key = resolve(root)
  let parsed = catalogCache.get(key)
  if (!parsed) {
    parsed = loadCatalog(key)
    catalogCache.set(key, parsed)
  }
  return parsed
}

function openLedger(root: string): KernlLedger {
  mkdirSync(join(root, 'data'), { recursive: true })
  const databasePath = process.env.KERNL_DB ?? join(root, 'data', 'kernl.sqlite')
  return new KernlLedger(databasePath, {knownSecrets:knownProviderSecrets()})
}

const loadAirSchema = z.object({ path: z.string().regex(/^air\/[A-Za-z0-9._-]+\.json$/) }).strict()

interface RouteContext {
  req: {
    json(): Promise<unknown>
    param(name: string): string
  }
}

function latestAir(ledger: KernlLedger, systemId: string): { digest: string; document: AirDocument } | undefined {
  // Only sealed promotions advance design truth; merely compiling never does.
  const promoted = ledger.database.prepare(
    'SELECT p.air_digest AS digest FROM promotions p JOIN air_versions a ON a.digest = p.air_digest JOIN runs r ON r.id = p.run_id WHERE a.system_id = ? AND r.status = ? ORDER BY p.created_at DESC, p.rowid DESC LIMIT 1',
  ).get(systemId, 'PROMOTED') as { digest: string } | undefined
  if (promoted) {
    const stored = ledger.getAir(promoted.digest)
    return { digest: stored.digest, document: stored.document }
  }
  const row = ledger.database.prepare(
    "SELECT digest FROM air_versions WHERE system_id = ? AND air_version NOT LIKE 'air-draft-%' ORDER BY created_at DESC, digest DESC LIMIT 1",
  ).get(systemId) as { digest?: string } | undefined
  if (!row?.digest) return undefined
  const stored = ledger.getAir(row.digest)
  return { digest: stored.digest, document: stored.document }
}

function airByVersion(ledger: KernlLedger, systemId: string, version: string): { digest: string; document: AirDocument } | undefined {
  const row = ledger.database.prepare(
    'SELECT digest FROM air_versions WHERE system_id = ? AND air_version = ? ORDER BY created_at DESC LIMIT 1',
  ).get(systemId, version) as { digest?: string } | undefined
  if (!row?.digest) return undefined
  const stored = ledger.getAir(row.digest)
  return { digest: stored.digest, document: stored.document }
}

function httpError(error: unknown): { status: 400 | 404 | 409 | 500; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('was not found')) return { status: 404, message }
  if (message.includes('immutable') || message.includes('already')) return { status: 409, message }
  if (error instanceof z.ZodError) return { status: 400, message: JSON.stringify(error.issues) }
  return { status: 500, message }
}

/**
 * Alpha V2 control-plane routes: persisted drafts over immutable AIR
 * versions, deterministic compilation, plan execution, and evidence-bound
 * approval or rejection. SQLite stays the only authority; the browser never
 * holds draft state.
 */
export function registerV2Routes(app: Hono, root: string): void {
  attachV2Routes(app, resolve(root))
}

/** Standalone API instance for tests and embedding. */
export function createV2App(root: string): Hono {
  const api = new Hono()
  attachV2Routes(api, resolve(root))
  return api
}

function attachV2Routes(app: Hono, projectRoot: string): void {

  const route = <T>(handler: (c: RouteContext) => Promise<T>) => async (c: Context) => {
    try {
      return c.json({ ok: true, value: await handler(c as unknown as RouteContext) })
    } catch (error) {
      const { status, message } = httpError(error)
      return c.json({ ok: false, error: message }, status)
    }
  }

  app.get('/api/v2/providers', route(async () => providerStatus()))
  app.get('/api/v2/runs', route(async () => {
    const ledger = openLedger(projectRoot)
    try { return ledger.listRuns().filter(run=>ledger.listEvents(run.id).some(event=>event.type==='RUN_INPUTS_FROZEN')) }
    finally { ledger.close() }
  }))
  app.post('/api/v2/bootstrap', route(async () => {
    const ledger=openLedger(projectRoot)
    try {
      const seed=ledger.putAir(JSON.parse(readFileSync(join(projectRoot,'fixtures','air','before.json'),'utf8')))
      const before=latestAir(ledger,seed.document.system.id)??seed
      const promotion=ledger.database.prepare('SELECT run_id AS runId, source_commit AS sourceCommit FROM promotions WHERE air_digest = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(before.digest)
      const blank={title:'New architecture change',intent:'Describe the intended behavior and select explicit component changes.',baseAirDigest:before.digest,requestedBy:'solution-architect',changeNotes:'',componentOps:[],contractChanges:[],requestedVerification:{gates:['build']}}
      const queue={
        title:'Move job execution to a queue',intent:'Keep the public API and result behavior while decoupling the API from the worker.',
        baseAirDigest:before.digest,requestedBy:'solution-architect',changeNotes:'',
        componentOps:[{op:'ADD',componentId:'queue',catalogType:'QUEUE',catalogId:'queue',catalogVersion:'1.0.0'},
          {op:'UPGRADE',componentId:'api',catalogType:'HTTP_API',catalogVersion:'2.0.0'},
          {op:'UPGRADE',componentId:'worker',catalogType:'WORKER',catalogVersion:'1.5.0'}],
        contractChanges:[{op:'REMOVE',contractId:'sync-job-v1'}],requestedVerification:{gates:['build','unit','contract','idempotency']},
        expectedFailure:{fingerprint:'duplicate-event-effect',repairStepId:'modify:worker',repairScope:['src/worker.ts']},
      }
      const retry={...blank,title:'Add bounded retry and dead-letter handling',intent:'Retry failed jobs within a fixed budget and retain exhausted jobs for inspection.',componentOps:[
        {op:'UPGRADE',componentId:'queue',catalogType:'QUEUE',catalogVersion:'2.0.0'},
        {op:'UPGRADE',componentId:'worker',catalogType:'WORKER',catalogVersion:'2.0.0'},
        {op:'ADD',componentId:'retry',catalogType:'POLICY',catalogId:'retry-policy',catalogVersion:'1.0.0'},
        {op:'ADD',componentId:'dead-letter',catalogType:'FAILURE_SINK',catalogId:'dead-letter',catalogVersion:'1.0.0'},
      ],requestedVerification:{gates:['build','unit','idempotency','retry-contract','dlq-contract']}}
      const proposals=[queue,retry].filter(input=>validateDraft({...input,schemaVersion:'1.0',draftId:'proposal',systemId:before.document.system.id,baseAirVersion:before.document.airVersion,createdAt:'proposal',updatedAt:'proposal'} as ArchitectureDraft,before.document,getCatalog(projectRoot)).valid)
      return {baseline:before.document,baselineDigest:before.digest,promotion:promotion??null,starter:blank,proposals}
    } finally {ledger.close()}
  }))
  app.post('/api/v2/runs/:id/resume',route(async c=> {
    const ledger=openLedger(projectRoot)
    try {return await new ArchitecturePlanExecutor(projectRoot,ledger).run(loadPlanRunContext(ledger,c.req.param('id')))}
    finally {ledger.close()}
  }))
  app.get('/api/v2/runs/:id/evidence',route(async c=> {
    const ledger=openLedger(projectRoot)
    try {
      const runId=c.req.param('id'); ledger.getRun(runId)
      const dir=join(projectRoot,'artifacts','runs',runId)
      return {core:JSON.parse(readFileSync(join(dir,'evidence-core.json'),'utf8')),diff:readFileSync(join(dir,'candidate.patch'),'utf8'),projection:ledger.replayRun(runId)}
    } finally {ledger.close()}
  }))

  app.get('/api/v2/catalog', route(async () => {
    return {
      digest: getCatalog(projectRoot).digest,
      manifests: [...getCatalog(projectRoot).byTypeVersion.values()].map(manifest => ({
        type: manifest.component.type,
        id: manifest.component.id,
        version: manifest.component.version,
        description: manifest.component.description,
        template: manifest.generation.template,
        gates: manifest.verification.gates.map(gate => gate.id),
      })),
    }
  }))

  app.post('/api/v2/catalog/load', route(async () => {
    const ledger = openLedger(projectRoot)
    try {
      let count = 0
      for (const manifest of getCatalog(projectRoot).catalog.manifests) {
        ledger.putCatalogManifest(manifest)
        count += 1
      }
      return { loaded: count, digest: getCatalog(projectRoot).digest }
    } finally {
      ledger.close()
    }
  }))

  app.post('/api/v2/air/load', route(async (c) => {
    const input = loadAirSchema.parse(await c.req.json())
    const ledger = openLedger(projectRoot)
    try {
      const document = JSON.parse(readFileSync(join(projectRoot, 'fixtures', input.path), 'utf8')) as AirDocument
      const stored = ledger.putAir(document)
      return { airVersion: stored.airVersion, digest: stored.digest, systemId: stored.systemId }
    } finally {
      ledger.close()
    }
  }))

  app.post('/api/v2/drafts', route(async (c) => {
    const input = createDraftSchema.parse(await c.req.json())
    assertNoProviderSecrets(JSON.stringify(input))
    const ledger = openLedger(projectRoot)
    try {
      const systemId = 'jobs-system'
      const base = input.baseAirDigest
        ? (() => { const stored = ledger.getAir(input.baseAirDigest); return { digest: stored.digest, document: stored.document } })()
        : input.baseAirVersion
          ? airByVersion(ledger, systemId, input.baseAirVersion)
          : latestAir(ledger, systemId)
      if (!base) throw new Error('no AIR version exists for the system; load a baseline first')
      const now = new Date().toISOString()
      const draft: ArchitectureDraft = {
        schemaVersion: '1.0',
        draftId: `draft-${randomUUID().slice(0, 8)}`,
        systemId,
        title: input.title,
        intent: input.intent,
        baseAirVersion: base.document.airVersion,
        baseAirDigest: base.digest,
        componentOps: input.componentOps,
        contractChanges: input.contractChanges as ArchitectureDraft['contractChanges'],
        requestedVerification: input.requestedVerification,
        ...(input.expectedFailure ? { expectedFailure: input.expectedFailure } : {}),
        changeNotes: input.changeNotes,
        requestedBy: input.requestedBy,
        createdAt: now,
        updatedAt: now,
      }
      const record = ledger.createDraft({ draft })
      return { draftId: record.draftId, status: record.status, baseAirVersion: record.baseAirVersion }
    } finally {
      ledger.close()
    }
  }))

  app.get('/api/v2/drafts', route(async () => {
    const ledger = openLedger(projectRoot)
    try {
      return {
        drafts: ledger.listDrafts().map(record => ({
          draftId: record.draftId,
          title: record.title,
          status: record.status,
          baseAirVersion: record.baseAirVersion,
          compiledAirDigest: record.compiledAirDigest ?? null,
          updatedAt: record.updatedAt,
        })),
      }
    } finally {
      ledger.close()
    }
  }))

  app.get('/api/v2/drafts/:id', route(async (c) => {
    const ledger = openLedger(projectRoot)
    try {
      const record = ledger.getDraft(c.req.param('id'))
      return { ...record, baseline: ledger.getAir(record.baseAirDigest).document }
    } finally {
      ledger.close()
    }
  }))

  app.put('/api/v2/drafts/:id', route(async (c) => {
    const input = updateDraftSchema.parse(await c.req.json())
    assertNoProviderSecrets(JSON.stringify(input))
    const ledger = openLedger(projectRoot)
    try {
      const current = ledger.getDraft(c.req.param('id'))
      const base = input.baseAirDigest
        ? (() => { const stored = ledger.getAir(input.baseAirDigest); return { digest: stored.digest, document: stored.document } })()
        : input.baseAirVersion
          ? airByVersion(ledger, current.systemId, input.baseAirVersion)
          : { digest: current.baseAirDigest, document: ledger.getAir(current.baseAirDigest).document }
      if (!base) throw new Error('base AIR version was not found')
      const { expectedFailure: _stale, ...rest } = current.draft
      const next: ArchitectureDraft = {
        ...rest,
        title: input.title,
        intent: input.intent,
        baseAirVersion: base.document.airVersion,
        baseAirDigest: base.digest,
        componentOps: input.componentOps,
        contractChanges: input.contractChanges as ArchitectureDraft['contractChanges'],
        requestedVerification: input.requestedVerification,
        ...(input.expectedFailure ? { expectedFailure: input.expectedFailure } : {}),
        changeNotes: input.changeNotes,
        requestedBy: input.requestedBy,
        updatedAt: new Date().toISOString(),
      }
      const updatedRecord = ledger.updateDraftDocument(current.draftId, next)
      return { draftId: updatedRecord.draftId, title: updatedRecord.title, status: updatedRecord.status, updatedAt: updatedRecord.updatedAt }
    } finally {
      ledger.close()
    }
  }))

  app.post('/api/v2/drafts/:id/validate', route(async (c) => {
    const ledger = openLedger(projectRoot)
    try {
      const record = ledger.getDraft(c.req.param('id'))
      const base = ledger.getAir(record.baseAirDigest).document
      const result = validateDraft(record.draft, base, getCatalog(projectRoot))
      ledger.setDraftStatus(record.draftId, result.valid ? 'VALID' : 'INVALID')
      return { valid: result.valid, issues: result.issues, affectedComponentIds: result.affectedComponentIds }
    } finally {
      ledger.close()
    }
  }))

  app.post('/api/v2/drafts/:id/compile', route(async (c) => {
    const ledger = openLedger(projectRoot)
    try {
      const record = ledger.getDraft(c.req.param('id'))
      const base = ledger.getAir(record.baseAirDigest).document
      const compiled = applyDraft(record.draft, base, getCatalog(projectRoot))
      const stored = ledger.putAir(compiled.after)
      ledger.setDraftCompiledDigest(record.draftId, stored.digest)
      return {
        airVersion: compiled.after.airVersion,
        airDigest: stored.digest,
        affectedComponentIds: compiled.diff.directlyAffectedComponentIds,
        changedFieldsByComponent: compiled.diff.reasons,
        before:base, after:compiled.after,
        plan:compileArchitecturePlan(base,compiled.after,{catalog:getCatalog(projectRoot),expectedInitialFailure:record.draft.expectedFailure}),
      }
    } finally {
      ledger.close()
    }
  }))

  app.post('/api/v2/drafts/:id/run', route(async (c) => {
    const options=z.object({background:z.boolean().optional(),agent:z.object({provider:z.enum(['deepseek','openrouter','nous']),model:z.string().regex(/^[A-Za-z0-9_.:/-]{1,160}$/),maximumRequests:z.number().int().min(1).max(10).default(6),maximumOutputTokens:z.number().int().min(128).max(4096).default(3072)}).strict().optional()}).strict().parse(await c.req.json().catch(()=>({})))
    const ledger = openLedger(projectRoot)
    let background=false
    const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
    try {
      const record = ledger.getDraft(c.req.param('id'))
      if (!record.compiledAirDigest) throw new Error('draft must be compiled before execution')
      if (!['DRAFT','VALID','INVALID'].includes(record.status)) throw new Error('draft is immutable after execution begins')
      const before = ledger.getAir(record.baseAirDigest).document
      const after = ledger.getAir(record.compiledAirDigest).document
      const plan = compileArchitecturePlan(before, after, {
        catalog: getCatalog(projectRoot),
        expectedInitialFailure: record.draft.expectedFailure,
        planId: `plan:${record.draftId}:${after.airVersion}`,
      })
      // Non-baseline runs require an actual previously promoted source workspace.
      let fixtureDir=join(projectRoot,'fixtures','job-system-template')
      {
        const baseline=JSON.parse(readFileSync(join(projectRoot,'fixtures','air','before.json'),'utf8')) as AirDocument
        if (airDigest(before)!==airDigest(baseline)) {
          const previous=ledger.listRuns().find(run=>run.airDigest===airDigest(before) && run.status==='PROMOTED')
          if (!previous) throw new Error('non-baseline AIR needs a promoted source workspace; an AIR-only file is not implementation truth')
          fixtureDir=join(new GitWorkspaceManager(projectRoot).runRepositoryPath(previous.id),'integration')
          if (await new GitWorkspaceManager(projectRoot).currentCommit(fixtureDir)!==previous.sourceCommit) throw new Error('promoted baseline commit changed')
        }
      }
      ledger.setDraftStatus(record.draftId, 'LOCKED')
      ledger.createRun({ id: runId, airDigest: airDigest(after), sourceCommit: 'PENDING_WORKSPACE', status: 'PLANNING' })
      ledger.appendEvent(runId, 'RUN_DRAFT_BOUND', { draftId: record.draftId, planDigest: plan.digest })
      const context:PlanRunContext={runId,plan,fromAir:before,toAir:after,catalog:getCatalog(projectRoot),fixtureDir,...(options.agent?{agent:options.agent}:{})}
      ledger.freezeRunInputs(runId,{...context,catalog:context.catalog.catalog})
      if (options.background) {
        background=true
        void new ArchitecturePlanExecutor(projectRoot,ledger).run(context).catch(error=>{ledger.appendEvent(runId,'DISPATCH_FAILED',{message:error instanceof Error?error.message:'dispatch failed'});ledger.setRunStatus(runId,'FAILED')}).finally(()=>ledger.close())
        return {runId,planDigest:plan.digest,outcome:{runId,status:'RUNNING'}}
      }
      const outcome=await new ArchitecturePlanExecutor(projectRoot,ledger).run(context)
      return { runId, planDigest: plan.digest, outcome }
    } finally {
      if (!background) ledger.close()
    }
  }))

  app.post('/api/v2/runs/:id/approve', route(async (c) => {
    const input = decisionSchema.parse(await c.req.json())
    const ledger = openLedger(projectRoot)
    try {
      const runId = c.req.param('id')
      const run = ledger.getRun(runId)
      if (run.status !== 'AWAITING_APPROVAL') throw new Error(`run ${runId} is ${run.status}, not awaiting approval`)
      const events = ledger.listEvents(runId)
      const bound = events.find(event => event.type === 'RUN_DRAFT_BOUND')
      const draftId = bound ? String((bound.payload as { draftId: string }).draftId) : undefined
      const draftRecord = draftId ? ledger.getDraft(draftId) : undefined
      const toAir = ledger.getAir(run.airDigest).document
      const gate = toAir.approvalGates.find(candidate => candidate.when === 'BEFORE_PROMOTION')
      if (!gate) throw new Error('AIR declares no BEFORE_PROMOTION gate')
      if (input.role !== gate.requiredRole) throw new Error(`role ${input.role} cannot satisfy required role ${gate.requiredRole}`)
      const pending = ledger.listApprovals(runId).find(approval => approval.decision === 'PENDING' && approval.gateId === gate.id)
      if (!pending) throw new Error('no pending approval for the promotion gate')
      const evidenceReady = [...events].reverse().find(event => event.type === 'EVIDENCE_READY')
      const evidenceCoreDigest = String((evidenceReady?.payload as { evidenceCoreDigest?: string }).evidenceCoreDigest ?? '')
      if (!evidenceCoreDigest) throw new Error('run has no evidence core to approve')
      if (input.evidenceDigest && input.evidenceDigest!==evidenceCoreDigest) throw new Error('approval evidence digest is stale')
      ledger.decideApproval({ runId, approvalId: pending.id, decision: 'APPROVED', actor: input.actor, evidenceDigest: evidenceCoreDigest })
      ledger.appendEvent(runId, 'APPROVAL_DECISION_RECORDED', { decision: 'APPROVED', actor: input.actor, role: input.role, evidenceCoreDigest })
      const outcome = await new ArchitecturePlanExecutor(projectRoot, ledger).run(loadPlanRunContext(ledger,runId))
      if (draftRecord && outcome.status==='PROMOTED') ledger.setDraftStatus(draftRecord.draftId, 'EXECUTED')
      const promotion = ledger.getPromotion(runId)
      return {
        runId,
        outcome,
        promotion: promotion ? { workflowDigest: promotion.workflowDigest, candidateCommit: promotion.sourceCommit } : null,
      }
    } finally {
      ledger.close()
    }
  }))

  app.post('/api/v2/runs/:id/reject', route(async (c) => {
    const input = decisionSchema.parse(await c.req.json())
    if (!input.reason?.trim()) throw new Error('a rejection reason is required')
    const ledger = openLedger(projectRoot)
    try {
      const runId = c.req.param('id')
      const run = ledger.getRun(runId)
      if (run.status !== 'AWAITING_APPROVAL') throw new Error(`run ${runId} is ${run.status}, not awaiting approval`)
      const toAir = ledger.getAir(run.airDigest).document
      const gate = toAir.approvalGates.find(candidate => candidate.when === 'BEFORE_PROMOTION')
      if (!gate) throw new Error('AIR declares no BEFORE_PROMOTION gate')
      if (input.role !== gate.requiredRole) throw new Error(`role ${input.role} cannot satisfy required role ${gate.requiredRole}`)
      const pending = ledger.listApprovals(runId).find(approval => approval.decision === 'PENDING' && approval.gateId === gate.id)
      if (!pending) throw new Error('no pending approval for the promotion gate')
      const evidenceReady = [...ledger.listEvents(runId)].reverse().find(event => event.type === 'EVIDENCE_READY')
      const evidenceCoreDigest = String((evidenceReady?.payload as { evidenceCoreDigest?: string }).evidenceCoreDigest ?? '')
      ledger.decideApproval({ runId, approvalId: pending.id, decision: 'REJECTED', actor: input.actor, evidenceDigest: evidenceCoreDigest })
      ledger.appendEvent(runId, 'APPROVAL_REJECTED', { reason: input.reason, actor: input.actor, role: input.role })
      ledger.setRunStatus(runId, 'CANCELLED')
      const bound = ledger.listEvents(runId).find(event => event.type === 'RUN_DRAFT_BOUND')
      const draftId = bound ? String((bound.payload as { draftId: string }).draftId) : undefined
      if (draftId) ledger.setDraftStatus(draftId, 'REJECTED')
      return { runId, status: 'REJECTED', reason: input.reason, note: 'the verified candidate remains inspectable; create a new draft to continue' }
    } finally {
      ledger.close()
    }
  }))

  app.get('/api/v2/runs/:id', route(async (c) => {
    const ledger = openLedger(projectRoot)
    try {
      const runId = c.req.param('id')
      const exported = ledger.exportRun(runId)
      return {
        run: exported.run,
        tasks: exported.tasks,
        approvals: exported.approvals,
        promotion: exported.promotion ?? null,
        events: exported.events,
        effects:exported.effects,
        context:loadPlanRunContext(ledger,runId),
      }
    } finally {
      ledger.close()
    }
  }))
}

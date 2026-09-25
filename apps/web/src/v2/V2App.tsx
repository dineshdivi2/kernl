import { useCallback, useEffect, useState } from 'react'

/* ------------------------------------------------------------------ */
/* Typed client for the Alpha V2 control-plane API                    */
/* ------------------------------------------------------------------ */

type Json = Record<string, unknown>

interface Envelope<T> { ok: boolean; value?: T; error?: string }

async function call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const envelope = await response.json() as Envelope<T>
  if (!envelope.ok || envelope.value === undefined) throw new Error(envelope.error ?? `request failed (${response.status})`)
  return envelope.value
}

interface CatalogEntry { type: string; id: string; version: string; description: string; template: string; gates: string[] }
interface CatalogInfo { digest: string; manifests: CatalogEntry[] }
interface DraftSummary { draftId: string; title: string; status: string; baseAirVersion: string; compiledAirDigest: string | null; updatedAt: string }
interface DraftRecord extends DraftSummary {
  draft: Json
  systemId: string
  baseAirDigest: string
  createdAt: string
}
interface CompileInfo { airVersion: string; airDigest: string; affectedComponentIds: string[]; changedFieldsByComponent: Record<string, string[]> }
interface TaskSummary { id: string; kind: string; status: string; attempt: number; maxAttempts: number }
interface RunEvent { sequence: number; type: string; taskId?: string; createdAt: string; payload: Json }
interface RunInspection {
  run: { id: string; status: string; sourceCommit: string }
  tasks: TaskSummary[]
  approvals: Array<{ id: string; decision: string; actor?: string }>
  promotion: { workflowDigest: string; sourceCommit: string } | null
  events: RunEvent[]
}
interface RunOutcome {
  status: string
  runId: string
  completedStepIds: string[]
  repairAttemptsUsed: number
  verificationAttempts: number
  error?: string
}

/* ------------------------------------------------------------------ */
/* View shell                                                          */
/* ------------------------------------------------------------------ */

const VIEWS = ['System overview', 'Drafts', 'Change review', 'Execution', 'Verification', 'Approval', 'Evidence & replay'] as const
type ViewName = typeof VIEWS[number]

export function V2App() {
  const [view, setView] = useState<ViewName>('System overview')
  const [catalog, setCatalog] = useState<CatalogInfo | null>(null)
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const [selectedDraft, setSelectedDraft] = useState<DraftRecord | null>(null)
  const [compiled, setCompiled] = useState<CompileInfo | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [runDetail, setRunDetail] = useState<RunInspection | null>(null)
  const [outcome, setOutcome] = useState<RunOutcome | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const guard = useCallback(async (label: string, action: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    setNotice(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }, [])

  const refreshDrafts = useCallback(async () => {
    const value = await call<{ drafts: DraftSummary[] }>('GET', '/api/v2/drafts')
    setDrafts(value.drafts)
  }, [])

  const refreshRun = useCallback(async (id: string) => {
    const value = await call<RunInspection>('GET', `/api/v2/runs/${id}`)
    setRunDetail(value)
  }, [])

  useEffect(() => {
    void guard('catalog', async () => {
      try {
        setCatalog(await call<CatalogInfo>('GET', '/api/v2/catalog'))
      } catch {
        setCatalog(null)
      }
      await refreshDrafts()
    })
  }, [guard, refreshDrafts])

  const selectDraft = (id: string) => void guard('select', async () => {
    const record = await call<DraftRecord>('GET', `/api/v2/drafts/${id}`)
    setSelectedDraft(record)
    setCompiled(null)
    setOutcome(null)
    setView('Change review')
  })

  const validateDraft = (id: string) => void guard('validate', async () => {
    const value = await call<{ valid: boolean; issues: Array<{ code: string; message: string }> }>('POST', `/api/v2/drafts/${id}/validate`)
    setNotice(value.valid
      ? 'Validation passed: bindings, contracts, and catalog rules accept this draft.'
      : `Validation rejected the draft: ${value.issues.map(issue => issue.code).join(', ')}`)
    const record = await call<DraftRecord>('GET', `/api/v2/drafts/${id}`)
    setSelectedDraft(record)
    await refreshDrafts()
    if (value.valid) setView('Change review')
  })

  const compileDraft = (id: string) => void guard('compile', async () => {
    const value = await call<CompileInfo>('POST', `/api/v2/drafts/${id}/compile`)
    setCompiled(value)
    setNotice(`Compiled immutable AIR version ${value.airVersion}; ${value.affectedComponentIds.length} components directly affected.`)
    await refreshDrafts()
    setView('Change review')
  })

  const runDraft = (id: string) => void guard('run', async () => {
    const value = await call<{ runId: string; outcome: RunOutcome }>('POST', `/api/v2/drafts/${id}/run`)
    setRunId(value.runId)
    setOutcome(value.outcome)
    await refreshRun(value.runId)
    await refreshDrafts()
    setView(value.outcome.status === 'AWAITING_APPROVAL' ? 'Approval' : 'Execution')
  })

  const approve = () => void guard('approve', async () => {
    if (!runId) throw new Error('no suspended run selected')
    const actorInput = (document.getElementById('approval-actor') as HTMLInputElement | null)?.value ?? ''
    const value = await call<{ outcome: RunOutcome; promotion: { workflowDigest: string } | null }>('POST', `/api/v2/runs/${runId}/approve`, { actor: actorInput || 'local-architect', role: 'architect' })
    setOutcome(value.outcome)
    await refreshRun(runId)
    setNotice(value.promotion ? `Promoted workflow ${value.promotion.workflowDigest.slice(0, 16)}…` : 'Approval recorded; promotion pending.')
    setView('Evidence & replay')
  })

  const reject = () => void guard('reject', async () => {
    if (!runId) throw new Error('no suspended run selected')
    const actorInput = (document.getElementById('approval-actor') as HTMLInputElement | null)?.value ?? ''
    const reasonInput = (document.getElementById('approval-reason') as HTMLInputElement | null)?.value ?? ''
    const value = await call<{ status: string }>('POST', `/api/v2/runs/${runId}/reject`, { actor: actorInput || 'local-architect', role: 'architect', reason: reasonInput || 'rejected from the control plane' })
    setNotice(`Rejection recorded (${value.status}); the verified candidate stays inspectable.`)
    await refreshRun(runId)
    await refreshDrafts()
  })

  const verificationReports = (runDetail?.events ?? [])
    .filter(event => event.type === 'VERIFICATION_FINISHED')
    .map(event => event.payload as unknown as ReportShape)

  return (
    <div className="v2">
      <header className="v2-header">
        <div>
          <h1>Kernl architecture control plane</h1>
          <p className="v2-sub">Draft architecture changes, compile them to immutable AIR versions, execute bounded agents, and promote only on evidence.</p>
        </div>
        {busy && <span className="v2-busy" role="status">Working: {busy}…</span>}
      </header>
      <nav className="v2-tabs" aria-label="Control-plane views">
        {VIEWS.map(name => (
          <button key={name} className={name === view ? 'v2-tab v2-tab--active' : 'v2-tab'} onClick={() => setView(name)} type="button">{name}</button>
        ))}
      </nav>
      {error && <p className="v2-error" role="alert">{error}</p>}
      {notice && <p className="v2-notice" role="status">{notice}</p>}

      {view === 'System overview' && (
        <Overview catalog={catalog} drafts={drafts} runDetail={runDetail} outcome={outcome} />
      )}
      {view === 'Drafts' && (
        <Drafts drafts={drafts} selectedId={selectedDraft?.draftId ?? null} onSelect={selectDraft} onValidate={validateDraft} onCompile={compileDraft} onRun={runDraft} />
      )}
      {view === 'Change review' && (
        <ChangeReview selected={selectedDraft} compiled={compiled} />
      )}
      {view === 'Execution' && (
        <Execution runDetail={runDetail} outcome={outcome} runId={runId} />
      )}
      {view === 'Verification' && (
        <Verification reports={verificationReports} runDetail={runDetail} />
      )}
      {view === 'Approval' && (
        <Approval runDetail={runDetail} onApprove={approve} onReject={reject} />
      )}
      {view === 'Evidence & replay' && (
        <Evidence runDetail={runDetail} outcome={outcome} runId={runId} />
      )}
    </div>
  )
}

interface ReportShape {
  attempt: number
  status: string
  gates: Array<{ name: string; status: string; summary?: string; failureFingerprint?: string; repairScope?: string[]; durationMs?: number }>
  digest?: string
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

function Overview({ catalog, drafts, runDetail, outcome }: { catalog: CatalogInfo | null; drafts: DraftSummary[]; runDetail: RunInspection | null; outcome: RunOutcome | null }) {
  return (
    <section className="v2-grid">
      <Panel title="Component catalog" hint={catalog ? `catalog digest ${catalog.digest.slice(0, 16)}…` : 'catalog not loaded'}>
        {catalog ? (
          <table className="v2-table">
            <thead><tr><th>Type</th><th>Component</th><th>Version</th><th>Recipe</th><th>Gates</th></tr></thead>
            <tbody>
              {catalog.manifests.map(entry => (
                <tr key={`${entry.type}:${entry.id}@${entry.version}`}>
                  <td>{entry.type}</td><td>{entry.id}</td><td>{entry.version}</td>
                  <td><code>{entry.template}</code></td>
                  <td>{entry.gates.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="v2-empty">Load the catalog with <code>POST /api/v2/catalog/load</code> to begin.</p>}
      </Panel>
      <Panel title="Active changes" hint={`${drafts.length} draft(s)`}>
        <ul className="v2-list">
          {drafts.slice(0, 8).map(draft => (
            <li key={draft.draftId}><strong>{draft.title}</strong> — <span className={`v2-status v2-status--${draft.status.toLowerCase()}`}>{draft.status}</span> <small>{draft.baseAirVersion}</small></li>
          ))}
          {drafts.length === 0 && <li className="v2-empty">No drafts yet.</li>}
        </ul>
      </Panel>
      <Panel title="Run health" hint={runDetail ? runDetail.run.id : 'no run selected'}>
        {runDetail ? (
          <>
            <p>Run status: <strong>{runDetail.run.status}</strong></p>
            <p>Tasks succeeded: <strong>{runDetail.tasks.filter(task => task.status === 'SUCCEEDED').length}/{runDetail.tasks.length}</strong></p>
            {outcome && <p>Repairs used: <strong>{outcome.repairAttemptsUsed}</strong> · Verification attempts: <strong>{outcome.verificationAttempts}</strong></p>}
            {runDetail.promotion && <p>Promotion: <code>{runDetail.promotion.workflowDigest.slice(0, 24)}…</code></p>}
          </>
        ) : <p className="v2-empty">Execute a compiled draft to see live run health.</p>}
      </Panel>
    </section>
  )
}

function Drafts({ drafts, selectedId, onSelect, onValidate, onCompile, onRun }: {
  drafts: DraftSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  onValidate: (id: string) => void
  onCompile: (id: string) => void
  onRun: (id: string) => void
}) {
  return (
    <section>
      <Panel title="Architecture-change drafts" hint="persisted in SQLite; the browser holds no draft state">
        <table className="v2-table">
          <thead><tr><th>Draft</th><th>Title</th><th>Base AIR</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {drafts.map(draft => (
              <tr key={draft.draftId} className={draft.draftId === selectedId ? 'v2-row--selected' : ''}>
                <td><code>{draft.draftId}</code></td>
                <td>{draft.title}</td>
                <td>{draft.baseAirVersion}</td>
                <td><span className={`v2-status v2-status--${draft.status.toLowerCase()}`}>{draft.status}</span></td>
                <td className="v2-actions">
                  <button type="button" onClick={() => onSelect(draft.draftId)}>Inspect</button>
                  <button type="button" onClick={() => onValidate(draft.draftId)}>Validate</button>
                  <button type="button" onClick={() => onCompile(draft.draftId)}>Compile</button>
                  {draft.compiledAirDigest && <button type="button" onClick={() => onRun(draft.draftId)}>Execute plan</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {drafts.length === 0 && <p className="v2-empty">Create a draft via <code>POST /api/v2/drafts</code> (the alpha keeps authoring API-first; the editor form is the next increment).</p>}
      </Panel>
    </section>
  )
}

function ChangeReview({ selected, compiled }: { selected: DraftRecord | null; compiled: CompileInfo | null }) {
  if (!selected) return <Panel title="Change review"><p className="v2-empty">Select a draft to review its semantic change.</p></Panel>
  const ops = (selected.draft.componentOps as Array<Json>) ?? []
  return (
    <section className="v2-grid">
      <Panel title="Draft intent" hint={selected.baseAirVersion}>
        <p><strong>{selected.title}</strong></p>
        <p>{String(selected.draft.intent ?? '')}</p>
        <p className="v2-hint">Status: <span className={`v2-status v2-status--${selected.status.toLowerCase()}`}>{selected.status}</span></p>
      </Panel>
      <Panel title="Component operations" hint={`${ops.length} op(s)`}>
        <ul className="v2-list">
          {ops.map((op, index) => (
            <li key={index}><code>{String(op.op)}</code> → {String(op.componentId)}{op.catalogVersion ? ` @ ${String(op.catalogVersion)}` : ''}</li>
          ))}
        </ul>
      </Panel>
      <Panel title="Compiled result" hint={compiled ? compiled.airVersion : (selected.compiledAirDigest ? 'compiled previously' : 'not compiled')}>
        {compiled ? (
          <>
            <p>AIR digest: <code>{compiled.airDigest.slice(0, 24)}…</code></p>
            <p>Affected subgraph: <strong>{compiled.affectedComponentIds.join(', ')}</strong></p>
            <ul className="v2-list">
              {Object.entries(compiled.changedFieldsByComponent).map(([componentId, reasons]) => (
                <li key={componentId}>{componentId}: {reasons.join('; ')}</li>
              ))}
            </ul>
          </>
        ) : <p className="v2-empty">Compile the draft to compute the affected subgraph.</p>}
      </Panel>
    </section>
  )
}

function Execution({ runDetail, outcome, runId }: { runDetail: RunInspection | null; outcome: RunOutcome | null; runId: string | null }) {
  if (!runDetail) return <Panel title="Execution"><p className="v2-empty">Execute a compiled draft to watch the task DAG run.</p></Panel>
  return (
    <section className="v2-grid">
      <Panel title="Task DAG" hint={`${runDetail.run.id} · ${runDetail.run.status}`}>
        <table className="v2-table">
          <thead><tr><th>Step</th><th>Kind</th><th>Status</th><th>Attempt</th></tr></thead>
          <tbody>
            {runDetail.tasks.map(task => (
              <tr key={task.id}>
                <td><code>{task.id}</code></td><td>{task.kind}</td>
                <td><span className={`v2-status v2-status--${task.status.toLowerCase()}`}>{task.status}</span></td>
                <td>{task.attempt}/{task.maxAttempts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="Budgets" hint={outcome ? `${outcome.completedStepIds.length} steps completed` : '—'}>
        {outcome ? (
          <ul className="v2-list">
            <li>Repair attempts used: {outcome.repairAttemptsUsed}</li>
            <li>Verification attempts: {outcome.verificationAttempts}</li>
            {outcome.error && <li className="v2-error">Error: {outcome.error}</li>}
          </ul>
        ) : <p className="v2-empty">No outcome recorded yet.</p>}
        <p className="v2-hint">Run id: <code>{runId ?? '—'}</code></p>
      </Panel>
    </section>
  )
}

function Verification({ reports, runDetail }: { reports: ReportShape[]; runDetail: RunInspection | null }) {
  if (reports.length === 0) return <Panel title="Verification"><p className="v2-empty">Verification reports appear after a run executes its gates.</p></Panel>
  return (
    <section>
      {reports.map((report, index) => (
        <Panel key={index} title={`Verification attempt ${report.attempt}`} hint={`${report.status} · ${report.digest?.slice(0, 16) ?? ''}…`}>
          <table className="v2-table">
            <thead><tr><th>Gate</th><th>Status</th><th>Detail</th></tr></thead>
            <tbody>
              {report.gates.map(gate => (
                <tr key={gate.name}>
                  <td>{gate.name}</td>
                  <td><span className={`v2-status v2-status--${gate.status}`}>{gate.status}</span></td>
                  <td>{gate.summary}{gate.failureFingerprint ? ` · fingerprint ${gate.failureFingerprint}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ))}
      <Panel title="Repair trail" hint="scoped to compiled write sets">
        <ul className="v2-list">
          {(runDetail?.events ?? []).filter(event => event.type === 'REPAIR_APPLIED' || event.type === 'SCRIPTED_DEFECT_APPLIED').map(event => (
            <li key={event.sequence}><code>{event.type}</code> — {JSON.stringify(event.payload).slice(0, 160)}</li>
          ))}
        </ul>
      </Panel>
    </section>
  )
}

function Approval({ runDetail, onApprove, onReject }: { runDetail: RunInspection | null; onApprove: () => void; onReject: () => void }) {
  const pending = runDetail?.approvals.find(approval => approval.decision === 'PENDING')
  return (
    <Panel title="Architect decision" hint={runDetail ? runDetail.run.id : 'no run'}>
      {!pending ? (
        <p className="v2-empty">No pending approval gate. Execute a compiled draft first.</p>
      ) : (
        <>
          <p>The verified candidate is awaiting the <code>{'architect-promotion'}</code> gate. The decision binds the immutable evidence-core digest.</p>
          <label className="v2-label" htmlFor="approval-actor">Actor</label>
          <input id="approval-actor" defaultValue="solution-architect" />
          <label className="v2-label" htmlFor="approval-reason">Rejection reason (optional)</label>
          <input id="approval-reason" placeholder="why this candidate should not promote" />
          <div className="v2-actions">
            <button type="button" className="v2-primary" onClick={onApprove}>Approve &amp; promote</button>
            <button type="button" onClick={onReject}>Reject</button>
          </div>
        </>
      )}
    </Panel>
  )
}

function Evidence({ runDetail, outcome, runId }: { runDetail: RunInspection | null; outcome: RunOutcome | null; runId: string | null }) {
  const promotion = runDetail?.promotion
  const evidenceReady = (runDetail?.events ?? []).find(event => event.type === 'EVIDENCE_READY')
  return (
    <section className="v2-grid">
      <Panel title="Evidence" hint={runId ?? 'no run'}>
        {evidenceReady ? (
          <ul className="v2-list">
            <li>Evidence core digest: <code>{String((evidenceReady.payload as Json).evidenceCoreDigest).slice(0, 32)}…</code></li>
            <li>Artifact dir: <code>{String((evidenceReady.payload as Json).artifactDir)}</code></li>
          </ul>
        ) : <p className="v2-empty">Evidence appears once a run reaches its approval gate.</p>}
      </Panel>
      <Panel title="Promotion" hint={promotion ? 'promoted workflow' : 'not promoted'}>
        {promotion ? (
          <ul className="v2-list">
            <li>Workflow digest: <code>{promotion.workflowDigest}</code></li>
            <li>Candidate commit: <code>{promotion.sourceCommit.slice(0, 12)}</code></li>
          </ul>
        ) : <p className="v2-empty">Promotion happens only after an explicit architect approval.</p>}
      </Panel>
      <Panel title="Replay" hint="static workflow re-execution">
        {outcome?.status === 'PROMOTED'
          ? <p>The promoted workflow is replayable from its static inputs alone; replay assertions ran as the final plan step (REPLAY_ASSERT).</p>
          : <p className="v2-empty">Replay evidence appears after promotion.</p>}
      </Panel>
    </section>
  )
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="v2-panel">
      <header className="v2-panel-head"><h2>{title}</h2>{hint && <small>{hint}</small>}</header>
      {children}
    </section>
  )
}

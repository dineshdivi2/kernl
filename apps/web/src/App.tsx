import { useCallback, useEffect, useMemo, useState } from 'react'
import { approveRun, loadState, replayRun, runDemo } from './api'
import type {
  ArchitectureBinding,
  ArchitectureComponent,
  ArchitectureGraph,
  EffectReceipt,
  KernlState,
  ProviderLifecycle,
  RunTask,
  Status,
} from './types'

type Action = 'demo' | 'approve' | 'replay'

const statusLabels: Record<string, string> = {
  waiting_approval: 'Waiting approval',
  not_started: 'Not started',
}

function displayStatus(value?: Status): string {
  if (!value) return 'Not available'
  return statusLabels[value] ?? value.replaceAll('_', ' ')
}

function statusClass(value?: Status): string {
  const normalized = value?.toLowerCase().replaceAll('_', '-') ?? 'unknown'
  return `status status--${normalized}`
}

function formatTime(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString()
}

function shortCommit(value?: string): string {
  return value && value.length > 12 ? value.slice(0, 12) : value ?? '—'
}

function Icon({ name }: { name: 'run' | 'approve' | 'replay' | 'refresh' }) {
  const paths = {
    run: <path d="M7 4.5v15l12-7.5L7 4.5Z" />,
    approve: <path d="m5 12 4 4L19 6" />,
    replay: <path d="M4 9V4m0 0h5M4 4l3.6 3.6A7 7 0 1 1 5.5 16" />,
    refresh: <path d="M20 7h-5V2M20 2l-3.6 3.6A8 8 0 1 0 20 12" />,
  }
  return (
    <svg aria-hidden="true" className="icon" viewBox="0 0 24 24">
      {paths[name]}
    </svg>
  )
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  )
}

function GraphCanvas({ graph, label }: { graph: ArchitectureGraph; label: string }) {
  const dimensions = { width: 760, height: 290 }
  const positioned = useMemo(
    () =>
      graph.components.map((component, index) => ({
        ...component,
        x: component.x ?? 36 + (index % 3) * 244,
        y: component.y ?? 80 + Math.floor(index / 3) * 150,
      })),
    [graph.components],
  )
  const byId = new Map(positioned.map((component) => [component.id, component]))

  if (positioned.length === 0) {
    return <Empty message="No architecture components have been persisted." />
  }

  return (
    <div className="graph-shell">
      <svg
        aria-label={label}
        className="architecture-graph"
        role="img"
        viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
      >
        <defs>
          <marker id={`arrow-${label.replaceAll(' ', '-')}`} markerHeight="8" markerWidth="8" orient="auto" refX="7" refY="4">
            <path d="M0,0 L8,4 L0,8 Z" className="edge-arrow" />
          </marker>
        </defs>
        {graph.bindings.map((binding, index) => {
          const from = byId.get(binding.from)
          const to = byId.get(binding.to)
          if (!from || !to) return null
          const x1 = from.x + 182
          const y1 = from.y + 48
          const x2 = to.x
          const y2 = to.y + 48
          const bend = Math.max(36, Math.abs(x2 - x1) * 0.42)
          return (
            <g key={binding.id ?? `${binding.from}-${binding.to}-${index}`}>
              <path
                className="graph-edge"
                d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                markerEnd={`url(#arrow-${label.replaceAll(' ', '-')})`}
              />
              <text className="edge-label" textAnchor="middle" x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 9}>
                {binding.capability}{binding.version ? ` · ${binding.version}` : ''}
              </text>
            </g>
          )
        })}
        {positioned.map((component) => (
          <ComponentNode component={component} key={component.id} />
        ))}
      </svg>
    </div>
  )
}

function ComponentNode({ component }: { component: ArchitectureComponent & { x: number; y: number } }) {
  const capability = component.provides?.[0]?.name ?? component.requires?.[0]?.name
  return (
    <g className="component-node" transform={`translate(${component.x} ${component.y})`}>
      <title>{`${component.name}, ${component.version}, ${component.lifecycle}`}</title>
      <rect height="96" rx="12" width="182" />
      <circle className={`lifecycle-dot lifecycle-dot--${component.lifecycle.toLowerCase()}`} cx="17" cy="19" r="5" />
      <text className="node-kind" x="30" y="23">{component.kind ?? 'component'}</text>
      <text className="node-title" x="15" y="48">{component.name}</text>
      <text className="node-version" x="15" y="70">{component.version}</text>
      <text className="node-capability" x="15" y="86">{capability ?? 'No capabilities'}</text>
      <text className="node-lifecycle" textAnchor="end" x="168" y="70">{component.lifecycle}</text>
    </g>
  )
}

function ChangeSection({ state }: { state: KernlState }) {
  const before = state.change?.before
  const after = state.change?.after ?? state.architecture
  return (
    <section aria-labelledby="architecture-title" className="panel panel--wide">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Architecture control plane</p>
          <h2 id="architecture-title">Architecture change</h2>
          <p>{state.change?.summary ?? 'Current persisted architecture'}</p>
        </div>
        <div className="version-pill">AIR {state.run?.airVersion ?? state.architecture.version ?? '—'}</div>
      </div>
      {state.change?.affectedComponents && state.change.affectedComponents.length > 0 && (
        <div className="affected" aria-label="Affected components">
          <span>Affected subgraph</span>
          {state.change.affectedComponents.map((component) => <code key={component}>{component}</code>)}
        </div>
      )}
      <div className={`comparison ${before ? '' : 'comparison--single'}`}>
        {before && (
          <div>
            <h3>Before</h3>
            <GraphCanvas graph={before} label="Architecture before change" />
          </div>
        )}
        <div>
          <h3>{before ? 'Proposed' : 'Current'}</h3>
          <GraphCanvas graph={after} label="Architecture after change" />
        </div>
      </div>
      <BindingList bindings={after.bindings} components={after.components} />
    </section>
  )
}

function BindingList({ bindings, components }: { bindings: ArchitectureBinding[]; components: ArchitectureComponent[] }) {
  const names = new Map(components.map((component) => [component.id, component.name]))
  return (
    <div className="binding-list" aria-label="Typed bindings">
      <h3>Typed bindings</h3>
      {bindings.length === 0 ? <Empty message="No bindings are present." compact /> : bindings.map((binding, index) => (
        <div className="binding" key={binding.id ?? `${binding.from}-${binding.to}-${index}`}>
          <span>{names.get(binding.from) ?? binding.from}</span>
          <span className="binding__capability">{binding.capability}{binding.version ? `@${binding.version}` : ''}</span>
          <span>{names.get(binding.to) ?? binding.to}</span>
          {binding.status && <span className={statusClass(binding.status)}>{displayStatus(binding.status)}</span>}
        </div>
      ))}
    </div>
  )
}

function TaskDag({ tasks }: { tasks: RunTask[] }) {
  if (tasks.length === 0) return <Empty message="No task DAG has been compiled." />
  return (
    <ol className="task-dag">
      {tasks.map((task) => (
        <li className="task" key={task.id}>
          <div className="task__line" aria-hidden="true" />
          <div className="task__header">
            <span className="task__id">{task.id}</span>
            <span className={statusClass(task.status)}>{displayStatus(task.status)}</span>
          </div>
          <strong>{task.title}</strong>
          <div className="task__meta">
            {task.agent && <span>{task.agent}</span>}
            {task.attempt !== undefined && <span>Attempt {task.attempt}</span>}
            {task.dependencies && task.dependencies.length > 0 && <span>After {task.dependencies.join(', ')}</span>}
          </div>
          {task.writeScopes && task.writeScopes.length > 0 && (
            <div className="scopes" aria-label={`Write scopes for ${task.title}`}>
              {task.writeScopes.map((scope) => <code key={scope}>{scope}</code>)}
            </div>
          )}
        </li>
      ))}
    </ol>
  )
}

function VerificationSection({ state }: { state: KernlState }) {
  const passed = state.verification.filter((gate) => gate.status === 'passed').length
  return (
    <section aria-labelledby="verification-title" className="panel">
      <div className="section-heading section-heading--compact">
        <div>
          <p className="eyebrow">Verification plane</p>
          <h2 id="verification-title">Deterministic gates</h2>
        </div>
        <span className="count">{passed}/{state.verification.length}</span>
      </div>
      {state.verification.length === 0 ? <Empty message="No verification results are available." /> : (
        <ul className="gate-list">
          {state.verification.map((gate) => (
            <li key={gate.id}>
              <span className={`gate-mark gate-mark--${gate.status}`} aria-hidden="true">
                {gate.status === 'passed' ? '✓' : gate.status === 'failed' ? '!' : '·'}
              </span>
              <div>
                <div className="gate-title">
                  <strong>{gate.name}</strong>
                  <span className={statusClass(gate.status)}>{displayStatus(gate.status)}</span>
                </div>
                {gate.summary && <p>{gate.summary}</p>}
                <div className="gate-evidence">
                  {gate.evidencePath && <code>{gate.evidencePath}</code>}
                  {gate.durationMs !== undefined && <span>{gate.durationMs} ms</span>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function LifecycleStrip({ snapshots }: { snapshots: ProviderLifecycle[] }) {
  if (snapshots.length === 0) return null
  return (
    <div className="lifecycle-strip" aria-label="Provider lifecycle snapshots">
      {snapshots.map((snapshot) => (
        <article key={`${snapshot.providerId}:${snapshot.version ?? ''}`}>
          <div>
            <strong>{snapshot.providerId}</strong>
            {snapshot.version && <code>{snapshot.version}</code>}
          </div>
          <span className={statusClass(snapshot.state)}>{displayStatus(snapshot.state)}</span>
          <dl>
            <div><dt>Reliance</dt><dd>{snapshot.relianceCount ?? '—'}</dd></div>
            <div>
              <dt>New bindings</dt>
              <dd>{snapshot.acceptsNewBindings === undefined ? '—' : snapshot.acceptsNewBindings ? 'Accepted' : 'Rejected'}</dd>
            </div>
          </dl>
        </article>
      ))}
    </div>
  )
}

function EffectTable({ effects, lifecycle }: { effects: EffectReceipt[]; lifecycle: ProviderLifecycle[] }) {
  return (
    <section aria-labelledby="effects-title" className="panel panel--wide">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Durable execution</p>
          <h2 id="effects-title">Lifecycle &amp; effect ledger</h2>
          <p>Persisted receipts make retries, compensation and replay inspectable.</p>
        </div>
        <span className="count">{effects.length}</span>
      </div>
      <LifecycleStrip snapshots={lifecycle} />
      {effects.length === 0 ? <Empty message="No effect receipts have been recorded." /> : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Effect</th>
                <th scope="col">Resource</th>
                <th scope="col">Component / task</th>
                <th scope="col">Recovery</th>
                <th scope="col">Idempotency key</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {effects.map((effect) => (
                <tr key={effect.id}>
                  <td><strong>{effect.effectType}</strong><small>#{effect.sequence ?? effect.id}</small></td>
                  <td>{effect.resource}</td>
                  <td>{effect.componentId ?? '—'}<small>{effect.taskId ?? ''}</small></td>
                  <td><span className="recovery">{effect.recoveryClass}</span></td>
                  <td><code>{effect.idempotencyKey}</code></td>
                  <td>{effect.resultingState ?? displayStatus(effect.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Promotion({ state }: { state: KernlState }) {
  return (
    <section aria-labelledby="promotion-title" className="panel">
      <div className="section-heading section-heading--compact">
        <div>
          <p className="eyebrow">Human control</p>
          <h2 id="promotion-title">Approval &amp; promotion</h2>
        </div>
        <span className={statusClass(state.promotion?.status ?? state.approval?.status)}>
          {displayStatus(state.promotion?.status ?? state.approval?.status)}
        </span>
      </div>
      {!state.approval && !state.promotion ? <Empty message="No approval has been requested." /> : (
        <div className="promotion-grid">
          <Detail label="Approval" value={displayStatus(state.approval?.status)} />
          <Detail label="Actor" value={state.approval?.actor ?? '—'} />
          <Detail label="AIR gate" value={state.approval?.gateId ?? '—'} mono />
          <Detail label="Required role" value={state.approval?.requiredRole ?? 'Unknown'} />
          <Detail label="Decision time" value={formatTime(state.approval?.decidedAt)} />
          <Detail label="Workflow" value={state.promotion?.workflowVersion ?? '—'} mono />
          <Detail label="AIR version" value={state.promotion?.airVersion ?? state.run?.airVersion ?? '—'} mono />
          <Detail label="Git commit" value={shortCommit(state.promotion?.gitCommit)} mono />
          <Detail label="Verification" value={state.promotion?.verificationId ?? '—'} mono />
          <Detail label="Approved evidence core" value={state.promotion?.evidenceCore ?? '—'} mono wide />
          <Detail label="Final evidence manifest" value={state.promotion?.evidenceManifest ?? '—'} mono wide />
          <Detail label="Artifact directory" value={state.promotion?.artifactDir ?? '—'} mono wide />
          <Detail label="Workflow artifact" value={state.promotion?.workflowPath ?? '—'} mono wide />
        </div>
      )}
    </section>
  )
}

function Detail({ label, value, mono, wide }: { label: string; value: string; mono?: boolean; wide?: boolean }) {
  return (
    <div className={`detail ${wide ? 'detail--wide' : ''}`}>
      <span>{label}</span>
      <strong className={mono ? 'mono' : ''}>{value}</strong>
    </div>
  )
}

function Empty({ message, compact }: { message: string; compact?: boolean }) {
  return <div className={`empty ${compact ? 'empty--compact' : ''}`}>{message}</div>
}

export interface AppProps {
  initialState?: KernlState
  initialApprovalActor?: string
}

export function App({ initialState, initialApprovalActor = '' }: AppProps = {}) {
  const [state, setState] = useState<KernlState | null>(initialState ?? null)
  const [loading, setLoading] = useState(initialState === undefined)
  const [action, setAction] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [approvalActor, setApprovalActor] = useState(initialApprovalActor)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setState(await loadState())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load persisted state.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (initialState === undefined) void refresh()
  }, [initialState, refresh])

  async function invoke(nextAction: Action) {
    setAction(nextAction)
    setError(null)
    try {
      if (nextAction === 'demo') {
        setState(await runDemo())
      } else {
        const runId = state?.run?.id
        if (!runId) throw new Error('Start a demo run before using this action.')
        if (nextAction === 'approve') {
          const actor = approvalActor.trim()
          if (!actor) throw new Error('Enter the architect who reviewed this evidence before approving.')
          setState(await approveRun(runId, actor))
        } else {
          setState(await replayRun(runId))
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not ${nextAction} the run.`)
    } finally {
      setAction(null)
    }
  }

  const allGatesPassed = Boolean(state?.verification.length) && state!.verification.every((gate) => gate.status === 'passed')
  const canApprove = Boolean(state?.run?.id && allGatesPassed && !state?.promotion)
  const canReplay = Boolean(state?.run?.id)

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#main" aria-label="Kernl dashboard home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>Kernl</span>
        </a>
        <div className="topbar__context">
          <span className="environment-dot" />
          Local control plane
        </div>
        <button aria-label="Refresh persisted state" className="button button--quiet" disabled={loading || Boolean(action)} onClick={() => void refresh()}>
          <Icon name="refresh" /> Refresh
        </button>
      </header>

      <main id="main">
        <section className="hero" aria-labelledby="page-title">
          <div>
            <p className="eyebrow">Architecture → running software → evidence</p>
            <h1 id="page-title">Architecture control room</h1>
            <p>Change the system at the component and contract level. Kernl bounds implementation agents and promotes only verified results.</p>
          </div>
          <div className="actions" aria-label="Run controls">
            <button className="button button--primary" disabled={Boolean(action)} onClick={() => void invoke('demo')}>
              <Icon name="run" /> {action === 'demo' ? 'Running…' : 'Run deterministic demo'}
            </button>
            <label className="approval-actor">
              <span>Approval actor</span>
              <input
                aria-label="Approval actor"
                autoComplete="name"
                disabled={Boolean(action) || !canApprove}
                onChange={(event) => setApprovalActor(event.target.value)}
                placeholder="Reviewed by…"
                value={approvalActor}
              />
            </label>
            <button className="button" disabled={Boolean(action) || !canApprove || !approvalActor.trim()} onClick={() => void invoke('approve')}>
              <Icon name="approve" /> {action === 'approve' ? 'Approving…' : 'Approve & promote'}
            </button>
            <button className="button" disabled={Boolean(action) || !canReplay} onClick={() => void invoke('replay')}>
              <Icon name="replay" /> {action === 'replay' ? 'Replaying…' : 'Replay'}
            </button>
          </div>
        </section>

        {error && (
          <div className="error-banner" role="alert">
            <strong>Control plane request failed.</strong>
            <span>{error}</span>
            <button onClick={() => void refresh()}>Try again</button>
          </div>
        )}

        {loading && !state ? (
          <div className="loading" role="status"><span /> Loading persisted control-plane state…</div>
        ) : !state ? (
          <Empty message="The API returned no Kernl state." />
        ) : (
          <>
            <section aria-label="Run summary" className="metrics-row">
              <Metric label="Run" value={state.run?.id ?? 'Not started'} detail={state.run?.mode} />
              <Metric label="Run status" value={displayStatus(state.run?.status)} detail={formatTime(state.updatedAt)} />
              <Metric
                label="Repair budget"
                value={state.run ? `${state.run.repairCount ?? 0} used` : 'Not started'}
                detail={state.run?.maxRepairAttempts !== undefined ? `${state.run.maxRepairAttempts} maximum` : 'bounded repair attempts'}
              />
              <Metric
                label="Verification"
                value={`${state.verification.filter((gate) => gate.status === 'passed').length} / ${state.verification.length}`}
                detail="gates passed"
              />
              <Metric
                label="Replay"
                value={displayStatus(state.replay?.status)}
                detail={state.replay ? `${state.replay.duplicateEffects ?? 0} duplicate effects` : undefined}
              />
            </section>

            <ChangeSection state={state} />

            <div className="two-column">
              <section aria-labelledby="tasks-title" className="panel">
                <div className="section-heading section-heading--compact">
                  <div>
                    <p className="eyebrow">Agent execution plane</p>
                    <h2 id="tasks-title">Compiled task DAG</h2>
                  </div>
                  <span className="count">{state.run?.tasks.length ?? 0}</span>
                </div>
                <TaskDag tasks={state.run?.tasks ?? []} />
              </section>
              <VerificationSection state={state} />
            </div>

            <EffectTable effects={state.effects} lifecycle={state.lifecycle ?? []} />

            <div className="two-column two-column--bottom">
              <Promotion state={state} />
              <section aria-labelledby="replay-title" className="panel">
                <div className="section-heading section-heading--compact">
                  <div>
                    <p className="eyebrow">Deterministic recovery</p>
                    <h2 id="replay-title">Replay</h2>
                  </div>
                  <span className={statusClass(state.replay?.status)}>{displayStatus(state.replay?.status)}</span>
                </div>
                {!state.replay ? <Empty message="Replay has not been run." /> : (
                  <div className="replay-metrics">
                    <Metric label="Events reduced" value={state.replay.eventCount ?? 0} />
                    <Metric label="Effects reconstructed" value={state.replay.effectCount ?? 0} />
                    <Metric label="Effects duplicated" value={state.replay.duplicateEffects ?? 0} />
                    <Detail label="Replayed at" value={formatTime(state.replay.replayedAt)} />
                  </div>
                )}
              </section>
            </div>
          </>
        )}
      </main>
      <footer>
        <span>Kernl prototype</span>
        <span>Persisted state · bounded agents · deterministic promotion</span>
      </footer>
    </div>
  )
}

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { App } from './App'
import { normalizeWireState } from './api'

const apiState = {
  system: { name: 'Kernl', mode: 'deterministic', runId: 'run-demo-001', status: 'waiting_approval' },
  architecture: {
    before: {
      version: 'air-001',
      nodes: [
        { id: 'api', label: 'Jobs API', kind: 'http-api', version: '1.0.0', provides: ['jobs.http@v1'], requires: ['jobs.execute@v1'] },
        { id: 'worker', label: 'Worker', kind: 'service', version: '1.0.0', provides: ['jobs.execute@v1'], requires: [] },
      ],
      edges: [{ from: 'api', to: 'worker', capability: 'jobs.execute', providerVersion: 'v1' }],
    },
    after: {
      version: 'air-002',
      nodes: [
        { id: 'api', label: 'Jobs API', kind: 'http-api', version: '2.0.0', provides: ['jobs.http@v1'], requires: ['jobs.events@v2'] },
        { id: 'queue-v2', label: 'Versioned Queue', kind: 'queue', version: '2.0.0', provides: ['jobs.events@v2'], requires: [] },
        { id: 'worker', label: 'Worker', kind: 'consumer', version: '2.0.0', provides: [], requires: ['jobs.events@v2'] },
      ],
      edges: [
        { from: 'api', to: 'queue-v2', capability: 'jobs.events', providerVersion: 'v2' },
        { from: 'queue-v2', to: 'worker', capability: 'jobs.events', providerVersion: 'v2' },
      ],
    },
    diff: { changedNodeIds: ['api', 'queue-v2', 'worker'], changedEdgeIds: ['api-queue-v2', 'queue-v2-worker'] },
  },
  tasks: [
    { id: 'task-plan', title: 'Compile affected subgraph', status: 'passed', kind: 'plan', dependencies: [], allowedPaths: [], attempt: 1 },
    { id: 'task-repair', title: 'Repair worker event contract', status: 'passed', kind: 'repair', dependencies: ['task-plan'], allowedPaths: ['fixture/src/worker/**'], attempt: 2 },
  ],
  events: [{ id: 'event-1', timestamp: '2026-08-20T00:00:00.000Z' }],
  lifecycle: [
    { providerId: 'queue-v1', version: '1.0.0', state: 'DRAINING', relianceCount: 1, acceptsNewBindings: false },
    { providerId: 'queue-v2', version: '2.0.0', state: 'ACTIVE', relianceCount: 1, acceptsNewBindings: true },
  ],
  bindings: [
    { from: 'api', to: 'queue-v2', capability: 'jobs.events', providerVersion: 'v2', status: 'active' },
    { from: 'queue-v2', to: 'worker', capability: 'jobs.events', providerVersion: 'v2', status: 'active' },
  ],
  verification: {
    attempts: 2,
    latestGates: [{ name: 'Event contract', status: 'passed', summary: 'Producer and consumer agree.', evidencePath: 'artifacts/demo-run/verification.json' }],
  },
  effects: [{
    id: 'effect-1', sequence: 1, componentId: 'queue-v1', effectType: 'RETIRE_PROVIDER', resource: 'queue:v1',
    recoveryClass: 'COMPENSATABLE', idempotencyKey: 'run-demo-001:retire:queue-v1', resultingState: 'DRAINING',
  }],
  approval: {
    id: 'approval-1', decision: 'PENDING', gateId: 'architect-promotion', requiredRole: 'platform-architect',
    requestedAt: '2026-08-20T00:00:00.000Z',
  },
  promotion: null,
  evidence: { artifactDir: 'artifacts/demo-run' },
}

describe('Kernl control plane', () => {
  it('server-renders representative persisted state across every control-plane view', () => {
    const state = normalizeWireState(apiState)
    const html = renderToStaticMarkup(<App initialState={state} initialApprovalActor="reviewing-architect" />)

    for (const expected of [
      'Repair worker event contract', 'Versioned Queue', 'Event contract', 'RETIRE_PROVIDER',
      'COMPENSATABLE', 'Rejected', '1 used', 'platform-architect', 'Approve &amp; promote',
    ]) expect(html).toContain(expected)
    expect(html).toContain('value="reviewing-architect"')
  })

  it('shows an explicit unknown role when persisted role evidence is absent', () => {
    const state = normalizeWireState({
      ...apiState,
      approval: { ...apiState.approval, requiredRole: null },
    })
    const html = renderToStaticMarkup(<App initialState={state} />)

    expect(html).toContain('Required role')
    expect(html).toContain('Unknown')
    expect(html).not.toContain('platform-architect')
  })
})

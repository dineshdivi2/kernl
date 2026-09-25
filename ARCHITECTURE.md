# Kernl prototype architecture

## Current product boundary (supersedes older completion claims)

The current UI authors architecture-operation drafts, compiles content-versioned AIR, and asynchronously starts the V2 executor. `/api/v2/runs/:id` exposes complete persisted events, tasks, effects and frozen inputs. Approval resumes those inputs, never a mutable draft/current catalog.

Migration 4 in `packages/core/src/ledger.ts` adds immutable `run_inputs`, planned/committed `operations`, and expiring `execution_leases`. Epoch checks fence an old owner. Each task freezes its base commit and proposed files before mutation. Recovery reconciles worktree creation, file writes, task commit and integration. This is a local SQLite/Git protocol, not distributed exactly-once execution.

`ChatCompletionClient` is an optional direct provider adapter. Fixed official HTTPS endpoints receive bounded JSON requests with in-memory credentials. Returned file proposals pass schema, secret and write-scope checks before Git mutation. The out-of-tree DSH plugin remains separate: direct provider runs are not DSH-backed runs.

Verification binds the candidate commit. Promotion checks clean integration HEAD, the verification commit, the approved core digest and each sealed file hash. The code patch, catalog and execution fingerprints are sealed before approval; later events are written separately. Recipe replay checks exact catalog/template/runtime fingerprints and refuses live output. Ledger replay reconstructs facts without executing effects.

Remaining limits: a small jobs-system recipe catalog; modelled V2 provider replacement, not running hot swap; self-declared local roles, not authentication; worktrees/Node network guards, not OS sandboxing. Request/output/time caps exist, but USD spend and every declarative workflow assertion are not independently enforced. See `PRODUCT_HANDOFF.md`.

Kernl compiles an architecture change into bounded implementation work and accepts the result only through deterministic evidence. The local process preserves three authority planes even though they share one Node.js runtime.

| Plane | Owns | Must not delegate to the model |
| --- | --- | --- |
| Architecture control | AIR versions, typed contracts, exact bindings, semantic diff, affected subgraph, task DAG, policies | schema/semantic validity, dependency resolution, scopes, approval requirements |
| Agent execution | deterministic or DSH-backed proposals inside claimed tasks and isolated worktrees | authorization, shared-tree mutation, final correctness, promotion |
| Verification | build/type/unit/integration/contract/invariant gates, evidence, replay, promotion | gate outcomes, retry limits, lifecycle transitions, effect recovery |

```text
AIR before/after
      |
      v
schema + graph + binding policy validation
      |
      v
semantic diff -> affected subgraph -> task DAG + write scopes
      |
      v
deterministic or DSH agent adapter -> isolated Git worktrees
      |
      v
integration branch -> build/type/unit/contract/invariant gates
      |                         |
      | failure                 | pass
      v                         v
bounded repair task       human approval
      |                         |
      +-------------------------+
                                v
static workflow + evidence manifest
                                |
                                v
           static execution + event/effect replay checks
```

## Authority boundaries

- AIR is intended-design truth.
- Git is implementation truth.
- SQLite is local run/effect/approval truth.
- DSH or the deterministic adapter may propose and implement only bounded tasks.
- Verification code decides gate outcomes.
- A human or explicitly labelled deterministic-demo actor approves promotion.

The run begins from a validated synchronous baseline. AIR validation happens before the first `MODEL_REQUEST` event. Each model-equivalent request, proposed action, authorization, execution, observation, verification result, approval, and finalization has a typed ledger event.

## Persistence model

The ledger is append-oriented. Runs, tasks, AIR versions, events, effects, approvals, and release bindings have query tables, while events retain the replay source. Effect idempotency keys are unique. Replaying reducers does not execute mutations. The coordinator requires a passing verification result, and the promotion transaction independently rejects AIR/source mismatches or approval evidence that differs from the exact evidence digest being promoted.

Two evidence hashes have distinct purposes:

- `evidenceCoreDigest` covers the immutable pre-approval pack: AIR, diff, plan, baseline, failed and passing verification, lifecycle/effects, code diff, commits, and trajectory. The approval and promotion bind to this digest.
- `evidenceManifestDigest` covers the final manifest that additionally indexes the decision, promotion, static-workflow execution, and restart/replay reports. It cannot be the pre-approval subject because those records do not exist until after the decision.

## Lifecycle model

Components expose typed capabilities and consumers bind to exact provider identities and versions. The prototype implements `PENDING`, `LOADING`, `ACTIVE`, `RETIRING`, `DRAINING`, `INACTIVE`, and `FAILED`.

```text
PENDING -> LOADING -> ACTIVE -> RETIRING -> DRAINING -> INACTIVE
                  \-> FAILED       \-----------> FAILED
```

A provider is unpublished before draining. Existing committed consumers remain valid while it drains; no new binding can target it. `INACTIVE` requires zero reliance and a committed cleanup-effect receipt for that exact provider. A consumer requirement can have only one committed exact provider binding.

## Agent isolation

The planner derives write scopes from changed AIR nodes. The coordinator creates an isolated Git worktree per mutating task, validates the resulting paths twice (proposed mutations and observed Git status), commits the patch on a task branch, and integrates it. Tests and verification policy remain outside every builder scope. The default adapter is scripted so CI reproduces the same initial failure and repair.

The promoted workflow records typed inputs/outputs, exact tool bindings, dependencies, task/step/agent/model/time budgets, per-step timeouts, assertions, approval policy, evaluation baseline, and AIR/Git/evidence provenance. Its deterministic executor verifies the workflow content digest and AIR/DAG digests before re-running the implementation/failure/repair/verification sequence in a new repository, executing the AIR-bound queue-v1-to-v2 lifecycle step, and writing a replay-specific evidence manifest. It needs the versioned artifact inputs, not the original chat.

Run-repository creation, worktree creation, scoped writes, Git integration, lifecycle transitions, evidence materialization, and canonical publication carry durable receipts and idempotency keys. The SQLite journal and evidence manifest are persistence roots rather than recursively receipt-wrapped filesystem effects; otherwise a receipt for writing the receipt ledger would require another receipt indefinitely.

## DSH boundary

The out-of-tree plugin defines a `kernl` service and five model-facing tools. Cordis `inject` controls dependency readiness; registrations unwind as effects. A missing provider therefore leaves the consumer pending. DSH provides live model/tool trajectory, while the Kernl API owns durable task claims, results, verification, approvals, and promotion.

The current DSH workflow engine is deliberately not the coordinator: it runs in the foreground, has no authoritative journal/resume, and cannot assign independent child working directories. Live DSH can explore within Kernl-issued capability and task boundaries; it cannot silently advance lifecycle, approval, or promotion state.

## Runtime package boundaries

```text
apps/web -> apps/server -> packages/runtime -> packages/core -> SQLite
                    ^              |
                    |              +-> Git worktrees + deterministic gates
packages/dsh-plugin-+                    (replaceable local adapters)
```

- `packages/core` has no model dependency. It contains AIR parsing/semantic validation, hashing/redaction, semantic diff/DAG compilation, lifecycle guards, SQLite persistence, and replay reducers.
- `packages/runtime` owns action policy, the deterministic adapter, Git execution, verification, lifecycle demonstration, evidence, workflow compilation/execution, and the coordinator.
- `apps/server` exposes persisted commands/projections and the DSH HTTP boundary.
- `apps/web` renders only server state and submits explicit demo/approval/replay commands.
- `packages/dsh-plugin` imports no DSH internals; it uses the documented Cordis service, injection, and tool-registration shapes supplied at runtime.

## Later substitutions

SQLite coordinator → Temporal and PostgreSQL; local worktrees → sandbox provider; local files → content-addressed object storage; deterministic agent → DSH/DeepSeek or another provider; unsigned manifest → signed OCI evidence. These are substitutions behind current interfaces, not prerequisites for the prototype.

# Kernl prototype decisions

## D023 — Evidence, not completion claims, defines the baseline

The September 12 read-only audit of the OX Alpha outputs found useful catalog/draft/compiler work and passing supplied tests, but wrong candidate commits and rewritten approved evidence in the V2 packs. Preserve the D: outputs and V1 branch. Continue from V2 release `68bc532` on `codex/kernl-product-alpha`, fix integrity before enlarging the catalog. `PRODUCT_HANDOFF.md` records the measured result; earlier statements below are historical and are not blanket acceptance claims.

## D024 — Strengthen Cordis-style effects with durable local intent

DSH/Cordis lifecycle ownership remains useful for plugin load/unload. Kernl owns frozen AIR/catalog/plan inputs, lease epochs, operation intents, effect receipts, retry counters and approval state. In-memory undo closures and DSH session events are not recovery authority. Tests now interrupt ordinary Git tasks after worktree creation, writes, commit and integration, then reconcile without another merge.

## D025 — Model-neutral inference boundary, explicit limitations

DeepSeek, OpenRouter and Nous transports share bounded JSON proposal validation and deterministic stubs. Existing environment keys stay in memory. Direct provider calls enable a small live implementation trial without modifying DSH upstream; they do not prove the full DSH mutation path. Documentation research used official provider contracts. Hermes model access was not available in the returned Nous model list; never silently substitute a model.

## D026 — Failure ownership is not gate ownership

A real DeepSeek trial exhausted three repairs because a queue gate's idempotency failure was assigned to the queue. The worker owns that duplicate effect. Repair authority now resolves declared/registered failure scopes and intersects them with compiled implementation scopes. A regression checks identical worker-scoped routing for mock and live modes; the following live run passed using four requests and one repair.

## D027 — Honest replay and promotion scope

Approve only the exact verified commit and sealed evidence bytes. Include source diff/catalog/fingerprints. Replay new deterministic workflows only with pinned runtime/template/catalog versions. Refuse recipe replay of live-generated output until captured-code replay exists. V2 lifecycle traces are model-state evidence, not proof of production hot replacement. This intentionally narrows earlier D019/D022 generalization and self-contained-replay claims.

## Status

These decisions define the falsifiable local prototype. They are intentionally smaller than the high-scale reference architecture.

## D001 — Preserve three planes in one local process

The prototype keeps an architecture control plane, bounded agent execution plane, and deterministic verification plane as explicit modules. They may run in one Node.js process, but their authority boundaries remain separate.

Source: `HIGH_SCALE_ARCHITECTURE.md`, sections 1, 5, 8, 10, and 11.

## D002 — AIR and Git have different authority

AIR records intended design. Git records implementation. A promotion binds one immutable AIR digest to one exact candidate commit, verification report, workflow digest, and immutable pre-approval evidence-core digest. A separate final manifest seals post-decision records. Neither representation silently overwrites the other.

Source: high-scale architecture and the architecture-control-plane Codex session.

## D003 — SQLite replaces Temporal only for prototype durability

Temporal is the production recommendation, but adding it would weaken the first experiment by expanding operations and failure surface. A SQLite event/effect ledger persists run state, idempotency keys, approvals, lifecycle transitions, and release bindings. Interfaces separate orchestration from storage so Temporal can replace the local coordinator later.

## D004 — DSH explores; Kernl authorizes and commits

DSH is an out-of-tree, replaceable agent provider. DSH session events retain model-visible trajectory. Kernl remains authoritative for AIR validation, task DAGs, write scopes, budgets, authorization, verification, repair limits, approval, and promotion. This follows DSH's plugin/capability model while respecting that its current workflow engine is foreground-only and has no journaling or resume.

Source: DSH `docs/architecture.md`, Cordis primer/tutorials, and workflow README.

## D005 — Deterministic mode is the acceptance baseline

The default demo uses scripted agents and no network or API key. It must produce a real Git diff, an intentional idempotency failure, a scoped repair, a passing verification report, approval, promotion, and idempotent replay. Live DSH mode is a smoke path and cannot weaken deterministic acceptance.

## D006 — Durable receipts strengthen local reversible effects

Cordis effects correctly unwind plugin-lifetime resources, but a crash-prone control plane cannot depend on in-memory disposer closures. Kernl persists effect receipts with resource identity, preconditions, outcome, provenance, recovery class, and idempotency key.

Workflow-visible filesystem effects are journaled at the useful recovery boundary: run-repository creation, worktree creation, scoped source writes, Git integration, evidence-pack materialization, and canonical publication. SQLite's own page writes and the act of materializing the receipt/manifest roots are control-plane persistence mechanics; recursively wrapping those writes would create an infinite self-receipt. Evidence files therefore carry hashes while SQLite remains the authoritative receipt ledger.

Source: the spatiotemporal-composability and Kernl lifecycle Codex sessions.

## D007 — Provider replacement is two-phase

Consumers bind to an exact provider instance and version. Retirement first rejects new bindings, then drains committed consumers, then permits `INACTIVE` only when reliance reaches zero. Property tests exercise this state machine.

## D008 — Concurrency follows independent write sets

The compiler may schedule at most two implementation tasks in parallel, and only when paths, contracts, and effects do not conflict. Each mutating task receives an isolated Git worktree. Agents never merge or declare themselves correct.

## D009 — Runtime action policy is outside the model

Every proposed mutation is checked against task authority, allowed paths, command policy, externality, reversibility, cost, privacy, and approval requirements. Trajectory events distinguish proposal, denial, execution, observation, approval, and finalization.

Source: `2026-08-19-agentic-action-alignment.md`.

## D010 — The UI is an operational projection

The browser reads persisted API state. It does not contain a hard-coded success narrative. The architecture graph, task state, repair, lifecycle ledger, verification gates, approval, and promotion shown in the UI are projections of SQLite records and evidence artifacts.

## D011 — No cloud-scale infrastructure in v0

Temporal, Kubernetes, Kafka, Redis, PostgreSQL, hosted collectors, microVMs, authentication, billing, and production deployment remain non-goals. Local Git worktrees and SQLite prove the contracts those systems would later implement.

## D012 — Handover state is an artifact

`NOW.md` holds one small next action. Durable events and evidence retain exact machine state; handovers retain validated facts, decisions, artifacts, constraints, uncertainty, failed approaches, unresolved questions, and the next-step contract—not the full working conversation.

## D013 — Use cached Hono and an SVG graph for the offline prototype

Fastify and React Flow are sound product-stack options but are not present in the verified local package cache. The first prototype uses Hono's Node adapter and a React-owned SVG architecture graph, both behind small interfaces. This keeps clean installation reproducible on the current Windows machine without making network availability part of acceptance. A later UI/API substitution does not change AIR, ledger, orchestration, or evidence contracts.

## D014 — AIR contract versions are immutable, including corrections

The first development fixture described numeric `jobId/input` shapes while the executable service actually used string `id/value` shapes. Treating that as a harmless edit would violate AIR immutability. The corrected before, queued, and queue-v2 documents therefore receive new AIR versions and exact parent links. Runtime promotion binds the corrected AIR digest, while old local SQLite rows remain historical development state.

The public HTTP and result contract objects are byte-equivalent before and after the async refactor; the event contract explicitly contains `eventId`, `jobId`, and string `value`. Tests assert both architectural equality and actual loopback HTTP behavior.

## D015 — Approval binds an immutable core; the final manifest is a second layer

A pre-approval evidence pack cannot contain the approval and promotion that do not exist yet. Kernl therefore uses two named digests:

- the evidence-core digest covers immutable decision inputs and is bound by the AIR-declared approval gate and promotion;
- the final manifest additionally indexes the decision, promotion record, static-workflow execution, and restart replay.

Pre-approval and final event logs use separate filenames so no approved byte is overwritten. Each run keeps its own artifact directory; a byte-identical copy of the latest successful run is published to `artifacts/demo-run` for the requested handoff.

## D016 — Generated-code verification receives no model credentials

Every Git or Node child started by the runtime receives an allowlisted environment rather than `process.env`. Credential-, token-, session-, cookie-, and secret-shaped variables are not inherited; caller-supplied `NODE_OPTIONS` is denied. Verification preloads a loopback-only network guard so the HTTP contract test can use its ephemeral local server while external fetch/socket attempts fail. Secret findings are reported only as classifications and offsets, never as matched credential text.

This is defense in depth for the local prototype, not a hostile-code sandbox. A microVM/container executor with kernel-enforced network and filesystem policy remains the production substitution.

## D017 — Live DSH proves the seam, not control-plane authority

The opt-in live smoke permits one DeepSeek V4 Flash request, one `kernl_validate_change` tool attempt, zero provider retries, 512 output tokens, read-only sandbox policy, and redacted output. It uses a temporary DSH home and verifies Cordis disposal and unchanged upstream Git status. This proves the model-to-Kernl tool route without giving DSH approval, promotion, task-state, effect-recovery, or shared-worktree authority.

The main deterministic demo remains the acceptance baseline. Wiring a DSH-produced mutation through Kernl's atomic claim, scope authorization, isolated worktree, and verification path is a next-alpha task, not a claim of this prototype.

## D018 — Promoted execution is explicitly bounded and replays lifecycle

The promoted artifact sets maximum agents, tasks, steps, parallel mutations, repair attempts, model requests, deterministic model spend, wall time, and a timeout on every step. The executor checks limits at step boundaries, binds before/current/replacement AIR digests, repeats the expected failure and scoped repair, executes the queue replacement lifecycle in a fresh durable ledger, and emits a replay-specific evidence manifest.

The deterministic adapter spends zero model dollars by construction. Live DSH remains a separately capped one-request smoke; its model output cannot be promoted directly.

## D019 � Catalog manifests are the only source of component knowledge

Component capabilities, binding rules, contracts, source ownership, generation templates, verification gates, lifecycle policy, replacement compatibility, effects, and approvals live in versioned manifests. The engine reads manifests, never component names. Source: Alpha V2 packages/core/src/catalog.ts.

## D020 � Validation and compilation share one deterministic path

compileDraft is the only draft semantics; alidateDraft reports exactly what compilation would do. Divergent validators cannot drift. Drafts compile to new immutable AIR versions; edits after locking are refused by the ledger.

## D021 � Declared verification drills, never inferred defects

The deterministic adapter applies a scripted first-candidate defect only when the draft declares expectedFailure (fingerprint, target step, authorized scope) or when an honest catalog recipe exhibits one. Defect application is a ledger event. Scenario two's defect compiles cleanly and fails only its contract gate.

## D022 � Replay binds the plan identity

Promoted schema-2.0 workflows persist planId and planDigest. Replay recompiles the plan from static inputs and requires a byte-equal digest before executing, proving promotions are deterministic and self-contained.

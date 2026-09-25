# Kernl next full iteration — goal prompt

@goal

Build the next runnable Kernl alpha on this repository. Keep the current tested architecture-to-code-to-evidence loop working, and close the largest remaining trust gap: **a live-generated candidate must be replayable from captured, approved code and exact tool inputs, without another model call or mutable recipe lookup**.

Before implementation read `PRODUCT_HANDOFF.md`, `PROVIDERS.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `NOW.md`, the product evidence packs and tests. Treat historical V1/V2 completion claims as hypotheses. Preserve original D: DeepSeek outputs and DSH upstream. Work in a new `codex/` branch; no cloud publication or credential changes.

First 20-minute action: take the passing live run identified in `PROVIDERS.md`, map every implemented/repaired task to its frozen mutations and commit, and write a failing ordinary replay test that requires a fresh isolated repository to produce the same source-tree digest with a transport that refuses all network calls.

Implement in short, runnable increments:

1. Capture an immutable source baseline and per-task code patch/content bundle in the sealed evidence pack. Bind exact baseline/candidate tree digests, tool/runtime versions, gate inputs, task dependencies and scopes. A patch must not carry new authority.
2. Implement static captured-code replay, not recipe regeneration. Validate the approved artifact and its bindings, reconstruct code in isolated workspaces, rerun the same deterministic gates and compare source-tree/evaluation results. Do not claim replayed commit IDs are identical when timestamps or parents differ. Keep ledger replay and execution replay visibly distinct.
3. Extend recovery tests to interrupted publication and an actual process restart. Freeze publication inputs; recover without replacing approved bytes, repeating a model request, resetting repair budgets or duplicating effects. Prove stale execution owners cannot continue mutating after fencing.
4. Replace V2's model-only provider transition with a small executable local queue-provider lifecycle. Demonstrate existing consumer reliance while retiring, rejection of new bindings, drain, actual cleanup receipt, and inactivity only after zero reliance/cleanup. Do not add Kafka or cloud infrastructure.
5. Connect the existing out-of-tree DSH mutation proposal seam to the same validated provider interface and ledger. Retain DSH sessions as trajectory provenance, never hidden control commands. Keep direct provider stubs as offline regression fixtures.
6. Improve component editing with a small catalog-backed form and before/after graph interaction. Require the client to name the exact evidence digest for approval; eliminate the compatibility route's implicit-digest approval. Show changed files, failed gate ownership, lifecycle state, recovery state and replay results from persisted data.

Limits: at most two independent mutators, three repairs, explicit task/request/token/time budgets; provider-side monetary limits before sustained live trials. Do not use or print credentials outside the provider transport. Do not add arbitrary shell execution, weaken tests, broaden write scopes during repair, simulate missing infrastructure as success, or label local worktrees a security sandbox.

Verification: keep all existing suites passing offline. Add property tests for lifecycle/recovery invariants, a complete captured-live-output replay test using a deterministic transport fixture, a browser journey, and a clean Windows checkout/export check. Preserve initial failures alongside improvements. Use ordinary defensive/functional tests; do not develop exploit inputs.

Deliver source, updated setup commands, schemas, migration, sealed evidence, exact command outputs, measured acceptance table, and sanitized export. Update `NOW.md` with one 15–25 minute action at every handover. Complete only when the captured-code replay and executable provider retirement can be demonstrated locally. State any remaining blocker precisely instead of claiming a solid/production-ready product.

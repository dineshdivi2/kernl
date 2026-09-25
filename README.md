# Kernl — architecture-to-software control-plane prototype

See [concept and verified status](PUBLIC_STATUS.md) for the dated distinction between working prototype and planned capabilities.

## Current iteration — September 12, 2026

Start with [PRODUCT_HANDOFF.md](PRODUCT_HANDOFF.md). This iteration fixes OX Alpha V2's candidate/evidence binding, adds recoverable Git operations and provider clients, and replaces API-only authoring with an architecture workspace. This is a **trusted local alpha**, not a production sandbox or a general architecture compiler.

In PowerShell 7, with Node 22.19+, Git and Corepack available:

```powershell
pwsh -NoProfile -File .\scripts\start-local.ps1
```

Open http://127.0.0.1:43120. Select **New architecture change → Save, validate & compile → Execute reviewed plan → Evidence**. Edit architecture operations, contracts and verification policy, not a code-generation prompt. Inspect generated code and sealed evidence before approval. Executed drafts stay locked; use **Save as new change**.

The matching command-line product demo is:

```powershell
corepack pnpm product:demo -- --approve local-validation-architect --replay
```

Without `--approve`, it stops at the human approval gate. The explicit actor above is a demo/test approval, not a claim of actual user review. This command exercises the product/V2 engine; the retained `demo` command below exercises V1.

```powershell
corepack pnpm providers:smoke
corepack pnpm providers:smoke -- --live
corepack pnpm product:demo -- --provider deepseek
corepack pnpm product:demo -- --provider openrouter --model deepseek/deepseek-v4-flash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm dsh:smoke
```

Only the explicit live/provider commands send inference requests. Credentials come from the launching environment, never the UI. See [PROVIDERS.md](PROVIDERS.md) for variables, caps and the Hermes access limitation. Live-generated workflows are deliberately refused by recipe replay.

Startup and the product demo use `data/product-alpha.sqlite` unless `KERNL_DB` is supplied. Source exports do not include dependencies. `-Offline` startup requires an existing pnpm cache; a fresh machine installs from the lockfile online once, then runs deterministic tests without inference access.

Next implementation contract: [NEXT_ITERATION_GOAL.md](NEXT_ITERATION_GOAL.md). The older instructions below are historical references; the current handoff supersedes their broad generic-generation, live-replacement and completeness claims.

## Original V1 walkthrough (retained)

Kernl lets a solution architect change a system at the component, contract, binding, version, and policy level. A bounded agent adapter implements the resulting task graph in isolated Git worktrees; deterministic gates—not the model—decide whether the candidate is eligible for human-approved promotion.

This repository proves one vertical slice locally:

```text
sync API -> worker -> store
             becomes
API producer -> queue v1 -> worker consumer -> store
```

The first generated worker intentionally mishandles duplicate event delivery. Kernl detects the failure, compiles a repair limited to `src/worker.ts`, applies it in a fresh worktree, reruns every gate, exercises queue v1 retirement and queue v2 activation, requests approval, emits a static workflow, and reconstructs the run from durable events and effect receipts.

No API key or network connection is needed for the default demo.

## Requirements

- Windows PowerShell 7 (`pwsh`)
- Git
- Node.js 22.19 or newer
- Corepack

This workspace already contains the verified portable Node.js 22.23.1 runtime and pnpm cache. In a new PowerShell session:

```powershell
$NodeRoot = 'C:\path\to\workspace\tools\node-v22.23.1-win-x64'
$env:PATH = "$NodeRoot;$env:PATH"
Set-Location 'C:\path\to\workspace\architecture-control-plane-startup\kernl-prototype'
node --version
corepack pnpm --version
```

The expected versions on the validated machine are Node `v22.23.1` and pnpm `11.7.0`.

## Start the application

One command installs from the existing offline store, builds the packages and UI, and starts the local server:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-local.ps1 -Offline
```

Open [http://127.0.0.1:43120](http://127.0.0.1:43120). The dashboard is a projection of SQLite and evidence data; it does not synthesize a success state in the browser. Press `Ctrl+C` to stop the server.

If the local pnpm cache is not available, omit `-Offline` to let pnpm fetch packages:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-local.ps1
```

For UI/API development, after installing dependencies:

```powershell
corepack pnpm dev
```

The API listens on port `3001`; Vite prints its UI port.

## Run the deterministic proof

The approval actor is explicit. This single command creates and promotes a new run:

```powershell
corepack pnpm demo -- --approve local-architect --role architect
```

It prints the run ID, base and candidate commits, verification digest, workflow digest, evidence-manifest digest, and artifact directory. The run takes roughly one minute because it creates real repositories and executes the fixture compiler and tests twice.

To observe the approval boundary instead, omit the actor:

```powershell
corepack pnpm demo
```

That run stops in `AWAITING_APPROVAL`. Start the app and approve that exact run through the UI or call:

```powershell
$Body = @{ runId = '<run-id>'; actor = 'local-architect'; role = 'architect' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:43120/api/approve' -ContentType 'application/json' -Body $Body
```

Replay the authoritative ledger after closing and reopening SQLite:

```powershell
corepack pnpm replay -- --run <run-id>
```

The report must show `stableAcrossRestart: true` and `effectsReexecuted: 0`.
Add `--full` to include the complete reconstructed task, approval, binding, effect, and promotion projection.

Replay the promoted static workflow in deterministic mock-agent mode, without the originating conversation:

```powershell
corepack pnpm workflow:replay -- --workflow .\artifacts\demo-run\promoted-workflow.json
```

## Verify the repository

```powershell
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm dsh:smoke
```

The test suite covers strict AIR validation, affected-subgraph/DAG compilation, durable SQLite replay, evidence-bound approvals, effect idempotency conflicts, redaction, lifecycle property tests, server contracts, the persisted UI projection, and the DSH seam. The end-to-end test creates real Git worktrees and reproduces the fail/repair/pass sequence.

The complete local verification sequence is also available as:

```powershell
corepack pnpm verify
```

## DSH integration

`packages/dsh-plugin` is an out-of-tree Cordis bundle. It exposes only the bounded model-facing operations:

- `kernl_validate_change`
- `kernl_compile_plan`
- `kernl_claim_task`
- `kernl_record_result`
- `kernl_verify`

Approval and promotion are deliberately absent from the tool surface. DSH records the model-visible trajectory; Kernl owns AIR, task authority, write scopes, verification, effects, approval, and promotion.

Run the fake-Cordis/HTTP seam test:

```powershell
corepack pnpm dsh:smoke
```

Run the keyless compatibility test against the installed DSH checkout:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\packages\dsh-plugin\scripts\smoke-real-dsh.ps1
```

That script uses a unique temporary `DSH_HOME`, removes the model key from child environments without printing it, loads the real DSH source CLI, calls the Kernl validation tool through the real tool pipeline, observes Cordis disposal, checks the upstream Git status is unchanged, and deletes only its verified temporary directory.

Live model mode is optional and never part of deterministic CI. If `DEEPSEEK_API_KEY` is already present, run exactly one bounded model request and at most one validation-tool dispatch:

```powershell
pwsh -NoProfile -File .\packages\dsh-plugin\scripts\smoke-real-dsh.ps1 -LiveDeepSeek
```

The live script uses DeepSeek V4 Flash, zero provider retries, at most 512 output tokens, a read-only DSH sandbox policy, redacted output, and a temporary DSH home that is deleted on success or failure. Do not paste a key into arguments, chat, logs, fixtures, SQLite, or Git.

## What is persisted

- `data/kernl.sqlite`: AIR versions, runs, tasks, events, approvals, bindings, effect receipts, and promotion records. It is intentionally ignored by Git.
- `.kernl/runs/<compact-run-key>`: integration repositories and isolated task worktrees. Keys are deterministic hashes of durable run/task IDs, keeping Windows paths bounded while the full IDs remain in SQLite and evidence. The directory is intentionally ignored by Git.
- `artifacts/runs/<run-id>`: immutable per-run evidence retained locally and ignored by Git.
- `artifacts/demo-run`: a sanitized, byte-identical committed copy of the latest canonical promoted run.

The evidence directory contains the AIR before/after/replacement versions, semantic diff, rejected invalid binding, compiled task DAG, first failing report, final passing report, Git patch and commit references, lifecycle trace, effect ledger, events, approval, promoted workflow, workflow-replay evidence manifest, replay reports, secret scan, and a SHA-256 manifest. Machine-specific checkout and user paths are exported as stable tokens such as `<KERNL_ROOT>`.

`evidence-core.json` is the immutable pre-approval evidence pack the approval and promotion bind to. Its event trajectory is `events-preapproval.jsonl`; that file is never overwritten. `evidence-manifest.json` additionally indexes post-decision records such as the approval, promotion, static-workflow replay, final event log, and ledger replay; its digest is reported separately.

The manifest labels its SQLite export cutoff as `BEFORE_EVIDENCE_FINALIZATION_AND_CANONICAL_PUBLICATION`: the act of sealing and publishing that pack adds two later receipts to the authoritative SQLite ledger. `pnpm replay` therefore reports the complete post-publication count, while the sealed pack remains a non-self-referential snapshot.

## Architecture and package map

```text
apps/web                 persisted architecture/run dashboard
apps/server              local HTTP API and static UI host
packages/core            AIR, compiler, lifecycle, SQLite ledger, replay
packages/runtime         agent policy, worktrees, gates, promotion, evidence
packages/dsh-plugin      out-of-tree DSH provider/consumer bundle
fixtures/air             versioned intended architecture
fixtures/job-system-*    synchronous service compiled by the demo
tests                    unit, property, API, UI, integration, end-to-end
artifacts/demo-run       inspectable canonical evidence
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the authority boundaries, [DECISIONS.md](./DECISIONS.md) for how the implementation maps to the prior Kernl/DSH/Cordis work, and [VERIFICATION.md](./VERIFICATION.md) for exact final commands and evidence identifiers.

## Acceptance evidence

| Claim | Executable or artifact evidence |
| --- | --- |
| Graph/AIR change, not a code prompt | `fixtures/air/before.json`, `after.json`; `air-diff.json` |
| Invalid binding rejected before agents | `invalid-binding-rejection.json`; `INVALID_AIR_REJECTED_BEFORE_AGENTS` in `events-preapproval.jsonl` |
| Derived DAG with dependencies/write scopes | `task-dag.json`; core DAG tests |
| Real isolated code changes | `.kernl/runs/<compact-run-key>/tasks`; `change.patch`; `commits.json` |
| Deliberate failure and scoped repair | `verification-attempt-1.json`; repair task/event; `verification-report.json` |
| Public API and behavior preserved | baseline and final `unit`/`contract` gates |
| Safe provider replacement | `lifecycle-trace.json`; lifecycle property tests |
| Durable idempotent replay | `replay-report.json`; SQLite restart test |
| Exact promotion binding | `promotion.json`; `promoted-workflow.json`; evidence-bound approval test |
| Static workflow re-execution | `workflow-replay-report.json`, `workflow-replay-evidence.json`; workflow replay test |
| Offline, secretless deterministic CI | full test command; `secret-scan-report.json` |
| UI displays real state | server state tests; `apps/web/src/App.test.tsx` |

## Prototype limits

- The deterministic adapter is intentionally scripted; it proves control flow, isolation, repair, and evidence—not general code-generation quality.
- Local Git worktrees isolate writes but are not hostile-code security sandboxes.
- Generated-code verification receives an allowlisted environment with no model credentials and a loopback-only Node network guard. Kernel-enforced isolation remains an alpha/production substitution.
- SQLite and a single local coordinator prove durable semantics, not distributed scheduling or HA.
- The durable ledger reconstructs state and suppresses repeated idempotency keys; recovery classifications and compensation metadata are persisted, but a general distributed compensation executor is not part of this local prototype.
- The queue fixture is in-memory; provider versions demonstrate architectural lifecycle, not Kafka operations.
- The current DSH workflow worker has no authoritative journaling/resume or independent child working directories, so Kernl does not delegate those responsibilities to it.
- The optional live DSH smoke proves one bounded model-to-Kernl validation-tool route. The main architecture-to-code demo remains deterministic and does not yet persist a live DSH session or accept live-model mutations.
- The UI uses a React-owned SVG graph and the API uses Hono because the proposed React Flow/Fastify packages were absent from the verified offline cache. Both sit behind narrow boundaries.
- Node's built-in SQLite module still prints an experimental warning in Node 22.
- No authentication, tenancy, billing, marketplace, cloud deployment, or production write path is included.

The local approval request requires an explicit actor plus the AIR-required `architect` role assertion. This exercises gate/role enforcement, but it is not authentication or RBAC; a user-testable alpha must bind the assertion to an authenticated identity.

The smallest next product step is to let one external solution architect edit the three-component graph, review the generated task scopes and failed repair evidence, and decide whether the abstraction is clearer than reviewing an AI coding chat.

## Alpha V2 � architecture-first control plane

Alpha V2 adds the product layer on the same verified engine: a versioned component catalog, persisted architecture-change drafts, generic plan compilation over a static step vocabulary, catalog-recipe agents in isolated worktrees, catalog-driven verification with scoped repairs, evidence-bound approval **and rejection**, schema-2.0 promoted workflows, static replay, and a seven-view control-plane UI beside the classic dashboard.

- Read [ALPHA_V2_BASELINE.md](./ALPHA_V2_BASELINE.md), [ALPHA_V2_ARCHITECTURE.md](./ALPHA_V2_ARCHITECTURE.md), [ALPHA_V2_USER_TEST.md](./ALPHA_V2_USER_TEST.md).
- API: /api/v2/catalog, /api/v2/drafts, /api/v2/drafts/:id/validate|compile|run, /api/v2/runs/:id/approve|reject.
- Curated evidence: rtifacts/alpha-v2/canonical-sync-to-queue, rtifacts/alpha-v2/canonical-retry-dlq.

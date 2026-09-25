# Kernl / OX Alpha output audit

Date: 2026-09-12. Scope: inspection, reproduction of existing deterministic checks, and product assessment. No fixes applied to the DeepSeek outputs or original Kernl checkout. No live model calls made.

## Verdict

**Useful engineering prototype; not a completed, trustworthy Alpha V2 product. Keep the work, but do not build more features on its current promotion/recovery assumptions.**

OX Alpha materially extended V1: persisted architecture drafts, a versioned catalog, a second change scenario, a plan/executor abstraction, rejection, and additional inspection views. A clean bundle clone installs offline, typechecks, builds, and passes the supplied tests.

However, independent inspection found two central integrity failures in the shipped evidence: V2 promotes the baseline Git commit instead of the implemented candidate, and promotion overwrites the pre-approval evidence while retaining the old approved digest. Passing tests do not establish the product's central AIR-to-code-to-evidence guarantee.

The strongest next step is **one correctly governed architecture change**, not more components, agents, or UI tabs.

## What was found and inspected

Original output root: `<historical-workspace>\Kernl`.

| Output | Assessment |
| --- | --- |
| `kernl-prototype/` | Substantial TS monorepo extension. D: HEAD is `2598eef`, with the final implementation release at `68bc532`; later changes are export documentation. Working tree was clean when inspected. |
| Final source ZIP and Git bundle | Both hashes match the release record; bundle verifies and clones. Release commit is `68bc532c0372c4e1ac756f6a17c2fe7b0f25bd1f`, 184 tracked files. |
| Timestamped V2 ZIP/bundle | Earlier export iteration; keep as history, use FINAL as the audit baseline. |
| Original `dcb1557` ZIP/bundle | V1 baseline retained. V2 diff against it: 79 files, 6,744 insertions / 329 deletions, including documentation and evidence, not just code. |
| `research/ALPHA_V2_RESEARCH.draft.md` | 25-product landscape, useful interaction ideas; all 25 per-product implementation decisions still say `pending decision`. Outside the release repo/export. |
| `verify-local.ps1` / `verify-local.log` | Workspace-specific driver and historical V1 verification. Log is dated Aug 21 and cannot by itself substantiate the final V2 release. Driver is outside the source ZIP and hardcodes the D: checkout. |
| V2 architecture/baseline/user-test/verification docs | Helpful map, but completion and generalization claims exceed the implementation. Several encoding artifacts and stale environment instructions. |
| Local generated evidence | 39 manifest-bearing pack directories; every indexed file passed SHA-256 checks. There are 35 V2 promotion-pack copies representing 32 unique runs. All 35 have the wrong-commit and changed-approved-core problems described below. |
| DSH sessions | Identified the main Kernl build session and competitor-research session. Inspected metadata and the build's final visible handoff, not private reasoning text. |

The main build is `[private DSH session]`; metadata records OpenRouter `stealth/ox-alpha`. Its final message declares Alpha V2 complete. Research session `[private DSH session]` includes OX Alpha and DeepSeek model references. These are provenance observations, not a model-quality benchmark or a billing measurement.

## Fresh verification performed

Disposable checkout: `C:\path\to\workspace\architecture-control-plane-startup\audits\deepseek-alpha-v2-20260912\repo`.

| Check | Result |
| --- | --- |
| Clone FINAL bundle | Passed; exact release commit `68bc532` |
| `pnpm install --frozen-lockfile --offline` | Passed; 107 reused, 0 downloaded |
| `pnpm typecheck` | Passed, five packages |
| Root Vitest suite, `--no-file-parallelism` | **76 tests / 17 files passed**, 208.16 seconds |
| Web tests | **2 passed**; these are the existing V1 UI tests, not V2 browser-journey coverage |
| DSH plugin tests | **7 passed** |
| `pnpm build` | Passed, including Vite production UI |
| `pnpm dsh:smoke` | `KERNL_FAKE_SMOKE_OK` |
| Final ZIP hash | `47B5353A402F8B50057BDC8A2A98FA600C2754615BB9618B0D94AAC4EEC7920A` |
| Final bundle hash | `F91991E33B67F240F2E0A02AA463136A1EEEA79BFB99620E4F19FA6644901104` |
| `git bundle verify` | Passed; complete history |

Root-suite count rose from V1's 51 to 76: 25 additional tests. They exercise real worktrees, compilation, failure/repair, API routes, and resume at an approval checkpoint. This is meaningful work, not merely generated scaffolding.

Tests were deliberately run sequentially: some new tests recursively clean shared `data`, `.kernl`, and `artifacts/runs` directories. Running them in parallel or against a user's active development instance is unsafe. All such test effects here were confined to the disposable audit copy. Rebuilding the tracked DSH distribution changed working-copy line endings there; no semantic source fixes were made.

Not verified in this audit: real browser interaction, full live DSH mutation, model cost/quality, mid-mutation crash recovery, an unrelated third application, or current external competitor capabilities. Historical `pwsh.exe` absence is no longer true in this audit environment: a bundled PowerShell 7 is available.

Raw evidence: `checks.log`, `check-results.json`, `artifact-audit.json`, `session-audit.json`, `session-final.json`. Reproducible audit helpers are adjacent to this report.

## Critical findings

### 1. P0 — Promotion points at unchanged baseline code

Observed in both canonical packs and all 35 V2 promotion-pack copies:

| Canonical scenario | Promoted / baseline commit | Final integration recorded in effects |
| --- | --- | --- |
| Sync to queue | `c1d1e1d81db882f61335629833bd7b76ab238a99` | `06cbefb33a99c68c0b1db5ad02b989d30c44662f` |
| Retry / DLQ | `3fb29d3c92a17578dc0abd7ce966214f7524d5cd` | `5cd2d8704d02841d5338ea3787d1d5d1bb0a48e7` |

Mechanism: `plan-executor.ts:205` sets the run's source commit to the baseline. `executeMutating` integrates changes but never advances this field. `promotePlanRun` uses `run.sourceCommit` at lines 709 and 718. The ledger checks consistency with its own stale value, not consistency with the actually verified Git tree.

The scenario-one test at `plan-executor-scenario1.test.ts:157` only checks that the provenance value has the shape of a 40-character hash. Its following supposed code-change assertion assigns `undefined` on both branches and asserts `undefined`.

Required fix: bind verification to the exact candidate commit and tree digest; assert that commit matches integration HEAD and differs from baseline for a nonempty change. Promote exactly that commit. Include the real patch or a recoverable fixture Git bundle in the evidence.

### 2. P0 — Approved evidence is overwritten during promotion

`materializeEvidenceCore` writes the five-file pre-approval pack at `plan-executor.ts:427`. At promotion, lines 698–703 rewrite those same files with later events and effects. Line 704 prefers the old supplied digest and never requires the newly computed digest to equal it.

For canonical sync-to-queue:

- Approved core: `aa57fe19a1468924a1147dc68f3a9b20e16b89e824a63e5a663e1d17caf14667`.
- Core recomputed from exported files using the implementation's own canonicalization: `0047086528c96017f6b986404287f99b173079c5d2ad94f1d2af17d4f8d48624`.

All 35 V2 promotion packs show this mismatch. Individual file hashes still match the *new* manifest, explaining why normal integrity checks pass. This is not evidence of malicious tampering; it is an implementation defect in evidence finalization.

Required fix: seal the pre-approval pack once, persist its file list and digest, revalidate it before promotion, and put post-decision events in a separate append-only pack. An approval must refer to bytes the architect can still retrieve.

### 3. P1 — Resume-at-approval is not crash-safe execution

Source-reviewed, not fault-injected in this audit:

- `executeMutating` performs worktree creation, writes, commit, and merge at line 249, then records receipts at lines 257–291. A process death in between leaves unrecorded external effects.
- On re-entry it recreates the same branch/worktree rather than observing and reconciling partially completed operations. A unique receipt key alone cannot prevent a prior filesystem action from being performed again.
- `putTask` clears claims on conflict (`ledger.ts:679–695`). Claims have no lease expiry or fencing token.
- Repair and verification counters reset to zero on every `run()` entry (`plan-executor.ts:490`). Completed steps are loaded, cumulative budget consumption is not.
- Wall-time/model limits and per-step timeout metadata are mostly declarations, not V2 executor enforcement. Gate subprocess timeouts do exist.
- The catch block returns `FAILED` without consistently persisting a failed run/task transition.
- Tests close and reopen SQLite after reaching approval; they do not establish recovery after a write, merge, or publication interruption.

Required fix: a durable operation state machine with planned intent, executor claim/fence, observed result, and committed receipt. Every effect adapter needs an observation/reconciliation method. Budget counters and terminal states must be ledger-owned. Test interruptions at each boundary against actual Git/filesystem state, not only receipt uniqueness.

### 4. P1 — Draft editing and locking are not reliable

`ledger.ts:1016–1031` updates a draft body but does not invalidate its compiled AIR digest or validation status. `setDraftStatus` accepts arbitrary transitions. The validate route unconditionally sets VALID/INVALID, including for a previously locked/decided draft (`v2.ts:293–300`).

Compiled AIR versions use only draft ID (`draft.ts:173`), not draft revision. Subsequent edits compete with an already immutable AIR version. The run route relies on the previously compiled digest (`v2.ts:329–342`). Approval recompiles the plan from current catalog/draft data instead of loading one immutable run snapshot.

Required fix: revisioned drafts; each edit invalidates derived artifacts; guarded transitions; atomic freeze of AIR, catalog, task plan, policies, and budgets; resume loads that snapshot. Test edit → compile → edit → recompile as a normal user journey.

### 5. P1 — Generalized orchestration still runs fixed application recipes

Good: the new plan vocabulary and catalog separate component knowledge from the old coordinator. Bad: that is not yet general architecture-to-code compilation.

- `recipes.ts:266–275` ignores request parameters and returns fixed `src/api.ts`, `src/worker.ts`, etc., with fixed imports. Component identity and bindings do not drive emitted code.
- `v2.ts:200` hardcodes `jobs-system`; run execution always starts from the same job-system fixture at line 342.
- Scenario two's intended base AIR is queued, but its executor test still supplies the synchronous fixture directory. There is no general AIR-to-source baseline conformance check.
- The planner recognizes removed components but does not emit a corresponding source removal/retirement implementation step for them (`plan.ts:202–204`).
- Repairs are two full-file replacements selected by gate ID/fingerprint, not model reasoning over a novel failure. That is appropriate for deterministic drills, but not proof of live repair ability.
- Repair authority is derived from the registered repair's output paths (`plan-executor.ts:475–477`), not independently intersected with the failing component's frozen ownership contract.
- Catalog descriptions promise a durable result store and deterministic backoff; the recipes are an in-memory Map and an immediate synchronous retry loop.

Required fix: either declare a deliberately supported recipe product, or parameterize recipes around instance IDs, source mappings, and actual bindings, then supply a bounded live adapter for deviations. Reject unsupported changes explicitly. Test another component instance and a different application's source layout without changing executor code.

### 6. P1 — Lifecycle proof is model-level, not a running provider replacement

`executeTransition` creates a fresh in-memory lifecycle snapshot (`plan-executor.ts:311`) and records transitions. Cleanup records `{ cleanedUp: true }` without invoking a queue cleanup implementation (lines 380–394). The snapshot is not a running queue service. Queues use `queueMicrotask`; there is no durable backlog, in-flight work drain, or real provider handoff.

Keep the pure lifecycle state machine and property tests. Label this a modeled invariant demonstration. To prove operational hot replacement, connect lifecycle transitions to real provider handles and active consumer leases, submit in-flight jobs, retire/rebind/drain, and verify no lost results.

### 7. P1 — Static replay is re-planning with current code

`workflow-replay-v2.ts:53–81` checks the workflow's self-digest and recompiles a plan from AIR, then executes that newly compiled plan. It does not dispatch the stored workflow steps. Catalog and source-template content, recipe implementation bytes, and tool implementation versions are not pinned as replay inputs. The default runtime catalog is loaded from today's checkout.

Plan-digest equality is useful, but insufficient to show that the code being executed is the promoted operation. The existing V2 replay test covers sync-to-queue, not the complete retry/DLQ sequence. `REPLAY_ASSERT` itself only rebuilds ledger projections and checks unique receipt keys; the UI describes more than that check proves.

Required fix: either execute the sealed workflow directly or verify exact equivalence to it, including pinned source/template/catalog/recipe/tool digests and execution budgets. Separate event projection replay, crash resume, and fresh workflow execution in APIs and UI; they are different promises.

### 8. P1 — The architect cannot yet author through the UI

`V2App.tsx:288` explicitly says authoring is API-first and the editor form is a future increment. The seven views are tables/panels, not an editable architecture canvas. Execution awaits the complete POST before storing a run ID (`131–137`), so there is no live task polling during that request. Run selection and compiled result are browser-local and not restored after refresh. The API returns only the last 40 events (`v2.ts:434`), hiding earlier failure and evidence events.

There is no V2 browser-journey test, clickable full diff/evidence explorer, or UI replay/export action. The final DSH handoff's claim that the architect opens the UI and authors a draft is contradicted by the source.

Required fix: one connected screen: load system → add queue/edit binding → validate → inspect affected graph and scoped diff → run with progress → review failure/repair → approve/reject → inspect/export exact evidence. Avoid seven independent views with disconnected context.

## Research usefulness

Use the research as a pattern library: model-driven views, before/after change review, evidence attached to tasks, explicit approval states. These are sensible directions.

Do not treat it as proof of defensible market whitespace. It is broad feature comparison, has no customer interviews or willingness-to-pay evidence, makes categorical absence claims about competitors, and leaves implementation decisions unresolved. External claims were not re-verified in this audit. Some suggested interactions were not built: graph authoring, full evidence drilldown, observed runtime topology.

Turn it into a short decision log: observation/source/date → precise hypothesis → product decision → shipped mechanism → acceptance check. The question to validate is whether architecture-level review reduces effort and mistakes for a specific team, not whether Kernl has more boxes than adjacent tools.

## Keep / harden / defer

| Keep | Harden or replace | Defer |
| --- | --- | --- |
| AIR/contract vocabulary and typed schemas | V2 commit/evidence promotion path | Additional component catalog breadth |
| Pure lifecycle state machine and property tests | Durable effects, claims, resume, budgets | Larger agent teams |
| Semantic diff and explicit task scopes | Draft revision/freeze semantics | Generic all-language support |
| SQLite ledger, event/effect separation | Frozen workflow execution/provenance | Multi-tenancy, billing, marketplace |
| Git worktree isolation helpers | Live bounded DSH mutation adapter | Distributed scheduling/cloud infrastructure |
| Deterministic fixtures and failure drills | Parameterized component recipes and conformance gates | Universal self-building software claims |
| Out-of-tree DSH provider/consumer seam | One usable architecture-change journey | More competitor lists without user tests |

V1 and V2 currently have parallel coordinator/verifier/promotion/replay paths. Do not force an immediate rewrite; first establish failing acceptance checks and port V1's stronger guarantees into V2, then converge the engines behind those tests.

## Recommended next iteration

Target user hypothesis: a technical lead or solution architect evolving an existing small TypeScript job-processing service. Target change: synchronous job handling → queued processing with bounded retry and inspectable failure handling. This is a proposed focus to validate with users, not established market demand.

1. **Trust repair.** Correct commit provenance; freeze approved evidence; preserve and test immutable run snapshots. Acceptance: every promoted commit is the verified candidate, and every approved digest remains reproducible from the same bytes. No promotion on inconsistency.
2. **Recoverable execution.** Operation intents, reconciliation, fenced claims, durable budgets, consistent terminal states, and targeted test cleanup. Acceptance: interruption before/after each effect resumes safely or stops with an explicit recoverable condition; receipt counts are checked against real resource state.
3. **One real architect journey.** Add graph/form authoring and revisioning, before/after views, live persisted progress, full diff and evidence review, explicit local approval, restart/reopen. Acceptance: a person completes the scenario from an empty local database without manual API calls.
4. **One bounded live DSH mutation.** Use the frozen plan, exact scopes, isolated worktree, independent verifier and capped repair budget. Log model/tool/prompt/session provenance without secrets. Keep deterministic CI as the control. Do not infer authority from DSH events. Acceptance: one actual model-produced change and one repair are evaluated independently; any unavailable credential/runtime dependency is an explicit blocker, not a simulated success.
5. **Falsify generality and usefulness.** A second component instance or different source layout must work without executor changes. Then run the product with three external technical users. Measure completion, review time, unassisted steps, escaped defects, and evidence comprehension—not lines generated or agent count.

No need for Kubernetes, Temporal, SaaS authentication, or a production queue to complete steps 1–3. Keep local approval explicitly local; add authenticated identity only when the deployment boundary requires it. Do not expose the current local worktree runner as a hostile-code sandbox.

### Exact first next action (20 minutes)

Add an independent acceptance check that compares the promoted commit with the final integration commit and reconstructs the approved evidence digest from its sealed files. Run it against both canonical packs and observe both failures. Then repair those two invariants before any UI or catalog expansion. This audit already supplies the read-only observations needed to specify those tests; implementation is not part of the present audit.

## Reproduction commands

From this audit folder, existing-check reproduction:

```powershell
& 'C:\path\to\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe' -NoProfile -File .\run-checks.ps1
```

The exact commands and outputs for the completed run are in `checks.log`; per-check exit codes and durations are in `check-results.json`. The script runs only inside the disposable `repo` folder.

Read-only evidence audit against the original outputs:

```powershell
& 'C:\path\to\workspace\tools\node-v22.23.1-win-x64\node.exe' .\inspect-artifacts.mjs '<historical-workspace>\Kernl\kernl-prototype'
```

Source inspection references in this report are relative to the original D: release repository. All findings have been separated into observed artifact/test facts and source-reviewed risks. No performance, security, production-readiness, or live-model-quality claim is inferred from green deterministic tests.

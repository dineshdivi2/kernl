# Kernl product-alpha handoff — 2026-09-12

Later local changes: [Architecture authoring iteration — 2026-09-13](AUTHORING_ITERATION.md). The results and limitations below describe the earlier release, not a fresh verification of historical runs.

## Outcome

This is a working local iteration, not a production-ready product. A solution architect can load/edit an architecture change, inspect its affected components and write scopes, execute it, observe an actual failure and scoped repair, review the real code diff, and approve the exact verified candidate. The UI recovers selected runs after reload and displays persisted events/effects rather than a scripted success screen.

The direct DeepSeek implementation path now works as well as the deterministic recipe adapter. The passing live candidate remains awaiting the user's approval. OpenRouter has a verified live transport smoke and offline adapter coverage. The Nous adapter exists, but the available endpoint/model list did not expose a Hermes model.

## What we kept from OX Alpha

V2 release `68bc532c0372c4e1ac756f6a17c2fe7b0f25bd1f` was a useful extension: persisted drafts, ten catalog manifests, semantic diff/compiler, two scenarios, rejection, and real tests. The independently reproduced baseline passed 76 root tests, two UI tests, seven DSH tests, typecheck/build and mock smoke. It was not merely scaffolding.

However, all 35 inspected V2 promotion-pack copies referenced the baseline commit, and their approved pre-approval files had been overwritten. That broke the central AIR → code → evidence guarantee despite passing supplied tests. The original D: outputs and prior V1 main branch were preserved. This iteration lives on `codex/kernl-product-alpha` in the C: repo.

The 25-product competitor research was useful idea collection, but all implementation decisions were still pending; it did not prove product readiness. We prioritized a falsifiable vertical slice over more catalog entries or an unbounded swarm. Full prior audit: `docs/DEEPSEEK_ALPHA_V2_AUDIT.md` (historical audit).

## Material improvements

- Candidate commit is advanced after each integration; verification binds that exact commit; promotion requires a clean matching HEAD.
- Approved evidence files are sealed and re-hashed, never overwritten by post-approval events. The pack includes the real source diff, catalog, verification and execution fingerprints.
- Edited drafts invalidate stale compilation, compile to content-versioned AIR, and cannot be unlocked after execution. Approval/resume uses frozen run inputs.
- SQLite operation intents precede worktree mutation; recovery reconciles writes/commits/merges. Expiring run leases and epoch checks prevent concurrent execution ownership. Repair/request counters persist across resumes.
- Deterministic and DeepSeek/OpenRouter/Nous JSON clients share scope/secret enforcement. Offline stubs exercise the real transport boundary; live inference never gets approval authority.
- Cross-component verification failures are repaired in the effect owner's declared scope, not blindly in the component whose gate discovered the failure.
- New UI: architecture authoring, before/after graphs, exact contracts/bindings, task dependencies/scopes, provider choice, run history, complete gate output, effect ledger, candidate diff, evidence-bound approval/rejection and snapshot download.

## Evidence and measured commands

PowerShell working directory: repository root. Node used: `v22.23.1`, portable sibling runtime. For commands below, the exact pnpm entry point used was `node C:\path\to\pnpm.cjs`; child pnpm launchers reported the installed local version. `corepack pnpm` is the portable user-facing equivalent.

| Command/check | Observed output |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run --configLoader runner --no-file-parallelism` | `Test Files 19 passed (19); Tests 87 passed (87)` before the additional failure-owner regression |
| Focused final recovery/replay/scenario/repair-owner suite | `Test Files 4 passed (4); Tests 8 passed (8)` |
| `pnpm typecheck` | Core, runtime, server, web and DSH packages passed |
| `pnpm build` | All packages passed; production Vite UI built |
| `pwsh -NoProfile -File packages/dsh-plugin/scripts/smoke-real-dsh.ps1` | `KERNL_REAL_DSH_SMOKE_OK`; temporary profile loaded/unloaded the plugin; upstream Git status unchanged |
| `node node_modules/tsx/dist/cli.mjs scripts/provider-smoke.ts --live` | DeepSeek passed; OpenRouter passed; Nous requested model selection, no available Hermes IDs |
| Initial `product-demo.ts --provider deepseek` | FAILED at three repairs; retained as regression evidence, not hidden |
| Fresh `product-demo.ts --provider deepseek` after fix | AWAITING_APPROVAL, four model requests, one repair, five verification passes/attempts including initial failure |
| `product-demo.ts --approve release-validation-architect --replay` | PROMOTED; static replay PROMOTED, content/plan digests matched, zero duplicate effects, 15 effects |
| Browser journey at loopback | Loaded draft, compiled graph change, ran repair drill, displayed real diff, approved as `ui-validation-architect`, showed PROMOTED; reload recovered the selected run |

The preceding deterministic replay used run `run-2026-09-12T08-53-59-389Z-dda418a7`, candidate `ebe4403ae929d197fc93f6091e461f179e1952c2`, workflow `a135374a2460517c25cd3c940b07a4a8b0883a2c33c2e833f636ce4936e884d0`, replay `replay-a517d2ef`. Runtime fingerprints subsequently gained newline normalization for Windows export portability; the release check below must use a fresh run.

Passing live run: `run-2026-09-12T08-50-36-229Z-851960f9`; candidate `9665fd3b69bddd2c33dfc60ccbf7ffc6bea217d2`; AIR `air-draft-ccde2fdff3477ed225fe56d6`. Curated evidence is in `artifacts/product-alpha/`, including the failed first trial and the successful unapproved live candidate. Full runtime state remains local in `data/product-alpha.sqlite`, which is intentionally not exported.

## Remaining limitations — do not silently upgrade these claims

1. Architecture editing is currently structured JSON with a graph projection, not drag-and-drop authoring. Recipes support the small jobs-system catalog, not arbitrary repositories or languages.
2. Direct live provider calls are not the full DSH mutating-agent path. The real DSH plugin load/unload seam passed; full DSH implementation orchestration remains next iteration.
3. Live-generated candidates cannot yet be reproduced by captured-code workflow replay. Recipe replay refuses them. Ledger replay still reconstructs their recorded state.
4. V2 replacement is a persisted lifecycle model, not a running hot-swap deployment. Core property tests establish state invariants, not operational queue durability. The fixture queue/store are in-memory.
5. Git worktrees and allowlisted processes are not an OS sandbox. Do not ingest hostile repositories or run adversarial generated code. Local role strings are not authentication; server binds loopback only.
6. No guaranteed USD spend ceiling, rate limiter, production kill-switch, arbitrary-effect compensation, general concurrent scheduler, or proof that every declarative assertion is executed. Request/token/time/repair limits are bounded; the maximum is not a claim of exhaustive enforcement of the original specification.
7. Recovery tests cover normal task interruption and ledger reopen. This is not a power-loss/distributed exactly-once proof. Historical V1/V2 evidence stays historical and is not retroactively certified by new checks.
8. Source export requires dependency installation/cache and a supported Node runtime. Model keys, SQLite/worktrees, private DSH session logs and node_modules must not enter the ZIP.

## Smallest next step

Run one architect walkthrough using the saved live candidate and ask whether intent, dependency changes, failed-gate ownership and approval evidence are understandable. Then implement captured-code replay before adding more component types. `NEXT_ITERATION_GOAL.md` is the full bounded goal prompt.

## Final release verification

Final clean-export results and checksums are recorded in `RELEASE_CHECKS.md`.

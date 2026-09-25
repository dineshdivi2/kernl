# Alpha V2 user-test guide and results

This document is both the script for the first external solution-architect test and the record of the author's own end-to-end pass.

## One-command start (verified environment)

```powershell
# from the repository root
node node_modules\typescript\bin\tsc -p apps\web\tsconfig.json --noEmit   # optional check
pwsh -File ..\..\verify-local.ps1    # session driver replicating `corepack pnpm verify`
node node_modules\tsx\dist\cli.mjs apps\server\src\index.ts   # serves UI + API on :3001
```

On the original validated machine the documented path still works unchanged: `scripts/start-local.ps1 -Offline`, then open `http://127.0.0.1:43120`.

## The journey an architect performs

1. **System overview** — open the UI ("Architecture control plane" mode). Inspect the component catalog: seven component kinds, exact versions, capability binding rules, recipes, gates.
2. **Draft** — create a change draft through `POST /api/v2/drafts` (component ops, contract changes, requested gates, optionally the declared verification drill). Edit freely while `DRAFT`/`VALID`.
3. **Validate** — invalid bindings/components are rejected with structured issue codes before anything runs (`NO_PROVIDER`, `COMPONENT_EXISTS`, `BINDING_REJECTED_BY_CATALOG`, …).
4. **Compile** — produces a new immutable AIR version, the affected subgraph, and per-component change reasons.
5. **Execute** — one call runs the whole compiled plan: isolated Git worktrees, catalog recipes, catalog-driven gates. Watch tasks, statuses, attempts in Execution view.
6. **Verification** — see the honest first-candidate failure (fingerprint + failing gate) and the scoped repair that fixed it, limited to the compiled write scope.
7. **Approval** — approve (actor + `architect` role) or reject with a reason. Rejection persists the reason, cancels the run, keeps the candidate inspectable, and frees you to draft again.
8. **Evidence & replay** — evidence-core digest, promotion workflow digest, candidate commit; the promoted workflow later replays from static inputs alone (fresh database, byte-matching plan digest, zero duplicate effects).

## Author's self-test result (this iteration)

Executed twice via `tests/server/v2.test.ts` against a temp SQLite and once per scenario via the executor E2E tests:

- sync→queue: validate ✓ → compile ✓ → execute (real tsc/unit/contract/idempotency gates; duplicate-event failure observed; repair confined to `src/worker.ts`) → suspended at approval across a SQLite restart → approved → promoted; replay of the promoted workflow reproduced the drill and passed with 0 duplicate effects.
- retry/DLQ + queue v2: same flow plus a live provider transition — queue@1.0.0 RETIRING rejected a new binding, both consumers rebound exactly once, reliance reached 0, cleanup receipt committed, @1.0.0 INACTIVE, @2.0.0 ACTIVE; the declared dead-letter defect failed `dlq-contract` and its scoped repair restored the contract.
- rejection path: reason persisted on the ledger, run CANCELLED, no promotion record, draft `REJECTED`, candidate inspectable.

Confusion points noticed while testing (to probe with the external architect): the difference between draft status `VALID` vs `LOCKED`; why the drill declaration is optional; where the affected-subgraph reasons come from.

## Blockers / limitations found on this machine

1. **Real-DSH smoke could not be re-run here**: this workstation has no Windows PowerShell 7 (`pwsh.exe` absent), and the smoke script requires it (`ProcessStartInfo.ArgumentList`). The plugin sources are unchanged since Alpha V1, whose verified record stands: `KERNL_REAL_DSH_SMOKE_OK` (77.7 s) in `VERIFICATION.md`. Exact blocker: missing `pwsh.exe`; remedy: install PowerShell 7 and run `packages\dsh-plugin\scripts\smoke-real-dsh.ps1`.
2. **Live DeepSeek mode** was exercised during Alpha V1 development (one request, redacted output) and deliberately stays outside deterministic acceptance.
3. This workspace's D: drive is space-constrained and `pnpm install` cannot run inside the agent sandbox (store index needs writes outside the workspace); `node_modules` is reconstructed deterministically (see ALPHA_V2_BASELINE.md).

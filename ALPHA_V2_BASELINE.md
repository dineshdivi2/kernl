# Alpha V2 baseline

Recorded 2026-08-21 from the restored Alpha V1 prototype. This document fixes the validated starting point for the Alpha V2 iteration: what works, what is verified, what constrains the next iteration, and the exact commands that reproduce every claim.

## Provenance

- Source: Git bundle `Kernl/kernl-prototype-history-dcb1557.bundle`, head `main` at `dcb1557ea063c90897f9fc268922a7d7f45cb134` (single commit, "feat: build runnable Kernl architecture control plane prototype").
- Working clone: `Kernl/kernl-prototype` inside the session workspace (`<historical-workspace>`), cloned from the bundle with full history; tree clean before any Alpha V2 change.
- The original checkout at `C:\path\to\workspace\architecture-control-plane-startup\kernl-prototype` remains untouched as a second copy of the same baseline commit.
- Toolchain used here: Node `v22.23.1` (on PATH), pnpm `11.7.0` (invoked directly from the Corepack cache when needed), Git 2.39.2.Windows.1.

## Environment constraints discovered during restore

These are properties of the current agent workspace, not of Kernl:

- The D: drive has very little free space (a full pnpm-store copy attempt filled it; ~1 GB was recovered by deleting the partial copy). `node_modules` was therefore rebuilt in place: 113 MB of real package bytes copied once from the original checkout plus 367 junctions recreated with prefix-mapped absolute targets (`rebuild-node-modules.ps1`, `rebuild-package-links.ps1`). `pnpm install` cannot run in this environment because pnpm 11 opens its SQLite store index read-write and the store lives outside the writable workspace.
- The sandbox denies child-process spawns over piped stdio (`EPERM`) unless escalated; vitest/vite/tsx/git flows run under an approved escalation. A driver script must never treat native stderr as a terminating PowerShell error (Node's SQLite experimental warning otherwise kills scripts).
- Vitest must run with `--no-file-parallelism` here; parallel worker forks died silently in this environment (the sequential suite passes deterministically).

## Validated Alpha V1 behaviour (reproduced today)

All commands were executed via `verify-local.ps1` (log: `verify-local.log`), which replicates `corepack pnpm verify` step for step without pnpm:

| Step | Result |
| --- | --- |
| typecheck core/runtime/dsh-plugin/server/web | all passed |
| vitest workspace suite (`--no-file-parallelism`) | 10 files, 51 tests passed |
| web tests | 1 file, 2 tests passed |
| dsh-plugin `node --test` | passed |
| builds core/runtime/dsh-plugin/server + vite web build | all passed |
| `dsh:smoke` (fake Cordis/HTTP seam) | `KERNL_FAKE_SMOKE_OK` |
| demo with explicit approver | outcome `PROMOTED` |
| ledger replay after restart | stable, idempotent |
| static workflow replay | `passed` |

Canonical run produced during this verification:

```text
runId:                 run-2026-08-21T13-50-00-128Z-badaf7a2
baseCommit:            b727d3a992e936d53c5dd434f303206674e71c81
candidateCommit:       c83093ecb79b5922b04d3aa45779dc1bce862e9f
verification digest:   4f8b464d9754a799251b389bcd7ee98a8037732e8aa59cff060ef0fd743c93ab
workflow digest:       c174f61c5e5d760f6d8e88eb5aadcab145a3c3d1ebe90859e11341fbf68a4702
evidenceManifestDigest dc1d2b851cacc657b59ecd4e615afbf1ab8c0f29e2669cea80cc1a84291c31b4
```

Restart replay of that run:

```text
status= PROMOTED
stableAcrossRestart= true
eventCount= 132
effectCount= 34
duplicateEffects= 0
effectsReexecuted= 0
```

Static workflow replay status: `passed`.

## Committed evidence integrity

Recomputed SHA-256 for every indexed file of the committed canonical pack `artifacts/demo-run`:

```text
final manifest: 27/27 hashes match
approved core:  15/15 hashes match
secret scan:    passed, scanned 28 artifacts (27 files + SQLite), 0 matches
```

The pack includes AIR before/after/replacement versions, semantic diff, invalid-binding rejection, task DAG, failing then passing verification reports, lifecycle trace, effect ledgers, approval, promotion, promoted workflow, workflow replay evidence, replay reports, and the secret scan report.

## Application smoke

Server started on port 43120 from the built source tree:

```text
GET /api/health -> {"ok":true,"service":"kernl","mode":"deterministic"}
GET /api/state  -> projects run ...-badaf7a2 with system.status PROMOTED
GET /           -> HTTP 200, HTML contains "Kernl control plane"
```

## Baseline architecture facts that constrain Alpha V2

1. **Scenario-specific orchestration.** `KernlDemoCoordinator.prepareDemo()` hard-codes the sync→queue change: fixture paths, task-kind mapping (`queue-contract`/`api-refactor`/`worker-refactor`/`worker-repair`), the expected first failure fingerprint `duplicate-event-effect`, and the queue-v1→v2 lifecycle step. The DAG compiler emits generic VALIDATE/IMPLEMENT/RETIRE/INTEGRATE/VERIFY/APPROVAL/PROMOTE tasks but nothing between diff and those five kinds is configurable.
2. **No catalog.** Components exist only as AIR nodes; there is no versioned manifest describing how a component kind is generated, verified, replaced, or which capabilities it may bind to.
3. **No drafts.** AIR fixtures are files loaded at run time; there is no persisted, editable draft layer, no validation state machine, and no before/after authoring surface beyond swapping JSON.
4. **Scripted adapter switch.** `DeterministicAgentAdapter.implement()` switches on four hard-coded task kinds returning inline sources. Adding a second scenario means adding catalog-driven recipes, not more switch arms.
5. **Verifier is fixture-bound.** Gates run `tests/unit.mjs` etc. against the single job-system template; the architecture gate greps three fixed source files.
6. **Coordinator is not resumable mid-run.** The SQLite ledger persists everything and replays idempotently, but `prepareDemo()` executes start-to-finish in one call; there is no claim-lease/checkpoint loop an external worker could join or a crashed process could resume. DSH claim/result/verify endpoints exist and enforce authority, but no live mutation path uses them end-to-end.
7. **Promoted workflow format is scenario-shaped** (`name: 'sync-to-queued-worker'`, injected repair/lifecycle steps) though already statically executable with digest checks and provenance binding.
8. **UI is one projection page** fed by `/api/state`; no draft editor, no per-view execution/verification/approval/evidence drill-downs.

## Exact commands (this environment)

```powershell
# toolchain (no pnpm required)
$pnpm = 'C:\path\to\pnpm.cjs'  # if ever needed
node node_modules\typescript\bin\tsc -p packages\core\tsconfig.json --noEmit
node node_modules\vitest\vitest.mjs run --configLoader runner --no-file-parallelism
node node_modules\vite\bin\vite.js build --configLoader runner   # in apps/web after tsc --noEmit
node node_modules\tsx\dist\cli.mjs scripts\demo.ts --approve <actor> --role architect
node node_modules\tsx\dist\cli.mjs scripts\replay.ts [--run <runId>]
node node_modules\tsx\dist\cli.mjs scripts\workflow-replay.ts --workflow .\artifacts\demo-run\promoted-workflow.json
node node_modules\tsx\dist\cli.mjs packages\dsh-plugin\scripts\smoke.ts
# complete sequence
pwsh -File ..\..\verify-local.ps1     # session-local driver replicating `corepack pnpm verify`
```

Alpha V2 must keep every one of these green while generalizing the machinery behind them.

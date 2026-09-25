# Verification record

Validated on Windows with Node `v22.23.1` and pnpm `11.7.0` on 2026-08-21.

## Complete deterministic sequence

```powershell
$env:PATH = 'C:\path\to\workspace\tools\node-v22.23.1-win-x64;' + $env:PATH
corepack pnpm verify
```

Result: exit code `0` in 121.9 seconds.

- Five workspace package typechecks passed.
- Root/core/runtime/server/E2E: 10 test files, 51 tests passed.
- Web persisted-state projection and server-render: 1 file, 2 tests passed.
- DSH bundle: 7 tests passed.
- All five buildable packages and the Vite production UI built.
- Fake DSH HTTP/Cordis smoke printed `KERNL_FAKE_SMOKE_OK`.
- Deterministic run promoted, then SQLite restart replay and static-workflow replay passed.

Canonical run:

```text
runId:                 run-2026-08-21T05-21-01-792Z-62ddc10d
candidate commit:      c3548a98ef229f9863687abecc660fa51a0f0e1c
verification digest:   b26747e3ff3182169b88d518386be7b9f5f79f8cb7f8c6a15b726624c79c1cdf
workflow digest:       a6520ce24fafb863ac495067bf4c9137f68c4f06c0576a6259696ee61bee4944
evidence-core digest:  b1e60bddf635ec5051b47fa7f1401b5f90a6c825c07e9a5176985393b5051b69
manifest digest:       337334f59c70e7e868fd82dc70a4153879584ff544c9b5c1a10662d7ba23668c
```

Post-publication restart replay:

```text
status= PROMOTED
stableAcrossRestart= true
eventCount= 132
effectCount= 34
duplicateEffects= 0
effectsReexecuted= 0
```

The sealed evidence snapshot intentionally stops immediately before its own finalization/publication receipts and records 129 events and 32 effects. The authoritative post-publication SQLite replay includes those two later receipts.

## Evidence integrity and sanitation

The SHA-256 audit recomputed every indexed file:

```text
final manifest: 27/27 hashes match
approved core:  15/15 hashes match
machine paths:  0 Windows user/check-out path matches
secret scan:    passed, 0 matches across 27 files
```

The canonical pack is under `artifacts/demo-run`. Verification commands use `<KERNL_ROOT>` and `<WORKSPACE_ROOT>` tokens while retaining exact relative commands and outputs.

## Real DSH compatibility seam

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\packages\dsh-plugin\scripts\smoke-real-dsh.ps1
```

Result: exit code `0` in 77.7 seconds.

```text
KERNL_REAL_DSH_SMOKE_OK
```

The unique temporary `DSH_HOME` no longer existed afterward, and the script's before/after Git-status assertion confirmed the read-only upstream checkout was unchanged.

One opt-in live smoke was also observed during development with an already-present key:

```text
KERNL_LIVE_DEEPSEEK_SMOKE_OK modelRequests=1 toolAttempts=1 successfulResults=1 output=redacted
```

It was deliberately not repeated during final deterministic verification. The finalized script explicitly selects `deepseek-official/deepseek-v4-flash`, permits one request and one validation tool result, sets provider retries to zero and output to 512 tokens, and always deletes the temporary session home.

## Local HTTP/UI smoke

The built UI was served through the local API process on loopback. `/api/health` returned `{ ok: true, service: "kernl" }`, `/api/state` projected the canonical promoted run, and `/` returned HTTP 200 with the `Kernl control plane` production HTML.

## Alpha V2 verification (2026-08-22, this iteration)

All commands run via the session driver erify-local.ps1 (replicates corepack pnpm verify without pnpm; see ALPHA_V2_BASELINE.md for environment constraints). Final full-suite state at commit 8695a76 + docs: **77 tests / 17 files passing**, including:

- Executor E2E, scenario one (sync?queue): real worktrees, honest duplicate-event failure, scoped repair src/worker.ts, durable approval suspension across SQLite restart, promotion, unique idempotency keys. (~30-64 s)
- Executor E2E, scenario two (retry + DLQ + queue v2): live provider transition with retire/rebind-once/drain/cleanup/invariant assertions, declared dead-letter drill repaired in src/dead-letter.ts. (~33-42 s)
- Control-plane API journeys: draft?validate?compile?execute?evidence-bound approval?PROMOTED; rejection path with persisted reason, CANCELLED run, inspectable candidate. (~20-32 s each)
- Generic promoted-workflow replay V2: fresh database, static inputs only, workflow content digest verified, recompiled plan digest byte-matches provenance, drill reproduced, gates passed, 0 duplicate effects, replay evidence manifest. (~45-90 s)
- Alpha V1 acceptance path unchanged: 	ests/e2e/demo.test.ts green; V1 server contracts green.

Canonical Alpha V2 evidence packs (curated, committed): rtifacts/alpha-v2/canonical-sync-to-queue, rtifacts/alpha-v2/canonical-retry-dlq � each contains plan.json, air-before/after.json, approval.json, promoted-workflow.json, promotion.json, effect ledgers, pre-approval and full event streams, and a SHA-256 evidence manifest.

Real-DSH seam on this machine: **not re-run � blocked** (no pwsh.exe installed; script requires PowerShell 7). Alpha V1's verified KERNL_REAL_DSH_SMOKE_OK record stands; plugin sources unchanged. Live DeepSeek mode remains opt-in only, never part of deterministic acceptance.

## Final exports

- Source ZIP: `<historical-workspace>\Kernl\kernl-prototype-alpha-v2-source-20260822-140623.zip` (git archive of HEAD; node_modules/data/.kernl excluded by nature of tracked tree)
- ZIP SHA-256: `EB8B1754650C64E5F04B9B5B4F1FCA0C2D7269A47E175E6975D93F647F4F38F8`
- Git bundle: `<historical-workspace>\Kernl\` (verified with `git bundle verify`)
- Bundle SHA-256: ``
- Git bundle: `<historical-workspace>\Kernl\kernl-prototype-alpha-v2-20260822-140623.bundle` (`git bundle verify` passed; contains refs/heads/main at f02a9c7 + digest commit)
- Bundle SHA-256: `A3DBE2972177F2292EF3334F41F2E7B6E6664AC995555BAD0A0E8CE99E25A028`
- Source ZIP SHA-256 recheck: `EB8B1754650C64E5F04B9B5B4F1FCA0C2D7269A47E175E6975D93F647F4F38F8`

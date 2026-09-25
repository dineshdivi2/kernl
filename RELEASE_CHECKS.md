# Product-alpha release checks

Started 2026-09-12; completed 2026-09-13 local time. Local-only release; no remote push or deployment.

Verified before packaging:

- Root suite: 87 tests / 19 files passed, followed by an additional failure-owner regression and focused 8-test recovery/replay/scenario pass.
- Typecheck and production build passed across all five workspace packages.
- Real DSH plugin smoke: `KERNL_REAL_DSH_SMOKE_OK`; upstream unchanged; temporary test profile removed.
- Live DeepSeek and OpenRouter JSON transport smokes passed. Nous model listing worked but exposed no Hermes model.
- Live DeepSeek implementation: four requests, one targeted repair, all final gates passed, awaiting user approval.
- Browser authoring/compile/run/diff/approval journey reached PROMOTED under an explicitly named UI-test actor.
- Deterministic product demo promoted and static replay reported matching workflow/plan digests with zero duplicate effects.
- Known environment credential scan: zero matches in changed/export files and the product SQLite database. Keys were not printed, persisted or copied.

Exact primary commands (Node 22.23.1 on PATH):

```powershell
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
pwsh -NoProfile -File packages/dsh-plugin/scripts/smoke-real-dsh.ps1
corepack pnpm providers:smoke -- --live
corepack pnpm product:demo -- --provider deepseek
corepack pnpm product:demo -- --approve release-validation-architect --replay
```

The first live implementation failed at its bounded repair limit. Both that failure and the subsequent passing trial are retained under `artifacts/product-alpha/`. These are functional observations, not a model benchmark or complete billing audit.

Fresh-checkout and archive checks are appended after the release source is frozen. Historical evidence packs intentionally retain the exact runtime fingerprint that produced them; running one against a changed runtime must refuse rather than silently regenerate code.

## Frozen-source and fresh-checkout results

Source commit tested: `8b228b02f93a9b0fba65136d1fb340015aded7e1`.

- Full suite: **88 root tests / 20 files**, **4 UI tests / 2 files**, **7 DSH tests**; all passed. The fake-context unit-test smoke sentinel is not being counted as live model execution.
- Fresh local clone: `git clone --no-hardlinks --branch codex/kernl-product-alpha <repo> <isolated-checkout>`.
- `pnpm install --offline --frozen-lockfile --store-dir <existing-cache>`: passed; 107 reused, 0 downloaded; pnpm 11.7.0.
- Fresh-checkout `pnpm typecheck` and `pnpm build`: passed for every package.
- Fresh-checkout recovery/provider/repair-owner/scenario suite: **13 tests / 4 files passed**. This includes a human approval delayed beyond the execution budget; completed implementation is not charged again during approval resume.
- Fresh-checkout deterministic product demo: PROMOTED after one repair/five verification attempts; run `run-2026-09-12T18-28-52-350Z-06624186`, candidate `8c2543e150dca9e63f263b4849d1ce1613408754`, workflow `9c1905cdf8e2014dfb14fa5b0abebdd2f227edf981ec19399a2ced1c0fff0344`.
- Fresh-checkout static replay: **PROMOTED**, run `replay-d29ff237`; `contentDigestMatch=true`, `planDigestMatch=true`, final verification `passed`, `duplicateEffects=0`, `effectCount=15`. Manifest digest `b4f9c535f1a3b9061be67e9e14a5f672c98064289e05f5d7c92d9de83f319fae`. Both fresh evidence directories are included in `artifacts/product-alpha/`.
- All 232 tracked release files scanned against the actual available provider credential values: **0 matches**. Product SQLite was checked separately: **0 matches**. The values themselves were never emitted.
- Curated live and deterministic packs independently re-hashed: **10 sealed files each, 0 mismatches**.

Final packaging excludes `.git`, `.env`, node_modules, runtime SQLite/worktrees and private DSH session logs. The adjacent ZIP checksum file identifies the exported bytes; the Git archive embeds its final commit ID. Later commits may update handoff/evidence only, without changing the source tested above.

# Alpha V2 architecture

Alpha V2 generalizes the verified Alpha V1 vertical slice into a product-shaped control plane. The three authority planes are unchanged; what changed is that every scenario-specific hard-code became data.

## What is genuinely generalized

| Concern | Alpha V1 | Alpha V2 |
| --- | --- | --- |
| Component knowledge | AIR nodes only | Versioned catalog manifests (`fixtures/catalog/kernl-local-catalog.json`, migration v3 persistence): provides/requires capabilities, binding rules, contracts, source layouts, write scopes, generation templates, verification gates, lifecycle policy, replacement compatibility, effects, approvals, provenance |
| Change authoring | Swapping fixture JSON files | Persisted drafts over immutable AIR versions with a validation state machine (`DRAFT → VALID/INVALID → LOCKED → EXECUTED/REJECTED`) and single-path compile=validate semantics (`compileDraft`) |
| Planning | Five hard-coded task kinds | `ArchitecturePlan` compiled from semantic diff + catalog only, over a static step vocabulary (`VALIDATE_AIR, GENERATE_COMPONENT, MODIFY_COMPONENT, UPDATE_BINDING, UPDATE_CONTRACT, VERIFY_COMPONENT, VERIFY_SYSTEM, REPAIR, TRANSITION_PROVIDER, REQUEST_APPROVAL, PROMOTE, REPLAY_ASSERT`) with typed scopes, capabilities, timeouts, retries and assertions |
| Implementation | Scripted switch on four task kinds | Catalog recipes (`kernl.*@1` templates) returning byte-deterministic file sets; scripted defects are explicit, event-recorded, and bound to declared verification drills |
| Verification | Fixture-bound gate list | `GenericVerifier` executes catalog/AIR-declared gate commands (`tsc`, guarded `node`) plus always-on secret scan; failure fingerprints map to registered scoped repairs |
| Provider replacement | Queue-only demo function | Generic `TRANSITION_PROVIDER` step driven by a manifest's declared `provider.replace` effect: retire → reject-new-bindings assertion → consumers release+commit exactly once → reliance zero → drain → `provider.cleanup` receipt → inactive, all under `assertLifecycleInvariants` |
| Promotion | `sync-to-queued-worker` workflow format | Schema-2.0 workflow compiled from the plan (steps, budgets, policies, lifecycle operations, recovery behaviour, provenance incl. planId/planDigest) — scenario-free |
| Replay | Scenario replay module | `runPromotedWorkflowReplayV2`: fresh database, static inputs only, workflow content digest checked, plan recompiled and required to byte-match `provenance.planDigest`, full fail→repair→pass→promote repeated, duplicate-effect assertion, replay evidence manifest |

## Still scenario-specific (declared honestly)

- The job-system fixture, its test scripts (`tests/*.mjs`), and the two demo narratives live in the repository; a third system would add fixtures + recipes, not engine changes.
- Repair transforms are keyed by fingerprint in `recipes.ts`; a general repair synthesizer remains future work.
- The deterministic adapter applies the planned first-candidate defect only where the draft declares a drill (`expectedFailure`); nothing infers defects silently.
- Approval identity is still a local role assertion, not authentication.
- Live DSH mode remains bounded smoke-level (see USER_TEST blockers).

## Persistence and recovery

SQLite (migration v3) adds `catalog_manifests`, `architecture_drafts`, `draft_events`. Runs/tasks/events/effect-receipts/approvals/promotions are unchanged in shape. The executor is resumable because state lives only in the ledger: completed steps are skipped on re-entry, approval suspends durably, effect receipts keep unique idempotency keys, and reconciliation suppresses repeats (`duplicateEffects = 0` asserted by `REPLAY_ASSERT`).

## API surface (Alpha V2)

`/api/v2/catalog[,/load]`, `/api/v2/air/load`, `/api/v2/drafts[/:id][/validate|/compile|/run]`, `/api/v2/runs/:id[/approve|/reject]`. All state projections read the ledger; the browser holds no authoritative state. V1 routes remain untouched.

## Module map additions

```text
packages/core      catalog.ts, draft.ts, plan.ts (+ ledger migration v3)
packages/runtime   recipes.ts, generic-verifier.ts, plan-executor.ts,
                   promotion-v2.ts, workflow-replay-v2.ts
apps/server        v2.ts (control-plane routes)
apps/web           v2/V2App.tsx (seven views beside the classic dashboard)
```

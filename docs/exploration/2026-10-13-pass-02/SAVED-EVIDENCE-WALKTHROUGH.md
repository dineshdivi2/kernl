# What the saved Kernl evidence actually establishes

Inspected **2026-10-13**. These are archived September 12 records, not current service state. No server, provider, replay engine, or candidate tests were run. Read-only parsing and hashing were used to inspect the files.

## One change, three outcomes

The fixture starts with an API calling a worker directly; the proposed change introduces a queue and changes the API/worker paths while preserving the small public jobs contract. The implementation and checks are local, and the store is in-memory. This is a useful example of change reasoning, not evidence of an operating durable broker.

| Saved run | Inspected outcome | What can be said |
|---|---|---|
| `run-2026-09-12T08-47-45-036Z-1d6a1fb5` | Exported status `FAILED`; final failure event says verification failed at idempotency without repair budget | A failed attempt was retained. Failure is evidence about that attempt, not proof that current code still has the same defect. |
| `run-2026-09-12T08-50-36-229Z-851960f9` | Exported status `AWAITING_APPROVAL`; final verification is passed; one pending approval | The recorded live candidate completed the selected checks and reached review. It was not approved or promoted by this exploration. |
| `run-2026-09-12T18-28-52-350Z-06624186` | Exported status `PROMOTED`; approval and promotion files bind the recorded candidate/evidence | A separate deterministic validation run records a promotion. Its test actor is not an authenticated customer approval or production deployment. |

Inspect the [failed ledger](../../../artifacts/product-alpha/run-2026-09-12T08-47-45-036Z-1d6a1fb5/ledger-export.json), [pending live verification](../../../artifacts/product-alpha/run-2026-09-12T08-50-36-229Z-851960f9/verification.json), [pending live ledger](../../../artifacts/product-alpha/run-2026-09-12T08-50-36-229Z-851960f9/ledger-export.json), and [deterministic promotion](../../../artifacts/product-alpha/run-2026-09-12T18-28-52-350Z-06624186/promotion.json). [PROVIDERS.md](../../../PROVIDERS.md) supplies the dated transport context.

## Pending live candidate

The final report binds candidate `9665fd3b69bddd2c33dfc60ccbf7ffc6bea217d2`. It records verification attempt 5 and passing build, unit, contract, idempotency, and secret-scan gates. Its ledger contains four model-request events and one repair-applied event. These are counts from one saved trial, not a comparative performance estimate.

The saved core digest is `5a8fa381ebc6f9f2a5befc9d062275fe1a6ce918bf50e36dd38186c9d3853810`. The core lists before/after AIR, a candidate patch, catalog, preapproval effects/events, execution bindings, plan, source reference, and verification report. The pending decision demonstrates why a green final gate cannot be presented as an accepted change.

The artifact does not contain a captured-code execution replay establishing reconstruction of this live output without another provider call. The [current replay boundary](../../../packages/runtime/src/workflow-replay-v2.ts) refuses live recipe replay; the [handoff](../../../PRODUCT_HANDOFF.md) makes the missing proof explicit.

## Deterministic promotion binding

In the separate deterministic run, the verification candidate and promotion `sourceCommit` both identify `8c2543e150dca9e63f263b4849d1ce1613408754`. The approval and promotion reference core digest `710f3868142c7cda71d1b1fb789b326b5bc3a66a63b1b287184096630842b324`; the promotion references the recorded verification digest. This inspection checks correspondence among archived records.

The approval actor is `clean-checkout-validation`. It is a validation/demo actor and must not be described as a real architect having reviewed this candidate. Promotion here concerns the versioned local workflow record, not a deploy command accepted by a production service.

See the [approval](../../../artifacts/product-alpha/run-2026-09-12T18-28-52-350Z-06624186/approval.json), [core manifest](../../../artifacts/product-alpha/run-2026-09-12T18-28-52-350Z-06624186/evidence-core.json), and [verification](../../../artifacts/product-alpha/run-2026-09-12T18-28-52-350Z-06624186/verification.json). The approval file was also fetched from the public GitHub repository to verify that the linked artifact is present there.

## Read-only integrity result

For the pending live run and deterministic promoted run, all ten files listed in each `evidence-core.json` matched their recorded file length and SHA-256 digest in this checkout: **20 checked entries, zero mismatches**.

This supports a narrow statement: the inspected local bytes correspond to those archived manifest entries. It does not independently authenticate the creator, verify the entire manifest's trust origin, rerun gates, reconstruct the historical candidate repository, establish operational deployment, or certify the semantics of the approval. The inspection did not rehash every ancillary export or every remote artifact.

## What the gates cover

The [public-contract fixture](../../../fixtures/job-system-template/tests/public-contract.mjs) checks a particular POST returning accepted status and a particular GET reaching the expected completed result. The [idempotency fixture](../../../fixtures/job-system-template/tests/idempotency.mjs) invokes `processEvent` twice with the same event and checks that the processing count is one. The [store](../../../fixtures/job-system-template/src/store.ts) uses process-local maps.

| Desired statement | Evidence present | Evidence still missing for a broader claim |
|---|---|---|
| Selected HTTP behavior is preserved | Recorded fixture gate and inspectable test | General compatibility across callers, errors, authentication, limits, and timing |
| The tested duplicate event causes one counted effect | Two deliveries in one process and in-memory state | Concurrent workers, restart/persistence, transaction boundaries, and externally observable effects |
| Candidate has the selected build/check result | Candidate-bound archived report | Independent reconstruction/rerun in a comparable environment |
| A decision references the archived evidence | Exact pending or approved record | Authenticated identity and real organizational authority |
| Promotion binds the recorded candidate | Deterministic promotion record | Artifact deployed by an actual executor and observed resource state |

The idempotency test intentionally reports not applicable when a compiled queue is absent, allowing the synchronous baseline to run the same suite. A proposed future report should distinguish this outcome from an applicable check that passed. A required queue change also needs evidence that its expected artifact and gate applicability hold. This is an interpretation question for evidence presentation, not a claim of an exploit or a newly reproduced runtime failure.

## A reviewer packet derived from these facts

For the pending live candidate, the first page could say:

> Proposed: introduce queued processing while preserving the specified jobs behavior. Recorded checks passed for the identified candidate. Duplicate delivery was checked only within the local fixture. Approval is pending. Captured-code replay, production queue durability, authenticated release authority, and deployment outcomes are not established.

That short statement is more useful than a single global verified badge. A detailed page can link the contract, patch, failed attempt, repair, final gates, and core binding. The research question is whether reviewers answer the acceptance questions more accurately and with less effort than when reading the same artifacts as an ordinary PR packet.

Do not run or promote this candidate merely because this walkthrough exists. The owner requested exploration, and the current result is a better account of what the archived evidence means.

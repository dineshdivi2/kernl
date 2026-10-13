# Kernl exploration, pass 2: what must the extra layer earn?

Date: **2026-10-13**. Continuation of the [first exploration](../2026-10-13/README.md). Scope: research, existing-artifact inspection, and documentation. No runtime implementation or live-model experiment was performed.

## Refined working conclusion

Explore the smallest record that connects an intended change to its acceptance criteria, exact candidate, evidence, authorized decision, and observed effect. Start with one change, not a permanent graph of the whole company. Use native agent, repository, attestation, and workflow systems wherever their actual semantics fit.

The first pass identified architecture-significant changes with portable evidence as a promising direction. This pass narrows that hypothesis: **an additional control plane needs to earn its authoring, maintenance, and review cost**. Byte identity, provenance, passing checks, approval, deployment, and useful operation are different claims. Making their relationships clearer could be useful, but ordinary PR/CI tooling can already express many of them.

This is not evidence of customer demand, a unique feature claim, or a prediction that Kernl remains necessary in an AGI future. A simpler integration could be the better outcome.

## Documents

| Read | New question resolved or sharpened |
|---|---|
| [Saved evidence walkthrough](SAVED-EVIDENCE-WALKTHROUGH.md) | What do the actual failed, pending, and promoted artifact records establish? |
| [Native assurance comparison](NATIVE-ASSURANCE-COMPARISON.md) | What is already available, and what requires a task-specific acceptance decision? |
| [Architecture record and drift](ARCHITECTURE-RECORD-AND-DRIFT.md) | How small can the useful record be, and exactly when should evidence be invalidated? |
| [Economics and future bottlenecks](ECONOMICS-AND-FUTURE-BOTTLENECKS.md) | When does the extra layer improve total effort, and what changes under much stronger AI? |

## Concrete findings

- The saved live run's final verification report says passed, while its exported run and approval remain pending. A separate deterministic run records an approved candidate. These must not be combined into a claim of approved live output.
- A read-only integrity inspection found that the ten files listed in each of the two saved core manifests still matched their recorded byte lengths and SHA-256 values locally. This checks twenty archived files; it does not rerun their tests or certify their design.
- The duplicate-delivery fixture checks two identical deliveries against an in-memory store in one process. Broader crash, concurrent delivery, persistence, or external exactly-once guarantees remain outside that evidence.
- Native merge queues, signed provenance, environment controls, and durable orchestration are strong baselines. A custom evidence record should add useful meaning and coverage rather than duplicate their mechanisms.
- A complete permanent AIR is not the only possible interface. A per-change contract with links to existing API, event, catalog, code, and runtime records may have a lower maintenance burden.

## What changed in the thesis

| Earlier possibility | Refinement in this pass |
|---|---|
| Portable evidence is a product direction | First determine whether a small evidence/acceptance packet adds value beyond native records |
| Architecture intent should be explicit | Keep intent explicit without requiring a full permanent graph up front |
| Approval should bind exact artifacts | Also show which requirement and observation the evidence covers, and the preconditions under which it remains usable |
| Strong agents increase the need for assurance | Strong agents can also produce specifications, checks, and equivalent tooling; the product must survive the simplest strong baseline |
| Captured-code replay is a useful engineering proof | It remains a parked proof of reconstructability, not a substitute for product value or operational correctness |

## Next exploration decision

Prepare a one-page review packet for the existing pending live candidate using only its existing evidence. Label checked, declared, skipped/not-applicable, unknown, and operationally unobserved claims. Compare it with the same artifacts organized as an ordinary PR description. The next decision is which questions become easier to answer, before building an interface or granting more authority.

Source ledgers accompany the relevant documents. Living documentation was retrieved on the review date; it is not an assertion about the release date of every feature. The first snapshot remains available unchanged apart from a navigation link to this continuation.

# Exploration path and decision log

Owner-selected scope: **exploration only**, 2026-10-13. The following activities are research proposals, not scheduled work, implemented tests, or permission to contact users or run experiments on external systems.

## Start with a decision, not a platform roadmap

The next research decision is whether an architecture-significant change becomes easier to understand and accept when intent, scope, evidence, and candidate artifacts are linked explicitly. Only then decide whether the answer needs a standalone Kernl workspace, a review integration, or a reusable library.

The older [implementation goal](../../../NEXT_ITERATION_GOAL.md) remains a useful engineering possibility. It should resume only after exploration establishes why that proof is worth building.

## Research sequence

| Step | Activity | Concrete research output | Decision it informs |
|---|---|---|---|
| E01 | Compare native controls for one familiar architecture change | A matrix of the actual change, native runtime controls, CI/review evidence, and remaining gaps; label documented versus experimentally verified | Is there a gap beyond ordinary agent plus CI? |
| E02 | Walk through the current alpha's evidence without running new work | Explain one saved success, one saved failure, candidate binding, approval, and missing operational claims | Which mechanisms are comprehensible and reusable? |
| E03 | Draw two product journeys as paper concepts | Compare a review packet with a full architecture workspace using the same change | What is the minimum useful surface? |
| E04 | Identify acceptance criteria and their blind spots | A requirement-to-evidence map with protected checks, human judgment, unverified assumptions, and observed effects | Can the intended behavior be evaluated meaningfully? |
| E05 | Plan a fair comparative experiment | Matched task envelope, budgets, baseline workflow, repeated-run plan, review rubric, and stopping rules | What would count as evidence of value? |
| E06 | Revisit the thesis after industry changes | A dated delta with sources and decisions retained, changed, or retired | Which planned work has become redundant? |

E01–E04 can be explored through public documentation and existing artifacts. Interviews, live provider comparisons, or new implementation would be separate later work; none is claimed here.

## Proposed first comparative task

Use a synthetic multi-component service with a clear before/after contract and a deliberately ambiguous requirement. Include both answerable and genuinely under-specified changes. Compare:

- An ordinary coding agent with the repository's instructions, protected tests, and normal PR review.
- The same execution path with a small explicit change/evidence packet.
- The same path with Kernl's architecture representation and scoped plan, only if the smaller packet shows a useful gap.

Keep models, tools, total compute and human budgets, baseline, and hidden evaluation rules comparable. Include the labor used to prepare AIR, the packet, tests, and runtime configuration. Do not give only the Kernl condition extra acceptance criteria and then credit Kernl for finding them.

A later captured-code replay demonstration would test reconstructability and bindings. It would not establish whether the reconstructed program is correct for all inputs, whether a rollout is safe, or whether Kernl saves review time.

## Outcome measures to consider

| Measure | What to capture | Common misleading substitute |
|---|---|---|
| Valid accepted change | Independent correctness/quality rubric, scope adherence, and evidence gaps | Passing the worker's own tests |
| Total effort | Authoring, configuration, generation, waiting, review, correction, and operation | Model latency alone |
| Review understanding | Can the reviewer identify intended behavior, missing evidence, and what approval covers? | Reviewer says the UI looks clear |
| Unsupported acceptance | Incorrect or under-evidenced candidates accepted under the rubric | Few agent errors in the event log |
| Appropriate escalation | Missing or contradictory evidence recognized without inventing a solution | More human interruptions counted as safety |
| Evidence portability | Another evaluator can inspect exact artifacts and context without mutable provider state | A downloadable transcript |
| Recovery and effects | Stale ownership stopped; operations reconciled against observed state; duplicates accounted for | Process restart appears successful |

Pre-register the useful effect size and acceptable regression before a future experiment. No numeric improvement target is adopted from this exploration. Small synthetic results must not be represented as enterprise reliability or statistical proof of rare failures.

## Industry observation protocol

This is a manual, resumable research protocol. No recurring automation or notifications were created.

At a later review, check primary changelogs, product documentation, independent evaluations, and reports of actual deployment. Record the event date separately from the retrieval date. Read enough to identify preview/GA status, scope, migration implications, and measurement conditions.

| Signal | Specific thing to watch | Effect on Kernl direction |
|---|---|---|
| Native acceptance semantics | Exact artifact/evidence binding, stale-approval invalidation, protected evaluator changes | Could eliminate a standalone promotion layer |
| Managed operating responsibilities | Long-lived sessions, scheduled/event work, shared environment state, version migration | Makes record freshness and reconciliation more relevant, but increases platform competition |
| Delegation identity and authority | Short-lived grants, tool-side authorization, revocation and resource accounting | Prefer interoperable authority rather than bespoke agent permissions |
| Evidence export and custody | Immutable/exportable artifacts, independently held observations, provenance after model changes | Determines whether a portable packet is feasible and differentiated |
| Real productivity and quality | Controlled or well-described comparisons including review/rework and accepted outcomes | Supports or weakens the business value hypothesis |
| Capability measurement ceiling | New task distributions and repeated-run/higher-reliability evidence | Avoid anchoring decisions to saturated or inactive charts |
| Protocol and SDK migration | Tool semantics, transport/auth changes, async tasks/events, versioning | Assess adapter cost rather than assuming interfaces are interchangeable |
| Organization demand | Repeated reviewer/operator pain in concrete workflows | Determines whether the problem deserves a product at all |

The METR dashboard identifies September 8, 2026 as its last update and now says it is no longer actively updated; keep it as historical evidence and seek newer measurements rather than filling in unmeasured frontier values. Current vendor and protocol watch sources are linked in the two industry documents.

## A change-log entry template

For a later dated exploration folder, record:

```text
Claim under review:
What changed and event date:
Source URL, issuer, publication/availability date, retrieved date:
Evidence type: announcement / documented feature / controlled result / deployment observation:
Conditions and limitations:
Prior Kernl assumption affected:
Decision: retain / narrow / replace / park:
Smallest new question or comparison:
```

Preserve earlier decisions and why they changed. Do not overwrite a measured failure with a polished narrative, and do not change prototype status because the concept became more ambitious.

## Stop and narrow rules

| Finding | Response |
|---|---|
| Native controls and existing CI supply the same useful record with less total effort | Integrate or park the duplicate Kernl layer |
| Users cannot keep AIR accurate without disproportionate maintenance | Narrow to per-change contracts or evidence packets |
| Reviewers cannot tell what a packet establishes | Redesign the explanation; avoid increasing automatic authority |
| Most important correctness conditions cannot be checked or judged credibly | Expose the uncertainty and restrict use to a better-evaluated task |
| Provider portability costs more than the demonstrated benefit | Support one concrete workflow or publish a format/library |
| Operational guarantees depend on controls Kernl does not own | Treat them as integration assumptions, not completed guarantees |
| More capable agents remove the original pain | Retire that thesis and investigate the remaining measurable problem |
| The value exists only in a contrived benchmark or because the baseline was weakened | Park the product claim; retain useful research tooling |

## Current decision log

| Date | Decision | Reason | Confidence |
|---|---|---|---|
| 2026-10-13 | Focus on Kernl exploration; park the saved build shortlist | Explicit owner direction | Confirmed scope |
| 2026-10-13 | Evaluate native harnesses before building additional orchestration | Current providers document substantial overlap | High confidence in overlap; workflow fit untested |
| 2026-10-13 | Investigate a portable change/evidence record before a full operating platform | Lower integration burden and closer to present mechanisms | Product hypothesis |
| 2026-10-13 | Use conditional capability scenarios, with no AGI arrival date | Current evidence is insufficient for a precise future trajectory | Research boundary |
| 2026-10-13 | Keep historical prototype verification separate from this research | No new runtime trials conducted | Confirmed method |

Next small action: pick the same synchronous-to-asynchronous example and map the documented native controls, ordinary CI/PR evidence, and current Kernl packet side by side. Identify one gap a reviewer actually needs to resolve. This action is an exploration step, not a request to start implementation.

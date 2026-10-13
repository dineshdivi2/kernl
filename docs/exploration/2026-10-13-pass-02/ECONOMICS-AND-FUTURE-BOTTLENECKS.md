# Economics and future bottlenecks

Exploration date: **2026-10-13**. No customer interviews, pricing validation, or comparative experiment was conducted. Every number in the sensitivity table is a **synthetic assumption**, not measured Kernl performance.

## The buyer pays for the whole change

Faster generation can be valuable while the overall change remains slow. Count preparing requirements, configuring permissions/checks, waiting, reviewing, correcting, maintaining records, and handling rollout outcomes. Kernl is useful only if the value of better accepted changes exceeds the burden of the additional representation and integration.

The [first-pass capability review](../2026-10-13/CAPABILITY-AND-RUNTIME-SIGNALS.md) distinguished benchmarks, vendor demonstrations, perceived productivity, and causal measurements. This pass adds an original accounting model; it does not estimate actual productivity from those sources.

## A simple effort model

Let the ordinary workflow's total effort per change be:

```text
T0 = preparation + generation/waiting + review + correction + operational handling

Added effort = setup/N + contract authoring + extra checks + record maintenance
Saved effort = avoided review + avoided correction + avoided operational handling
               + any reduction in generation/waiting

Delta T = added effort - saved effort
```

N is the number of relevant changes sharing the setup. This is a labor-equivalent accounting model; elapsed latency, people-hours, model spend, and business value should be measured separately in a real study rather than silently mixed into one minute total.

Improved reliability also has value beyond time. A later economic analysis could add the value of avoiding a particular failure and the opportunity cost of delay, but probabilities and loss estimates must come from a defensible task distribution. Rare-event benefit cannot be inferred from a handful of successful synthetic fixtures.

## Illustrative sensitivity

Assume setup is **240 minutes** and authoring/check/maintenance overhead is **8 minutes per change**. Vary N and hypothetical total saved effort. Positive Delta T means the extra layer adds effort; negative means it reduces effort under these assumptions.

| Relevant changes sharing setup, N | Setup/N plus overhead | Save 10 min/change | Save 25 min/change | Save 40 min/change |
|---|---|---|---|---|
| 5 | 56 min | +46 min | +31 min | +16 min |
| 20 | 20 min | +10 min | -5 min | -20 min |
| 60 | 12 min | +2 min | -13 min | -28 min |

**All inputs and outputs are illustrative.** The arithmetic shows why a platform can look useful in a prepared demo and remain uneconomic for a team making few relevant changes. A smaller integration can lower setup; keeping a full AIR can increase authoring and maintenance. No row recommends buying or building Kernl.

## Three buyer/workflow hypotheses

| Hypothesis | Potential pain and value | What must be observed | Why the buyer may reject it |
|---|---|---|---|
| Platform team performing repeated cross-component migrations | Repeated contract, compatibility, dependency and rollout reasoning | Recurring unanswered review questions and expensive rework using their current stack | Native checks and experienced reviewers already handle the work well |
| Team requiring explicit evidence for a consequential software change | Difficulty explaining artifact, check coverage, decision and permitted effect | An actual evidence requirement and useful mapping to the existing validation/release process | An extra packet is not an accepted control or adds manual work without better evidence |
| Small team using capable coding agents | Growing change volume and limited reviewer attention | Reviewer understanding/quality improves enough to exceed setup and maintenance | A better PR template and CI are simpler; the product costs more attention than it saves |

These are prospective users, not interviewed customers. Regulatory evidence obligations do not automatically create demand for Kernl, and a signed report does not by itself establish compliance. The project must fit an existing accountable process or demonstrate why it should change.

## What happens if models improve much further?

### Strong generation and strong native controls

The expected savings from a bespoke worker loop fall. Kernl should remove redundant orchestration and test a small acceptance record on top of the native system. If the native product supplies an equally understandable, exportable record with enforceable bindings, the honest outcome may be a library or no separate product.

### Models can propose better specifications and checks than humans

Use those proposals. The valuable distinction is who accepts the objective, which premises support it, and which evaluator version decides acceptance. A model-authored criterion is not inherently inferior; a human-authored criterion is not inherently adequate. The problem is silent substitution of a convenient objective and correlated error between implementation and evaluation.

One proposed workflow could allow a strong model to propose an evaluator change, compare it with the previous evaluator on independent examples, and retain both results. Adoption of the new evaluator would be a separate decision. The old report remains an old report rather than being relabeled under new criteria. This is a governance concept, not an implemented self-improvement system.

### Generation becomes almost free

Generating more changes can make observation, integration, review and prioritization scarce. But producing fewer low-value proposals can be better than processing all of them through a new control plane. Measure valuable accepted outcomes, not generated proposals or dashboard activity. A limit on attention and operational disruption can matter as much as a token budget.

### A very strong agent can build an equivalent system

The codebase is not a durable moat merely because it encodes a compiler and ledger. Possible lasting value would need useful domain criteria, trusted integration, understandable decisions, and maintainable observations. Even those could be absorbed by incumbents or reproduced locally. Consider a portable format and customer exit path rather than depending on lock-in.

### The system is too complex to understand fully

Keep claims local and conditional: a particular invariant under stated assumptions, a selected observation window, or a bounded change. Identify what cannot be checked. A complete-looking global graph can conceal uncertainty more effectively than an explicit unknown. If acceptance cannot be evaluated well enough for the proposed effect, Kernl cannot manufacture assurance through bookkeeping.

These are conditional planning scenarios without AGI arrival dates or probabilities. Stronger intelligence can make the original pain smaller as well as make new responsibility boundaries more consequential.

## Delegation levels worth distinguishing

| Level | Proposed commitment | Evidence needed before expanding it |
|---|---|---|
| Advisory | Suggest a change or explain existing evidence | Useful, grounded answers and visible uncertainty |
| Candidate production | Produce a patch/artifact under a defined scope | Actual scope enforcement and inspectable candidate/check correspondence |
| Bounded acceptance | Accept a narrow class of changes under standing policy | Validated criteria, protected evaluator/authority, representative failures and stale-evidence handling |
| Operational effects | Act on controlled resources after acceptance | Observed identity, artifact mapping, effect accounting, recovery and revocation |
| Ongoing improvement | Propose repeated changes and evaluator/tool updates | Separate change authority, independent comparisons and measured operational value |

These levels are conceptual, not implemented tiers. A successful advisory assistant does not authorize promotion to operational effects. Delegation should be expanded by evidence for the specific effect class, rather than by a model name or an impressive benchmark.

## Decision rules

Prefer no extra product when the same criteria and evidence work comfortably in existing tools. Prefer a small packet when the pain is reconstructing relationships among those records. Consider a full architecture workspace only when repeated dependency/lifecycle decisions benefit from the maintained view.

Before a later experiment, state which reviewer decision is expected to improve, what setup and maintenance are included, and what regression is unacceptable. A result that saves minutes but causes more unsupported acceptance is not success; a result that reduces errors but consumes excessive effort may still justify a narrow high-consequence use case rather than broad adoption.

The next valuable research output is a matched pair of ordinary PR and explicit acceptance packets using the same saved candidate. That comparison can clarify the interface hypothesis before a build or live-provider trial.

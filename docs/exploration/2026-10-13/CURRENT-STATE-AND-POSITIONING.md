# Kernl: current mechanisms and possible product positions

Date: 2026-10-13, India time. Scope: source and document exploration only. No implementation changes, test execution, local server startup, model requests, deployment, or approval of an existing candidate were performed for this report.

## Working conclusion

Kernl has the beginnings of a **verified architecture-change system**. Its useful distinction is the connection between intended dependencies, bounded implementation authority, an exact candidate, verification, and a recorded decision. Code generation is one interchangeable worker inside that system.

The strongest near-term hypothesis is to help a backend/platform team make one consequential cross-component change in an existing service and produce a reviewable change record. An asynchronous conversion, retry/dead-letter addition, or provider upgrade is a more concrete starting problem than “build any application from a graph.” This is a product hypothesis; independent architect usability, unfamiliar-repository performance, and willingness to pay have not been established.

Kernl could eventually become a lifecycle and assurance layer for software changed by many agents. That future does not require an AGI arrival date. It depends on proving that the system remains useful as code synthesis becomes cheaper and more capable, while architecture intent, permissions, release decisions, and recovery still need durable records.

## Evidence boundaries

| Label | Meaning in this report |
| --- | --- |
| Source-inspected | A mechanism or boundary is visible in the current local source. It was not executed in this exploration. |
| Previously reported | A dated repository document records a runtime observation. This report has not reproduced it. |
| Proposed | A possible product or architecture direction, with no claim of current implementation. |
| Unresolved | A question requiring experiments, external users, or further source review. |

The latest local authoring note reports **89 root tests, 5 web tests, 7 DSH offline tests, typecheck/build, and a browser authoring walkthrough** on 2026-09-13. The prior release note records a clean-checkout deterministic promotion/replay and separate live-provider observations. These are historical functional results, not fresh test results, a general model benchmark, or production evidence. See [AUTHORING_ITERATION.md](../../../AUTHORING_ITERATION.md#L14) and [RELEASE_CHECKS.md](../../../RELEASE_CHECKS.md#L32).

The project calls itself a trusted local alpha. The implemented system is a jobs-service fixture with a fixed catalog and constrained recipes; local role assertions are not authentication, Git worktrees are not hostile-code sandboxes, and replay of live-generated implementations is explicitly incomplete. [PUBLIC_STATUS.md](../../../PUBLIC_STATUS.md#L23), [PRODUCT_HANDOFF.md](../../../PRODUCT_HANDOFF.md#L66), and [AUTHORING_ITERATION.md](../../../AUTHORING_ITERATION.md#L30) state these limits.

## What exists in the current source

| Mechanism | Source-inspected behavior | What this does not establish |
| --- | --- | --- |
| Architecture record | AIR declares components, exact provider bindings, capabilities/contracts, lifecycle policies, effects, verification and approval gates. Semantic validation checks references, required/ambiguous bindings, exact provider versions, contract agreement and approval declarations for high-impact effects. | Correct inference of architecture from arbitrary code; actual enforcement of every effect declaration. |
| Component catalog | A manifest joins provides/requires, binding rules, source ownership, write scopes, recipes, gates, replacement policy, effects and approvals. The component vocabulary is a fixed enum: API, worker, queue, store, policy and failure sink. | An open component ecosystem or generic language/cloud support. |
| Architecture authoring | Draft operations include addition, version upgrade, removal and rebinding. The current editor stages catalog operations and dependency changes; advanced contracts remain JSON. Bootstrap prefers a promoted implementation baseline and offers explicit compatible templates. | Autonomous architecture proposals, unrestricted graph editing, or arbitrary repository import. |
| Deterministic planning | A semantic change compiles to a static step vocabulary with scopes, dependencies, required capabilities, timeouts, budgets and digests. The compiler validates DAG structure and plan size. | A general planner that can safely invent new executable actions. |
| Task authority | Ledger claims require an implementation/repair task, exact matching write scopes, required capability and completed dependencies. Mutation policy rejects paths beyond the task workspace/scope and protects verification paths for prohibited actions. | Authenticated worker identities, remote authorization, or an OS-enforced filesystem boundary. |
| Integration | Mutations pass policy before isolated Git task worktrees; candidate commits advance after integration. The runtime records a frozen mutation intent and operation result for recovery. | Safe ingestion of malicious repositories or distributed concurrent integration. |
| Model boundary | Direct providers return bounded JSON file proposals. The runtime reserves a model-request event before sending, limits requests/output, records provenance and handles proposals through the same scope checks. | Broad provider portability, exact monetary ceilings or a full DSH-led mutating-agent run. |
| Verification and repair | Catalog/AIR gate commands run through the verifier; supported commands are translated to TypeScript/guarded Node execution and a secret scan is always added. Repairs are scoped; scripted defect drills and deterministic repair transforms have explicit fingerprints. | Exhaustive architecture correctness, semantic completeness, or general repair synthesis. |
| Recovery | Frozen inputs, planned/committed operations, execution leases with epochs, event-derived request/repair counts and skip-on-completion logic are present. | Power-loss safety at every cut point, end-to-end external exactly-once behavior, or a distributed scheduler. |
| Approval and promotion | Promotion requires passing verification, a clean candidate HEAD matching the verified commit, an approved evidence digest and unchanged sealed evidence files. | Authenticated approval or deployment of the candidate. |
| Replay | Ledger projection reconstructs recorded facts. V2 execution replay checks workflow content, catalog/runtime/template bindings and the recompiled plan digest, then executes a deterministic recipe path. It refuses live-generated adapters. | Reconstructing a captured live candidate without model calls, or re-executing a production deployment. |
| Lifecycle | Core state guards track exact committed provider versions, reliance, refusal of new bindings after retirement, and a receipt required before inactivity. V2 executor persists a modeled transition/cleanup result. | Actual queue processes being drained/cleaned up or running hot replacement. |
| DSH seam | Five model-facing tools expose validation, compilation, claim requests, result recording and verification. Approval/promotion are absent. | Delegating durable authority to DSH, or completion of full mutating DSH orchestration. |

### Exact source entry points

- AIR schema and semantics: [packages/core/src/air.ts](../../../packages/core/src/air.ts#L9), especially lines 166-278.
- Catalog and fixed component types: [packages/core/src/catalog.ts](../../../packages/core/src/catalog.ts#L13), lines 13-92 and 131-179.
- Draft operation schema and compile semantics: [packages/core/src/draft.ts](../../../packages/core/src/draft.ts#L23), `compileDraft` at line 152 and required catalog-gate collection at lines 448-477.
- Static plan vocabulary, budgets and compilation: [packages/core/src/plan.ts](../../../packages/core/src/plan.ts#L9), lines 9-83, 98-144 and 168-464.
- Immutable run inputs and operation journal: [packages/core/src/ledger.ts](../../../packages/core/src/ledger.ts#L582), lines 582-650; atomic claims at 803-861.
- Mutation policy: [packages/runtime/src/policy.ts](../../../packages/runtime/src/policy.ts#L17), lines 17-42.
- Child environment/executable boundary: [packages/runtime/src/process.ts](../../../packages/runtime/src/process.ts#L5), lines 5-66; guard in `packages/runtime/assets/deny-external-network.cjs`.
- Model request, proposal, authorization and operation intent: [packages/runtime/src/plan-executor.ts](../../../packages/runtime/src/plan-executor.ts#L252), lines 252-365; budgets/lease/resume in 564-651.
- JSON providers and proposal parsing: [packages/runtime/src/providers.ts](../../../packages/runtime/src/providers.ts#L32), lines 32-98.
- Verification: [packages/runtime/src/generic-verifier.ts](../../../packages/runtime/src/generic-verifier.ts#L53), lines 53-129; fixed recipes/repair registry in [recipes.ts](../../../packages/runtime/src/recipes.ts#L278), lines 278-356.
- Promotion binding and evidence publication: [packages/runtime/src/plan-executor.ts](../../../packages/runtime/src/plan-executor.ts#L786), lines 786-903.
- Recipe replay refusal and bindings: [packages/runtime/src/workflow-replay-v2.ts](../../../packages/runtime/src/workflow-replay-v2.ts#L58), lines 58-75; [execution-fingerprint.ts](../../../packages/runtime/src/execution-fingerprint.ts#L5), lines 5-22.
- Lifecycle state semantics: [packages/core/src/lifecycle.ts](../../../packages/core/src/lifecycle.ts#L70), lines 70-78, 150-209, 212-281. Modeled V2 provider transition: [plan-executor.ts](../../../packages/runtime/src/plan-executor.ts#L367), lines 367-475.
- Current authoring/UI: [apps/web/src/product/ArchitectureEditor.tsx](../../../apps/web/src/product/ArchitectureEditor.tsx#L1), lines 1-27; [ProductApp.tsx](../../../apps/web/src/product/ProductApp.tsx#L52), lines 52-97.
- API baseline selection, frozen context and approval: [apps/server/src/v2.ts](../../../apps/server/src/v2.ts#L398), lines 398-413 and 426-449. Loopback binding: [apps/server/src/index.ts](../../../apps/server/src/index.ts#L10).
- DSH authority boundary: [packages/dsh-plugin/src/tools.ts](../../../packages/dsh-plugin/src/tools.ts#L19), lines 19-23 and 69-98.

### Three distinctions the product must keep visible

1. **A declared assertion is not an executed check.** The plan contains strings such as `public-contracts-preserved`; promotion carries the strings forward. Specific validators, gates and control paths enforce particular properties, but the source does not contain a general evaluator proving every string. An assurance product should expose `declared`, `checked`, `failed`, `unsupported` and `unknown` separately, with the evidence implementing each checked claim.
2. **A receipt is only as strong as the executor that produced it.** The V2 lifecycle model appends a `provider.cleanup` receipt with a cleanup result and then transitions state. It does not call an operating queue adapter to drain resources. Persisting that result proves ledger/model behavior. A future operational product needs an executor observation bound to the concrete resource and a reconciliation check.
3. **Replay has several meanings.** Recorded-state reconstruction, deterministic recipe execution, captured-code reconstruction, reproducible evaluation, and repeating an external business effect are separate operations. The current refusal of live recipe replay is useful: it avoids claiming that regeneration reproduced an approved artifact.

## Five possible product positions

All five are exploration hypotheses. The preference below uses fit to current mechanisms and the size of the next proof, not a measured market ranking.

| Position | Primary user and workflow | Initial wedge | Potential defensibility | Main commoditization/adoption risk | Fit |
| --- | --- | --- | --- | --- | --- |
| **1. Verified architecture changes** | Backend/platform lead specifies “introduce asynchronous delivery while preserving the public API,” reviews impacts and scopes, runs a candidate, inspects failure/repair/evidence and approves an exact PR candidate. | A small set of difficult, repeatable cross-component changes in TypeScript backends. | Customer-specific contracts and architecture history; failure/evaluation corpus; trusted evidence joining intent to Git; deployment/migration integrations after proof. | Coding platforms may add planning, worktrees, tests and review. Maintaining AIR could feel like duplicate work. | Best connection to current alpha; recommended first hypothesis. |
| **2. Agent capability release system** | Agent platform owner proposes a tool/skill/package/provider change, evaluates it under a candidate capability profile, approves a version, pins sessions and retires old dependencies. | Governed upgrade of one internal tool or MCP workflow with explicit effect boundaries. | Compatibility/effect contracts, workload identities, release evidence and safe capability migrations. | Managed runtimes may absorb most orchestration and policy. Considerable overlap with LoopPlane. | Valuable adjacent use case; reuse contracts before building a second engine. |
| **3. Portable assurance record for agent-built changes** | Reviewer receives a PR plus machine-readable intent, authorization, artifact, check coverage, failure history and approval record from any supported coding runtime. | Export/verify one evidence bundle in CI, without replacing the team's editor or agent. | Organization policy/gate mappings, independent verifier integrations, tamper-evident lineage and easy review. | A trace viewer or signed test report is easy to copy. Verification evidence cannot imply compliance without an agreed control/validation process. | Smaller integration surface; could become the entry point for position 1. |
| **4. Continuously reconciled architecture record** | Architect compares intended graph with source/deployment observations, reviews conflicting inferences and traces an agent's changes across repositories. | Dependency and public-contract drift on a familiar service; propose graph updates with provenance. | Longitudinal, resolved design decisions; source-to-runtime reconciliation; useful organization-specific mappings. | Code intelligence and observability vendors already generate graphs. False confidence from inference may make the graph untrustworthy. | A discovery/review wedge, but brownfield ingestion is currently absent. |
| **5. Lifecycle kernel for evolving software** | Platform owner authorizes an agent-proposed composition, stages/activates a replacement, keeps existing reliance valid, drains, compensates or escalates effects and observes exact resource outcomes. | One operational provider replacement in a local controlled system before distributed execution. | Executable lifecycle/compensation semantics; reconciled receipts; tested adapters; effect recovery knowledge. | Large engineering burden before user value; third-party effects may be irreversible, opaque or lack idempotency. | Long-term architecture direction; premature as a broad product promise. |

Positions 1 and 3 can form one product: a narrow architecture-change workflow whose deliverable is a portable assurance record. Position 4 can gradually supply observed architecture. Position 5 supplies operational depth when real deployments are in scope. Position 2 should be explored with LoopPlane rather than treated as a separate Kernl rewrite.

### A concrete first user journey

Proposed experience for position 1:

1. Connect a familiar repository at an immutable base commit. Kernl proposes an observed graph with source pointers and confidence; the user confirms the subset it may treat as intended design.
2. Select a change, such as queued processing, and state contract, latency, duplicate-delivery, data-retention and approval requirements. Unsupported requirements remain visibly unresolved.
3. Compare two feasible designs and their assumptions. A model can propose alternatives; deterministic validation and a human decision admit one as authority.
4. Review the affected subgraph, files, interfaces, operations, budget and risk before running.
5. A selected agent runtime produces bounded proposals in an isolated environment. Kernl records and enforces the admitted authority independently of the model.
6. Independent gates test the candidate against the approved requirements. Failures show the effect owner and scope of the proposed repair. Original failures stay in the record.
7. The reviewer sees intended change, source diff, evidence coverage, remaining unknowns and the exact candidate/evidence identifiers. A signed decision produces a PR-ready artifact.
8. After a separate deployment authorization, observed deployment and business effects are reconciled against the intended record. A failed rollout has a classified recovery path.

Only the middle, fixture-bound portion of this journey exists today. Import, alternative-design generation, authenticated decisions, PR/deployment integration and operational reconciliation are proposed.

## Architecture evolution as agent capability increases

The older high-scale reference architecture (local-only historical document: `architecture-control-plane-startup/HIGH_SCALE_ARCHITECTURE.md`, outside this repository) proposes three planes, AIR, durable orchestration, secure runners, policy and signed artifacts. Its vendor choices, scale targets, provider names and commercial claims are not current evidence and should be re-evaluated when needed.

The enduring boundaries are more useful than prematurely committing to that stack:

| Boundary | Preserve from current design | Proposed extension | Proof before broadening |
| --- | --- | --- | --- |
| Intended architecture | Immutable AIR, exact bindings and explicit change operations. | Provenance/uncertainty per inferred node/edge; requirement/check coverage; explicit accepted deviations. | Import one unfamiliar service and have its owner correct the record. |
| Implementation | Exact Git candidate and scoped mutations. | Content-addressed baseline, captured per-task file/patch bundles and tool inputs, semantic output digests. | Replay one captured live-output candidate with network disabled and no recipe/model regeneration. |
| Authorization | Task claims and runtime scope checks outside the model. | Authenticated workload/user identity; resolved runtime/capability/environment policy pinned to each action; secret references rather than copied secrets. | Explain and deny a capability expansion before a privileged effect occurs. |
| Verification | External gates with retained failures. | Assertion-to-check registry, independent requirements checks, evaluated quality/performance thresholds and honest unsupported coverage. | A candidate that passes its own tests still fails an independently declared requirement. |
| Durable execution | Frozen inputs, operation intent/result, leases, persisted budgets. | Reconcile ambiguous external outcomes, enforce fencing at executor boundaries, idempotency/compensation adapters and budget admission. | Stop/restart across a publication or effect boundary; neither repeat an uncertain effect nor replace approved bytes. |
| Operational composition | Exact provider version and reliance lifecycle. | Executable prepare/activate/retire/drain/cleanup adapters with observed resource identity and outcome. | Existing consumer continues during retirement; new binding is refused; inactive requires observed cleanup. |
| Human control | Evidence-bound decisions and locked executed drafts. | Risk-tiered approvals, comprehensible change alternatives, authenticated signatures, rollback/recovery decisions. | An external architect identifies what is approved, what remains unknown and how recovery works. |

This yields four related records: **intended design, implementation, authorized execution, and observed effects**. Each can disagree with the others. Kernl should retain those disagreements until resolved rather than overwrite them with a confident graph or a successful model response.

### What changes under different AI futures

| Conditional scenario, without a date prediction | Product pressure | Kernl response worth testing |
| --- | --- | --- |
| Strong coding agents become broadly available and inexpensive. | Writing the patch becomes a weak differentiator. | Admit external runtimes; compete on accepted intent, independent verification, exact release lineage and recovery. |
| Agents work for longer periods across more tools and repositories. | Context summaries and ephemeral chats become poor sources of authority. | Version the resolved execution contract, checkpoint decisions and reconcile actions/events by stable identifiers. |
| Agents propose or generate their own helpers and capabilities. | Task-local generated computation may become persistent authority by accident. | Separate task artifacts from capability releases; new persistent permissions require an evaluated, approved version. |
| Models improve but verification stays uneven. | More plausible software is produced faster than reviewers can assess it. | Record evidence coverage and open requirements, improve independent gates, measure reviewer understanding. |
| Capability progress is slower or inconsistent. | Heavy autonomous-operation infrastructure may have little immediate demand. | Keep the narrow change-review/evidence workflow useful with human builders and existing CI. |
| General-purpose agents can competently redesign systems. | The model's proposal quality rises, but organizational intent and effect authority still exist. | Let agents propose AIR and plans; retain independent authorization, factual outcome reconciliation and accountable decisions. |

None of these scenarios proves that customers will buy Kernl. A capable model could reduce the need for a separate architecture abstraction as well as increase change volume. The design must survive both possibilities by reducing review/recovery cost in an observable workflow.

## Relationship to LoopPlane

The inspected sibling repository `loopplane` describes an **architecture scaffold**, not an implemented runtime integration. Its README and `docs/architecture.md` define application-owned capability profiles, credential bindings, immutable resolved run specifications, runtime adapters, evidence and promotion. Those local documents are the evidence for this comparison; provider claims within them have not been refreshed by this source audit.

| Concern | Kernl today | LoopPlane documented direction | Proposed shared boundary |
| --- | --- | --- | --- |
| Main input | Architecture change over an AIR baseline/catalog. | Objective plus agent/capability/environment profiles. | A resolved execution contract referencing the approved change and immutable policy versions. |
| Main output | Verified candidate, evidence-bound decision, promoted workflow. | Governed session outcome and verified business effects. | Normalized action/effect evidence with retained provider identifiers. |
| Worker loop | Direct JSON proposals or deterministic recipe; bounded DSH seam. | Adapter to a managed/self-hosted runtime. | Adapter supplies proposals/observations; product policy admits effects. |
| Persistent capability change | Catalog/AIR evolution. | Candidate capability evaluation and profile promotion. | Changes create new immutable versions; active work remains pinned unless migration is approved. |
| Distinct user problem | “Can we change this system while preserving what matters?” | “What could this agent do, and what did its action actually achieve?” | Kernl can consume a future LoopPlane runtime adapter, without giving it architecture/promotion authority. |

Avoid two competing ledgers and two definitions of approval/effect. First agree on shared contracts for `ResolvedExecutionSpec`, `AuthorizedTask`, `ActionProposal`, `EffectReceipt`, `EvidenceBundle` and `PromotionDecision`. These names are proposals, not existing combined types. Share contracts and adapter semantics before choosing whether either codebase becomes a reusable package. No integration has been performed in this exploration.

## Exploration priorities and open questions

The repository's [NEXT_ITERATION_GOAL.md](../../../NEXT_ITERATION_GOAL.md#L5) already identifies captured-code replay, stronger interruption recovery, executable provider retirement, DSH mutation provenance and an explicit client-supplied approval digest. Keep that implementation contract intact while research decides the product wedge.

For the exploration phase, collect answers in this order:

1. **User value:** Can an external architect explain one current candidate, its changed dependency, failed effect owner, exact decision input and limits without reading a coding chat? Does the graph/evidence reduce review time or add work?
2. **Abstraction burden:** Which architecture fields can come from source and deployment evidence? Which must remain a human statement of intent? How will conflicts be reviewed?
3. **Independent verification:** Which public-contract, delivery and recovery requirements have executable checks? Which assertion strings are only declarations? Who owns the verifier?
4. **Replay contract:** Is the user trying to reconstruct approved code, rerun evaluation, compare outcomes, or repeat a business effect? What exact input and environment equivalence is needed for each?
5. **Runtime strategy:** Do users need the Kernl worker loop, or can their existing coding agents feed proposals and receive evidence through a small adapter?
6. **Commercial wedge:** Will users pay for a narrow architecture-change workflow, for assurance records in their CI, or for capability governance? What event makes adoption urgent?
7. **Moat evidence:** Does each successful/failed change produce reusable contract checks, compatibility knowledge or recovery adapters? A private graph, trace archive or provider wrapper alone is not proof of defensibility.
8. **Operational responsibility:** Who owns deployment and resource cleanup? Which effects are retry-safe, compensatable, approval-gated or irreversible in the actual system?
9. **Exit and portability:** Can a team export its architecture, code, policy/check definitions and evidence and keep operating without Kernl?
10. **Product simplification:** If a single existing coding platform supplied excellent plans, tests and review, which Kernl workflow would still deserve to exist?

The next exploration artifact should be a one-page comparison of positions 1 and 3, using the same current candidate and reviewer questions. No new implementation is required to test that framing. If a later decision resumes the existing implementation direction, its next scoped engineering proof remains captured-code replay. Exploration may instead lead to a smaller integration or a decision to park the product.

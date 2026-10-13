# How much architecture record is enough?

Concept investigation, **2026-10-13**. Proposed records are illustrative: no AIR schema, compiler, database, or runtime was modified.

## Avoid a second codebase in diagram form

The current [AIR schema](../../../packages/core/src/air.ts) includes components, bindings, contracts, verification gates, declared effects, lifecycle policies, and approval gates. The [draft schema](../../../packages/core/src/draft.ts) binds a base AIR version/digest and explicit component/contract operations. These are useful local mechanisms, but describing more of an organization can increase maintenance faster than it increases decision quality.

The smallest research question is: what subset of intended, inferred, and observed facts is needed to accept one change? A permanent global graph should be a later option, not a prerequisite for trying the acceptance record.

## Reuse existing views without confusing their meanings

OpenAPI describes HTTP interfaces; AsyncAPI describes channels, messages, and application operations; a software catalog can identify ownership and dependencies. These are useful inputs but different statements. Describing a channel does not establish its actual durability, and a catalog dependency does not prove observed traffic. [OpenAPI](https://spec.openapis.org/oas/latest.html), [AsyncAPI structure](https://www.asyncapi.com/docs/concepts/asyncapi-document/structure), [Backstage descriptors](https://backstage.io/docs/features/software-catalog/descriptor-format).

Those primary documents were retrieved on 2026-10-13. They are living/versioned references, not claims that an import adapter exists in Kernl. Do not replace their mature vocabularies with a comprehensive proprietary schema simply to render a graph.

Backstage also explicitly says its owner field is for understanding responsibility and should not be used by automated processes to assign runtime authorization. Importing a catalog owner can identify a contact; it cannot grant that identity authority over an effect. Any such authority needs a separate authenticated source.

| Fact class | Example in the queue change | Authority and uncertainty |
|---|---|---|
| Intended | The accepted HTTP response shape must remain stable | Named owner and accepted contract; may still be incomplete |
| Source-observed | This candidate invokes this queue client | Exact source snapshot and inspection method; not evidence of production traffic |
| Runtime-observed | A particular deployed worker read the selected queue during an observation window | Observer, artifact/resource identity, time window, sampling and missingness |
| Inferred | This API probably depends on this worker based on static analysis | Inference method, source pointers, unresolved alternatives; confidence is not authority |
| Decided exception | Temporary coexistence of two event versions is accepted | Accountable decision, conditions and expiry; not an unnoticed graph discrepancy |

These classes can conflict. Preserve the conflict until a named process resolves it. An intended edge is not wrong because it is not deployed yet; an observed edge is not authorized because it exists.

## A minimal per-change record

The following is conceptual notation, not accepted Kernl JSON:

```text
Change: preserve the specified jobs contract while introducing queued processing
Baseline: source snapshot + existing contract references + relevant environment observations
Intent: accepted behavior, non-goals, owner, unresolved questions
Affected subset: API -> queue -> worker -> store, with evidence origin per relation
Authority: allowed actions/resources + external authority reference + expiry
Criteria:
  selected HTTP compatibility -> protected contract check
  duplicate-delivery behavior -> recorded fixture check, with its stated limits
  durable acceptance of work -> unknown; needs an actual persistence/acknowledgment contract
Candidate: source and built-artifact identifiers, where available
Evidence: checker/version/input/result + applicability + assumptions + freshness dependencies
Decision: exact candidate/evidence + identity + accepted unknowns + effect scope
Observation: actual deployed artifact/resource + observed outcome, or explicitly absent
```

The important distinction is not the field names. It is whether the record forces a reviewer to notice that the HTTP fixture and duplicate event test do not establish durable processing. The useful record may contain only a handful of links and a few explicit unknowns.

## Work backwards from each claim

| Claim | Evidence dependencies | Invalidation or review trigger |
|---|---|---|
| Selected contract preserved | Candidate bytes, check version, contract version, runtime assumptions | Changed candidate or relevant contract/check/environment |
| Queue delivery obligation met | Producer acknowledgment rule, broker config, consumer commit/deduplication semantics, observed persistence | Changed broker/consumer policy or incomplete observation |
| Reviewed work stays in scope | Task/resource scope, actual executor identity and access, tool semantics | Expanded tool permissions, changed identity, or new effect path |
| Approved artifact is the one running | Approved subject digest, build/deployment mapping, observed target version | Different built artifact, replacement deployment, or unknown mapping |
| Retirement is complete | Enumerated consumers, relevant observation window, resource cleanup result | New/unknown consumer, changed routing, expired observation |

Some triggers can be determined by exact identifiers; others require interpretation. The product should distinguish invalid, stale, still valid under unchanged assumptions, and needs review. Rechecking everything wastes effort; guessing that nothing relevant changed can create false assurance.

## Drift walkthrough

1. A candidate is checked against source baseline B1 and contract C1.
2. Another change merges, producing B2. Native integration checks should evaluate the combined state; a custom record must retain the correspondence rather than silently attach B1 evidence to B2.
3. A queue configuration changes after code review. Passing source checks does not establish the new delivery/retention semantics.
4. The deployed worker is rebuilt from the same source with different relevant dependencies. Source identity alone is insufficient for the artifact-level claim.
5. A new consumer is discovered during retirement. The claim about complete consumer coverage becomes uncertain even if existing nodes remain unchanged.
6. An evaluator is improved. The old report remains a valid record of what the old evaluator did; it is not automatically a result under the new evaluator.

These are hypothetical cases. The current local alpha has content bindings and locked/frozen execution inputs, but no general cross-system freshness engine implementing this walkthrough.

## Do not make freshness a timestamp-only rule

A recent observation can be irrelevant to the target artifact, and an older proof can remain valid for unchanged premises. Record what an observation refers to and which assumptions it depends on. Expiry is a policy decision; it should not be disguised as mathematical invalidity.

For an asynchronous transition, state the unit of duplication being considered, the boundary of acknowledgment, persistent state, ordering needs, and what happens after a crash. An abstract queue edge cannot infer these obligations. Better models can help ask the questions but cannot turn absent observations into measured facts.

## Three interfaces to compare

| Interface | Maintenance burden | Potential value | Failure/exit criterion |
|---|---|---|---|
| Ordinary PR instructions and checks | Lowest new-system burden | Familiar review and native enforcement | Important criteria and evidence relationships remain repeatedly unclear |
| Per-change packet with an affected subgraph | Maintain only the change and linked evidence | Clearer coverage, decisions and invalidation | Setup and review add effort without improving decisions |
| Permanent architecture workspace | Keep intended/inferred/observed views reconciled across changes | Reusable dependency reasoning and lifecycle history | Frequent manual repair makes the graph stale or untrusted |

This is a comparison proposal, not measured usability. Evaluate the same change and evidence in all three interfaces, and include preparation labor. Do not give the graph interface extra requirements that the PR baseline never received.

## Questions a reviewer should answer

- Which behavior is promised, and which important requirement remains unknown?
- Is each visible relation intended, inspected, measured, or inferred?
- What changed since this evidence was produced, and does it affect the claim?
- Which exact code or artifact is being approved, and which external effect is excluded?
- Can the next person reconstruct the decision from native source records without trusting a model summary?

If AIR does not improve these answers over a small packet, keep AIR optional. If the packet itself does not help, improve the existing workflow and park the new layer. Architecture should be a useful aid to a decision, not another mandatory deliverable.

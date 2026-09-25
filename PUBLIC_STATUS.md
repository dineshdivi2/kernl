# Kernl: concept and verified status

Last reviewed: 2026-09-25. This page separates the product direction from the local prototype's demonstrated behavior.

## Product direction

Kernl aims to turn an architect's proposed system change into a bounded, reviewable execution: architecture intent and catalog state define a task graph; scoped agents implement it in isolated Git worktrees; deterministic gates and evidence decide whether an exact candidate can be approved and promoted. The architecture record (AIR) states intended design, Git records implementation, and sealed evidence connects them.

The longer-term questions are how to support genuinely variable component and binding changes, unfamiliar repositories, captured-code replay, durable effect recovery, and safe execution boundaries. Those are research and engineering directions, not capabilities already proved by this prototype.

## Dated implementation evidence

- 2026-08-20/21: an out-of-tree DeepSeek Harness (DSH) Cordis adapter was built with five bounded model-facing Kernl tools. Offline tests and a keyless real-DSH load/tool smoke establish the integration seam. An optional bounded live smoke tests one model-to-validation-tool route.
- 2026-09-12/13: the local product alpha exercised architecture drafts, catalog-backed task compilation, worktrees, failure/repair/verification, evidence-bound approval, promotion, and replay. A direct DeepSeek provider run passed its final gates after one scoped repair but remained awaiting user approval. Direct provider execution and DSH orchestration are separate paths.
- 2026-09-13: a later local authoring iteration added explicit compatible templates, structured graph-node editing, promoted-baseline selection, and required catalog gates. Its source was uncommitted at the time of this publication preparation; the dated verification is recorded in `AUTHORING_ITERATION.md`.

## Boundaries

The implemented slice is a local jobs-system example. It does not establish arbitrary architecture design, a production sandbox, running hot replacement, a general concurrent scheduler, or full DSH-led mutating-agent orchestration. Recipe replay refuses live-generated code until captured-code replay is implemented. See `PRODUCT_HANDOFF.md`, `AUTHORING_ITERATION.md`, and `packages/dsh-plugin/README.md` for the detailed evidence and limits.

## Suggested next proof

Demonstrate two architect-chosen changes against a promoted baseline, then replay a captured live-generated implementation with exact content and plan digests and zero duplicate effects. Record failure cases as well as successes.

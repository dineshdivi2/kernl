# Native assurance is the baseline

Reviewed **2026-10-13**. This is a documentation comparison, not a benchmark, a security audit, or an installed integration. Features are described as documented; plan/account/configuration boundaries still need checking for any actual deployment.

## Begin with the strongest simple alternative

For the synchronous-to-queue change, a competent team could use a coding agent, repository instructions, protected acceptance tests, PR review, merge checks, signed build provenance, a controlled deployment workflow, and operational monitoring. Kernl must be compared with that workflow, not with an agent lacking tests or permissions.

The question is whether one small additional record makes the intended change, evidence coverage, dependency assumptions, and decision easier to inspect. It is not whether Kernl can reproduce a merge button, an approval dialog, or a durable task log.

## What the existing stack documents

| Surface | Documented capability | Task-specific obligation still belonging to the team |
|---|---|---|
| GitHub merge queue | Required checks run against the target branch plus queued changes; CI must handle merge-group events | Define checks that actually capture the migration's contract and duplicate-delivery obligations |
| GitHub artifact attestations | Signed provenance links an artifact to its source/build context; consumers must verify it | Decide which trusted producer and policy are acceptable, then evaluate intended behavior |
| GitHub deployment environments | Environment protection gates and restricted secret access support deployment workflows | Bind the approved artifact and real target, and observe the effect after the job runs |
| SLSA verification | Compare signed provenance, artifact subject, builder trust, and expected build parameters | Specify the correct expectations and acknowledge the trusted platform boundary |
| Temporal tasks and Nexus | Durable history, attempts, retries, and identifier-based deduplication support workflow execution | Make application effects retry-safe and reconcile ambiguous external outcomes |
| OpenAI incident-agent example | Persistent investigation with application-owned approval handling | Its sample records rollback approval without executing a deployment; deduplication and responder permissions remain application responsibilities |

These descriptions do not prove a general gap in vendor products. A team can add custom checks and records to the existing stack. Kernl's potential advantage would be a better, reusable representation of the acceptance problem with a reasonable integration cost.

The merge queue documentation establishes checks against combined branch state and has account/repository availability limits; it does not supply the meaning of those checks. GitHub's attestation guide explicitly distinguishes provenance from assurance that an artifact is secure. Its provenance machinery should be reused where suitable rather than renamed as a new Kernl invention. [Merge queues](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue), [attestation concepts](https://docs.github.com/en/actions/concepts/security/artifact-attestations).

Environment secrets become available after configured reviewer approval. Self-hosted runners are not isolated containers merely because they use an environment. This illustrates the difference between workflow gating and execution isolation. [Deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

SLSA verification includes artifact/provenance correspondence, signature and builder trust, plus expectations for build type and external parameters. Its trust model does not eliminate compromise of the trusted build platform. These are supply-chain statements, not proof that the program preserves an API or processes an event once. [SLSA verification](https://slsa.dev/spec/v1.2/verifying-artifacts).

Temporal distinguishes a durable logical activity from its attempts. Nexus describes at-least-once handler invocation and recommends idempotent handlers; its documented exactly-once upgrade has Workflow ID, namespace, and retention conditions. Those conditions should not be generalized into a guarantee for an arbitrary external charge or notification. [Tasks](https://docs.temporal.io/tasks), [Nexus operations](https://docs.temporal.io/nexus/operations).

The OpenAI example separates the application-owned rollback decision from its execution and warns that its first investigation uses bundled sample evidence. It provides a concrete counterexample to treating an agent approval flow as an operational action receipt. [Incident-response example](https://developers.openai.com/cookbook/examples/agents_api/apps/sev_bot/readme).

## Walk through the migration against that baseline

| Acceptance question | Existing evidence path | Possible extra record | Current Kernl limitation |
|---|---|---|---|
| What behavior should remain the same? | Issue/PR requirements plus HTTP and event contracts/tests | Versioned acceptance criteria linked to each check | Fixture contracts cover selected behavior only |
| What is permitted to change? | Native tool permissions, repository ownership, protected paths, review rules | Explicit scope and relevant authority reference beside the change | Local roles and process controls are not authenticated distributed authorization |
| What exact result was checked? | Commit/merge-group check identities, build provenance and artifact digest | Join source, build, check, decision, and target identifiers | Current archived reports bind candidate commits; not a universal artifact/deployment record |
| Does an updated baseline invalidate the result? | Merge queue/rechecks for source integration | Evidence-dependency invalidation beyond source merges | No general runtime drift reconciliation |
| Was the important behavior independently tested? | Protected tests and appropriate external review | Requirement-to-check coverage, including unknown and not-applicable outcomes | Declared assertion strings do not constitute a general checker |
| Did the accepted artifact actually run? | Deployment records and independent resource observation | Intended versus observed artifact and target comparison | Local workflow promotion is not production deployment |
| Can uncertain effects be retried? | Executor/resource idempotency and workflow reconciliation | Per-effect classification and visible unknown outcome | No general distributed compensation or exactly-once external effect proof |

Every extra-record column is a proposal. Several can be implemented as conventional PR metadata, custom checks, or deployment annotations. The comparison must establish a repeatable advantage before selecting a separate workspace.

## Smallest competing product shapes

1. **No Kernl:** improve the existing PR template, protected checks, provenance verification, and release process. This is a valid outcome if it addresses the pain.
2. **A small acceptance packet:** reference native identifiers and expose requirements, evidence coverage, unknowns, preconditions, and the decision. It could be a library or CI integration.
3. **An architecture workspace:** add graph editing, scoped planning, and lifecycle decisions only where those interactions demonstrate value beyond the packet.

The second option should not become a second ledger of every runtime event. Preserve source IDs and evidence origin, retrieve immutable records where possible, and clearly distinguish a cached observation from the authoritative system. A common wrapper must not imply identical tool, retention, approval, or recovery semantics across providers.

## Evidence that would justify another layer

Observe a target workflow in which reviewers repeatedly lose the relation between intended change, relevant baseline, check coverage, exact candidate, and operational consequences. Then demonstrate that the smaller packet improves decisions with less total effort after setup and maintenance are counted. Include an ordinary simple change where the extra layer should add no value.

If the same record is easy to express in an existing product and reviewers understand it equally well, integration or documentation is a better direction than a new platform. If no independent evidence can answer the important criterion, an additional signed report does not solve that problem.

## Source register

All are primary living documentation retrieved 2026-10-13. No release date is inferred from retrieval; no account-specific availability or live conformance was tested.

| Source | Scope used |
|---|---|
| GitHub merge-queue guide | Combined-state checks and integration/configuration boundary |
| GitHub attestation concepts | Build provenance, verification, and explicit security limitation |
| GitHub deployment environments | Protection/secrets boundary and self-hosted execution caveat |
| SLSA v1.2 verification | Expectations, subject/signature checks, and trust boundary |
| Temporal Tasks and Nexus Operations | Logical execution versus attempts, deduplication conditions, handler idempotency |
| OpenAI SRE cookbook | Approval versus execution and application-owned responsibilities |

The claims above are deliberately narrow. The missing end-to-end migration experiment is an unresolved research item, not evidence of vendor inadequacy.

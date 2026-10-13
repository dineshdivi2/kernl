# Capability and runtime signals

As of **2026-10-13**. This is a selective evidence review, not a complete frontier-model leaderboard. The conclusions below are inferences for Kernl unless explicitly identified as a source result.

## What the pace means for a project decision

Track four different things: what a model can solve, what the surrounding runtime provides, how reliably the whole system works, and what value a team actually obtains. A fast release cadence in any one does not establish the other three.

The important observed change is that suppliers now sell the execution system around the model. An architecture-control project should assume that loops, context management, subagents, tools, and resumable work will improve without Kernl implementing them. Its research question shifts toward the parts a customer needs to own across those systems.

## OpenAI: a dated movement from tasks to managed execution

| Date or observation | Primary evidence | What it establishes | Kernl implication |
|---|---|---|---|
| 2025-05-16 | [Introducing Codex](https://openai.com/index/introducing-codex/) | Historical launch of a cloud coding agent using separate task environments, code editing, tests, and reviewable outputs. The page now explicitly identifies itself as outdated. | Do not treat an isolated code-and-test loop as a novel current product boundary. |
| 2026-02-05 | [GPT-5.3-Codex](https://openai.com/index/introducing-gpt-5-3-codex/) | Vendor announcement of more capable interactive, longer-running coding and computer work, including assistance with its development pipeline. | Agent-assisted model development is evidence of assistance, not autonomous recursive self-improvement. |
| 2026-09-29 | [DevDay 2026 recap](https://openai.com/index/devday-2026-recap/) | Announcements include ongoing-responsibility agents, reusable cloud environments, Agents API, and broader collaboration. Availability and preview labels differ by feature. | A standalone orchestration surface competes with increasingly integrated work products. |
| Documented by this review | [GPT-6.1 Sol](https://openai.com/index/introducing-gpt-6-1-sol/) | Vendor reports stronger coding, computer-use, and professional performance with lower cost relative to its Astra model. The recap links the launch. Benchmarks and selected error-inducing safety tests have stated conditions. | Compare total cost per accepted change; token prices and benchmark wins alone do not determine Kernl's value. |
| Current docs read 2026-10-13; publication date not asserted | [Agents runtime comparison](https://developers.openai.com/api/docs/guides/agents) and [Agents API overview](https://developers.openai.com/api/docs/guides/agents-api/overview) | Managed Codex harness, durable sessions, compaction, orchestration, tools, environments, and recovery are documented. SDK and managed API are different execution models. | Integrate with appropriate runtimes; avoid rebuilding common harness capabilities merely to own the loop. |

This sequence shows changes to both capability and product packaging within a short period. It does not provide a constant improvement rate, a comparable score series across changing benchmarks, or an AGI date.

## The current boundary between supplier and application

The [Agents API architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture) separates the hosted harness, optional environment, and application server. A self-hosted environment leaves provisioning, connection, shutdown, and retained files with the application. Function tools require a working application handler. This is a documented integration seam, not an experiment performed here.

The [SDK guardrail and review guide](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals) already documents blocking checks, tool approval interruptions, and serialized resume state. It also explains that agent-level input and output guardrails do not surround every intermediate action. A checkbox labeled approval is therefore not a sufficient distinction for Kernl.

**Inference:** explore an organization-owned acceptance contract that can be enforced at existing tool, repository, and deployment boundaries. Decide who owns each boundary before choosing an adapter. A runtime's session history can become one input to the change record, but the session is not itself the authoritative evidence that a business effect occurred.

## Independent capability evidence: progress with measurement limits

The January 29, 2026 [METR Time Horizon 1.1 update](https://metr.org/blog/2026-1-29-time-horizon-1-1/) expanded the suite from 170 to 228 tasks and the 8-hour-or-longer subset from 14 to 31. It retained an approximately seven-month long-run doubling trend; the post-2023 fit changed with the task suite. Human times were directly measured for only five of the 31 long tasks. These findings support rapid progress on the measured distribution and uncertainty about its precise slope.

The [time-horizon dashboard](https://metr.org/time-horizons/) says it was last updated September 8, 2026 and is **no longer actively updated**. It also warns that estimates above 16 hours are unreliable with its current suite. It is useful historical evidence, not a current October frontier ranking. Missing measurements should remain missing.

The January 22 [limitations note](https://metr.org/notes/2026-01-22-time-horizon-limitations/) explains that the metric is human-equivalent task duration at a success probability, not elapsed autonomous working time. Results vary greatly across domains; clean, self-contained tasks differ from collaborative, ambiguous work. High-reliability delegation and months-long extrapolation require evidence beyond a fitted 50% curve. It is a researcher note with less review than METR's research posts.

**Inference for Kernl:** increasingly long coherent tasks are a plausible design pressure. Avoid designing around a fixed model limitation that could disappear. At the same time, successful isolated tasks cannot certify arbitrary multi-system changes or authorize their effects.

## Productivity: separate perception from measured outcome

METR's [May 11, 2026 survey](https://metr.org/blog/2026-05-11-ai-usage-survey/) covered 349 technical workers and reported median perceived value uplift of 1.4–2 times. These are self-reports from a convenience sample, with explicit concerns about selection and counterfactual judgment. The February 24 [experiment redesign](https://metr.org/blog/2026-02-24-uplift-update/) discusses how wider adoption creates selection effects in follow-up productivity experiments. Neither provides a causal October productivity multiplier.

**Inference:** the appropriate Kernl outcome is valuable accepted change per unit of total effort, including specifying, waiting, checking, correcting, and operating it. Count reviewer minutes and avoided failures. Do not substitute number of generated patches or claimed time savings for this measure.

## Source register

All sources above were retrieved on 2026-10-13. Publication dates are recorded only where established by a dated page or announcement. The two runtime comparisons and implementation guides are living documentation; this review does not assert when each capability first became available.

| Evidence type | Sources used | How to use them |
|---|---|---|
| Historical vendor release | Codex May 2025; GPT-5.3-Codex February 2026 | Explain the historical shift, retaining launch-specific scope |
| Recent vendor release and evaluation | DevDay September 2026; GPT-6.1 Sol | Verify current claimed product shape; vendor measurements need their conditions |
| Living technical documentation | Agents comparison, overview, architecture, SDK approval guide | Establish documented current interfaces and ownership boundaries; no live integration claim |
| Independent benchmark methodology | METR TH1.1 and limitations note | Understand progress and measurement uncertainty; no current complete leaderboard |
| Historical dashboard with a stopped refresh | METR time horizons | Retain last-update date and warning about saturation |
| Survey and research-design update | METR May survey and February redesign | Separate perceived productivity, selection effects, and causal evidence |

## Questions this evidence leaves open

1. Which architecture-significant changes can current coding agents already complete under native controls?
2. Does an explicit change contract lower total review effort or simply duplicate instructions and CI configuration?
3. Can a small integration record the required artifacts and authority while keeping the managed harness replaceable?
4. Which acceptance criteria require independent domain judgment or operation beyond source-code gates?
5. How much evidence is inspectable and exportable when a provider changes its harness, model alias, or retention policy?

These require focused comparisons and user observation. The research does not answer them with vendor release notes.

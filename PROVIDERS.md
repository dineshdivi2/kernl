# Inference providers

Credentials are read only from the process environment. Do not paste keys into chats, UI fields, config, logs or Git. No credential files are read or created. Child verification processes receive an allowlisted environment without inference credentials.

| Provider | Environment variable | Default model | Endpoint |
| --- | --- | --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-flash` | `https://api.deepseek.com/chat/completions` |
| OpenRouter | `OPENROUTER_API_KEY` | `deepseek/deepseek-v4-flash` | `https://openrouter.ai/api/v1/chat/completions` |
| Nous / Hermes | `NOUS_API_KEY`, fallback `HERMES_API_KEY` | `Hermes-4-70B` (unverified availability) | `https://inference-api.nousresearch.com/v1/chat/completions` |

Model overrides: `KERNL_DEEPSEEK_MODEL`, `KERNL_OPENROUTER_MODEL`, `KERNL_NOUS_MODEL`, or explicit model selection in the UI/CLI. API base URLs are not user-controlled. We interpreted the request's “Hermis” as Nous/Hermes; configure a different adapter if another vendor was intended.

## Verified on this device, 2026-09-12

- DeepSeek small live JSON completion: passed, 49 prompt / 16 output tokens. Provider returned no USD cost.
- OpenRouter small live JSON completion: passed, 26 prompt / 17 output tokens. Provider reported cost `0.0000040068` USD for that request only.
- Nous: authenticated model listing returned successfully, but no IDs containing Hermes or Nous were available. No inference request was sent to an unrelated fallback model. Full Hermes inference remains blocked by model/endpoint access, not an absent local key.
- DeepSeek architecture trial: first run stopped after the configured three failed repairs. After correcting deterministic failure-owner routing, a fresh run passed all gates with four requests and one worker-scoped repair. It remains `AWAITING_APPROVAL` for the user, run `run-2026-09-12T08-50-36-229Z-851960f9`.

## Limits and failure behavior

Default live product run: six total requests, up to three repair attempts, 3,072 output tokens/request, 60-second request timeout, no automatic transport retry, 64,000-character input cap, 4,096 hard maximum output limit, maximum eight returned files. Request reservations persist before network calls, including uncertain calls. Model/tool/context hashes and usage metadata enter the ledger; raw reasoning does not.

Unknown HTTP error bodies are withheld. Proposals must match `{summary, mutations:[{path,content}]}` and pass path/write-scope and secret checks outside the model. No model tool calls or shell strings are executed. Git and verification still run locally: a worktree is not a hostile-code security boundary.

There is **no guaranteed dollar-denominated spend cap** in this adapter. The plan's existing `maximumModelSpendUsd` declaration is not authoritative live billing enforcement. Configure provider-side spend limits before broad live use. Only request/token/time bounds are enforced here. There is no unbounded swarm.

## Offline stubs

`stubProviderTransport` implements the same response boundary without sockets. `tests/runtime/providers.test.ts` covers all three providers, missing keys, malformed proposals, metadata and withheld failures. CI never requires real credentials.

## Official references

The API implementation was checked against [DeepSeek first call](https://api-docs.deepseek.com/), [OpenRouter API overview](https://openrouter.ai/docs/api_reference/overview), and [Nous Portal integration](https://hermes-agent.nousresearch.com/docs/integrations/nous-portal). Model names/access can change; empirical smoke results above are time-specific. The documentation-search skill informed fixed endpoints and normalized completions; it did not establish live model access by itself.

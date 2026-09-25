# Kernl DSH bundle

This package is the out-of-tree DeepSeek Harness adapter for Kernl. It provides a stateless `ctx.kernl` HTTP client and five model-facing tools. Kernl remains the source of truth for architecture, authorization, task state, effects, verification, approvals, and workflow promotion.

The runtime JavaScript has no npm dependencies and imports no DSH internals. The default bundle uses only the documented structural Cordis seams supplied at runtime: `ctx.provide`, `inject`, `ctx.get`, and `ctx.tools.register`. The opt-in live-smoke module additionally uses the documented Agent events, `tools.guard`, per-Agent `tools.restrict`, and tool-run `concludeTurn` seam. This keeps local installation keyless and offline once the package is built.

## Tool and API contract

After registering its complete set, the consumer provides a lifecycle-bound `ctx.kernlTools` readiness service. This lets diagnostics depend on completed registration instead of racing sibling plugin activation. The bundle registers exactly:

- `kernl_validate_change` → `POST /api/dsh/validate-change`
- `kernl_compile_plan` → `POST /api/dsh/compile-plan`
- `kernl_claim_task` → `POST /api/dsh/claim-task`
- `kernl_record_result` → `POST /api/dsh/record-result`
- `kernl_verify` → `POST /api/dsh/verify`

Each tool accepts `{ "request": { ... } }`. The inner object is sent unchanged as the JSON request body. Kernl performs the route-specific validation and returns one of:

```json
{ "ok": true, "value": { "canonical": "JSON result" } }
```

```json
{ "ok": false, "error": { "code": "ERROR_CODE", "message": "Safe message", "details": null } }
```

Approval decisions and workflow promotion are intentionally not model-facing tools. Agents may produce evidence or a proposed result, but the Kernl control plane owns those state transitions.

The raw DSH `ToolDefinition` output schema is `{}`: in the current enforced JSON Schema subset, an annotation-only node means unconstrained lossless canonical JSON. The authoring shorthand `{ "type": "json" }` is not valid when registering a structural definition directly.

## Build and keyless verification

From the prototype root:

```powershell
pnpm --filter @kernl/dsh-plugin build
node --test .\packages\dsh-plugin\test\plugin.test.mjs
pnpm dsh:smoke
```

The Node tests use a fake Cordis context and fake Fetch implementation. They cover successful provider/tool loading, all five routes, cleanup, missing-provider failure, argument rejection before HTTP, structured API errors, and credential-bearing configuration rejection.

## Install into a DSH profile

Build first, then from the DSH checkout:

```powershell
pnpm dsh plugin --profile kernl add "C:\absolute\path\to\kernl-prototype\packages\dsh-plugin"
pnpm dsh --profile kernl --dump-config
```

The stable patch row ids are `kernl-service` and `kernl-tools`. A profile overlay may replace the complete `kernl-service` config:

```yaml
- id: kernl-service
  config:
    baseUrl: 'http://127.0.0.1:43120'
    routePrefix: '/api/dsh'
    requestTimeoutMs: 30000
    maxResponseBytes: 1048576
```

Cordis patches replace the complete `config` object rather than deep-merging it, so restate every field when overriding the row.

## Real DSH load smoke on Windows

After building the package:

```powershell
pwsh -NoProfile -File .\packages\dsh-plugin\scripts\smoke-real-dsh.ps1
```

The script:

1. creates a unique directory below the system temporary directory;
2. passes it to child processes as `DSH_HOME`;
3. removes `DEEPSEEK_API_KEY` from each child environment without reading or printing it;
4. starts a keyless loopback fake Kernl API;
5. stages only the prebuilt package payload at a no-space temporary path and installs it into the temporary profile (the current DSH Windows pnpm forwarder uses `cmd.exe`);
6. verifies `--dump-config` contains both stable rows;
7. boots a one-off probe that calls `kernl_validate_change` through the real DSH tool pipeline;
8. requires both execution and Cordis-unload sentinels;
9. confirms the upstream DSH Git status is byte-for-byte unchanged;
10. removes only the verified temporary directory unless `-KeepTemporaryHome` is supplied.

Use `-DshRepository <path>` if the checkout is elsewhere. The script starts the source CLI directly through its existing `tsx` loader, so invoking it cannot trigger pnpm's workspace dependency-status reinstall. It reads the checkout's declared `pnpm@<version>`, prefers that exact version from the local Corepack cache, and places a temporary shim first on child `PATH` for the profile-local plugin install; `-PnpmCli <path-to-pnpm.cjs>` overrides discovery. It never permits a different pnpm version to replace the upstream `node_modules`. The smoke is deliberately not an LLM test and needs no model credential.

The script requires Node.js 22.19 or newer. When the `node.exe` on `PATH` is older, it also looks for an installed `node-v22*-win-x64\node.exe` beside the DSH checkout; `-NodeCommand <path>` remains the explicit override.

## Opt-in bounded live DeepSeek smoke

If `DEEPSEEK_API_KEY` is already present in the invoking environment, run exactly one live DeepSeek V4 Flash request and at most one Kernl tool dispatch:

```powershell
pwsh -NoProfile -File .\packages\dsh-plugin\scripts\smoke-real-dsh.ps1 -LiveDeepSeek
```

This mode uses a unique temporary `DSH_HOME`, the loopback fake Kernl API, native tool presentation, read-only sandbox policy, disabled telemetry, disabled title generation, `maxTokens: 512`, and provider retry count zero. A one-off guard restricts the Agent to `kernl_validate_change`, denies a second tool attempt, rejects a second model request, and requires one successful result. The tool's smoke-only configuration marks that result as terminal, so no follow-up model request is needed. The script never prints the model response or credential, redacts credential-shaped diagnostics, deletes the live session directory even on failure, and refuses `-KeepTemporaryHome` in live mode. The guard and terminal behavior are not enabled by `cordis.patch.yml`.

## Current limitations

- The structural tool object matches DSH `0.1.0-rc.7`, which is a developer preview. The real load smoke is the compatibility gate after a DSH update.
- This package does not use the DSH workflow worker. That engine does not journal or resume and its in-process children do not provide independent worktree roots.
- The adapter does not add custom DSH session event types. Existing DSH tool call/result events retain the model-visible trajectory; Kernl's SQLite ledger retains authoritative run and effect state.
- The five schemas intentionally keep the route request object open. The Kernl API owns exact AIR/run/task DTO validation and returns structured failures.
- The keyless real smoke proves bundle discovery, provider activation, tool registration/execution, and effect disposal. The optional live smoke proves one bounded model-to-tool route, not general model quality or concurrent agent isolation.

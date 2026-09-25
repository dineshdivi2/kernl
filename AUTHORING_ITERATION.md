# Architecture authoring iteration — 2026-09-13

This iteration improves the existing Kernl product. No LoopPlane integration, new provider, paid model call, or approval of an existing user candidate is included.

## Changes

- Bootstrap and implicit new drafts prefer the latest persisted promotion for the jobs system. The response includes the promoted source commit. Merely compiling a draft or leaving a run awaiting approval does not advance this baseline.
- New architecture changes start empty. The architect explicitly selects a compatible queue or retry/dead-letter template, or stages catalog operations. Templates are validated against the baseline before being offered; they are not model-generated proposals.
- Structured title/intent, catalog additions, version changes, removals, dependency rebindings and undo share the JSON draft. Graph nodes select the component to edit. Every edit invalidates the compiled execution plan.
- Opening an older draft loads its own baseline rather than displaying whichever graph was previously open.
- Compilation includes required verification gates from all surviving catalog components, even when the draft requests only build. Conflicting commands for the same gate ID fail validation.
- The demo script explicitly selects a compatible template and explains when no template remains, rather than trying to execute the empty starter.

## Verification

Final settled-source checks, using the workspace's Node 22.23.1 runtime:

- Root suite: 20 test files, 89 tests passed (257.74 seconds).
- Web suite: 2 test files, 5 tests passed.
- DSH plugin offline suite: 7 tests passed; fake-context smoke is not a paid live-provider call.
- Workspace typecheck and build passed; final web build passed after the graph accessibility adjustment.
- `git diff --check` passed.

An earlier in-flight suite encountered the new required-gates test while retaining the older compiler module. The fresh focused suite passed 12 tests, and the full rerun above passed. These final results supersede that mixed-source run.

The API regression exercises sync-to-queue execution and promotion, database reopen, retry/dead-letter template selection, compilation, and execution from the actual promoted Git workspace. It verifies that the second unapproved run does not replace the baseline. All these are disposable offline test runs.

The browser walkthrough uses a separate database (`data/authoring-ui-check-20260913.sqlite`), not the user's saved runs. It checks empty authoring, graph-node selection, binding staging/undo, explicit template selection, successful compilation, and stale-plan invalidation. No browser execution or promotion is performed. The separate loopback preview is at http://127.0.0.1:3027/ while its local process remains running.

## Remaining boundaries

- This is a fixed local jobs-system catalog, not arbitrary repository ingestion or general source generation. Component IDs and source layouts are still constrained by the recipes.
- Graph selection opens structured controls; this is not drag-and-drop graph authoring. Advanced contract edits remain JSON-based.
- Free-text intent does not generate alternative architecture proposals. Templates require explicit selection.
- V2 runs catalog gate commands. This is not exhaustive proof of every declarative architecture assertion; the legacy V1 verifier remains queue-specific.
- Captured-code replay for live-generated implementations, unfamiliar-service validation, and independent architect usability measurement remain future work.
- The existing loopback server must be restarted to pick up API source changes; rebuilding alone updates static UI assets, not an already-running API process.

# Kernl

**A governed execution-runtime prototype for bounded agent workflows.**

Kernl explores the promotion boundary between exploratory model behavior and reliable execution.

An agent may propose a plan, inspect evidence, or attempt a repair. Before that work becomes durable or externally consequential, it should be represented as an explicit execution graph with authority, dependencies, checks, and receipts.

```text
exploratory agent work
        ↓
candidate execution graph
        ↓
policy and approval gates
        ↓
bounded effects
        ↓
deterministic verification, evidence, replay
```

## Core ideas

- Explicit execution graphs rather than implicit conversational plans
- Bounded capabilities and authority per step
- Isolated workspaces for change execution
- Append-only evidence and effect receipts
- Replayable runs and deterministic repair paths
- Human approval at meaningful authority boundaries

## Scope

This is a prototype and design repository, not a claim of a general production platform. The initial focus is local, scenario-specific workflows where the value of explicit state, evidence, and recovery can be tested directly.

## Research question

Can a runtime make agent-driven changes more inspectable, reversible, and verifiable by compiling exploratory work into a governed graph before execution?

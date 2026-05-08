---
description: Naming and product stack for Aries Preview, Compose Loop, MnemosFS, Aries Core, and future Ori Nous.
type: decision
tags:
  - aries
  - compose-loop
  - mnemosfs
  - ori-nous
  - substrate
  - product
---

# Aries Substrate Stack: Compose Loop To MnemosFS To Nous

Date: 2026-05-08

## Retrieval Anchor

When asked "what are we building?", "what is Aries?", "what is next after Compose Loop?", or "how does this lead to Ori Nous?", surface this node.

## Stack

```text
Compose Loop proves stateful execution works.
MnemosFS gives stateful execution durable memory.
Aries Core is the runtime that uses both.
Aries Preview is the product surface.
Ori Nous emerges later when this becomes a full kernel.
```

## Product Boundary

Release **Aries Preview** as one product with two surfaces:

- interactive UI/cockpit
- headless mode

Do not split headless into a separate product. Headless is the proof engine and automation surface. UI is the human-in-the-loop surface. Both run on the same Aries Core substrate.

## Mechanism Boundary

Compose Loop is the research mechanism:

- preflight/update blocks
- scratch file persistence
- Repl gates
- telemetry
- state reuse

Its claim is not "composition helps everything." Its claim is:

> Compose Loops improve agent work when tools share state, by turning tool fanout into stateful runtime computation.

## Memory Boundary

MnemosFS is the next substrate layer:

- memory as addressable files
- session-scoped working memory
- vault-wide durable memory
- compaction into handles
- promotion from scratch to lessons

This turns memory from recall API into workspace.

## Nous Boundary

Do not market Ori Nous as complete yet. Ori Nous is earned when execution, memory, goals, compaction, delegation, sensors, permissions, and observability share one kernel-level abstraction.

Until then:

```text
Ori Mnemos remembers.
MnemosFS makes memory navigable.
Aries Core runs.
Aries acts.
Ori Nous emerges.
```

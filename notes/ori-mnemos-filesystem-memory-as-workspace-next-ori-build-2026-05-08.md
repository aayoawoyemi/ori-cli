---
description: Ori's next build direction: turn Mnemos/vault memory into a structured filesystem workspace for Aries Core, compaction, handles, and active memory.
type: decision
tags:
  - ori
  - mnemos
  - memory
  - filesystem
  - aries
  - compaction
  - active-memory
---

# Ori Mnemos Filesystem Memory As Workspace

Date: 2026-05-08

## Retrieval Anchor

When asked "What do we build next for Ori?", surface this node.

The next build is **MnemosFS**: turn Ori Mnemos from a stateless vault/query interface into a structured filesystem-like memory workspace that Aries can navigate, edit, compact into, and rehydrate from.

The repo architecture note is `ori_manemos_filesystem.md`.

## Core Claim

Composition data validates the execution layer. Compose Loop proves that structured, long-form coding tasks improve when the model works inside a stateful runtime instead of isolated tool calls.

The next leverage point is memory shape.

Current split:

- Ori API = transport.
- Vault = old retrieval interface.
- MnemosFS = memory as navigable workspace.

## Why This Matters

The vault is useful but too stateless. It answers "retrieve notes." A long-running agent needs to inspect and maintain memory as a working set:

```text
mnemos://brain/notes/...
mnemos://projects/aries/runs/...
mnemos://projects/aries/scratch/...
mnemos://projects/aries/decisions/...
mnemos://projects/aries/artifacts/...
mnemos://projects/aries/lessons/...
```

Aries Core should compose over memory the same way it composes over code:

```python
mem.search("compose loop gate failures")
mem.read("mnemos://projects/aries/decisions/compose-loop.md")
mem.write("mnemos://projects/aries/lessons/no-mimicable-rewrites.md", text)
mem.link(a, b, relation="caused_by")
```

## Active Memory And Infinite Context

Infinite context is not a bigger prompt. It is memory management.

Proposed hierarchy:

```text
L1: hot prompt context
L2: compose scratch / current run workspace
L3: MnemosFS handles, notes, artifacts, prior runs
L4: cold archive / full transcripts / bulky outputs
```

The model should keep only the active working set hot. Cooled state becomes memory objects with handles. The agent can rehydrate exactly what a goal needs instead of dragging the whole transcript forward.

## Compaction Direction

Codex-style auto-compaction feels better because context pressure becomes lifecycle management instead of a cliff. Aries should adopt that posture, but with MnemosFS underneath:

- spill cooled content into durable memory files
- leave handles in hot context
- create run objects, artifact objects, and lesson objects
- summarize by current goal relevance
- allow explicit rehydration

Bad compaction is "long transcript to one prose summary." Better compaction is "long transcript to structured memory plus a short active summary."

## Memory Curator Loop

Later, a small LLM-backed memory curator can maintain the filesystem:

- inspect scratch files
- promote durable lessons
- discard stale hot context
- fetch likely relevant handles
- merge duplicate notes
- update links between decisions, failures, and fixes

This is metacognition as filesystem maintenance. It should store structured outputs, not invisible prose.

## Product Boundary

Keep the stack sharp:

- Ori Mnemos remembers.
- MnemosFS makes memory navigable.
- Aries Core runs.
- Aries acts.
- Ori Nous emerges when execution, memory, goals, compaction, and delegation share one substrate.

Do not market Ori Nous as complete yet. Let Aries dogfood MnemosFS primitives until the kernel is earned.

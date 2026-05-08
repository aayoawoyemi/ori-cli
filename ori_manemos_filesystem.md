# Ori Mnemos Filesystem

Date: 2026-05-08

Status: architecture note

## Thesis

The execution layer now has evidence. Compose Loop shows that structured, long-form coding tasks improve when the model works inside a stateful runtime instead of spraying isolated tool calls. The next leverage point is memory shape.

Ori already exposes memory through an API. That is transport. The current vault is useful, but it is still too stateless: query graph, get notes, maybe add a note. A serious agent needs memory as a navigable workspace.

MnemosFS is that shape.

```text
Ori API    = transport
Vault      = old retrieval interface
MnemosFS   = memory as a structured filesystem/workspace
```

## Why This Follows From Compose Loop

Compose Loop works because it gives the model a live working substrate:

```text
model emits preflight/update
harness writes scratch state
next turn sees the working document
Repl calls are gated on that visible discipline
telemetry proves whether composition happened
```

That same pattern should apply to durable memory. Memory should not be a passive database behind `vault.query(...)`. It should be a workspace the agent can inspect, edit, link, promote, compact, and rehydrate.

## URI Layout

Target layout:

```text
mnemos://brain/notes/...
mnemos://brain/concepts/...
mnemos://projects/<project>/runs/...
mnemos://projects/<project>/scratch/...
mnemos://projects/<project>/decisions/...
mnemos://projects/<project>/artifacts/...
mnemos://projects/<project>/lessons/...
mnemos://people/<person>/...
mnemos://system/gotchas/...
```

The point is not the exact folders. The point is that memory becomes addressable and navigable. A model should be able to say "open the run log," "promote this scratch into a lesson," "link this decision to that failure," and "rehydrate the artifact behind this handle."

## Primitive Shape

Inside Aries Core, memory should look like body-side Python primitives:

```python
mem.search("compose loop gate failures")
mem.read("mnemos://projects/aries/decisions/compose-loop.md")
mem.write("mnemos://projects/aries/lessons/no-mimicable-rewrites.md", text)
mem.link(a, b, relation="caused_by")
mem.children("mnemos://projects/aries/")
mem.promote("mnemos://projects/aries/scratch/req_123.md", to="lessons")
```

These can be a thin wrapper over the existing Ori API/vault storage at first. Do not build a separate OS product before the primitives are proven inside Aries.

## Object Schema

Every memory object should have:

```yaml
uri: mnemos://projects/aries/lessons/no-mimicable-rewrites.md
kind: note | run | scratch | decision | artifact | lesson | handle
title: No mimicable rewrites
created_at: 2026-05-08T00:00:00Z
updated_at: 2026-05-08T00:00:00Z
project: aries
tags: [compose-loop, substrate, transcript]
links:
  caused_by: [...]
  supports: [...]
  supersedes: [...]
summary: Short retrieval summary
body_path: backing markdown/content path
```

The graph still matters. The difference is that graph nodes now have stable filesystem-like addresses and bodies.

## Active Memory

Persistent memory is not enough. Aries needs active memory: the current working set the model can maintain while it thinks.

Working set levels:

```text
L1: hot prompt context
L2: compose scratch / current run workspace
L3: MnemosFS handles, notes, artifacts, prior runs
L4: cold archive / full transcripts / bulky outputs
```

The long-context thesis becomes:

> Infinite context is not a bigger prompt. It is memory management.

Hot context should stay small. Everything else should be addressable, summarized, linked, and rehydratable.

## Compaction Direction

Codex-style auto-compaction feels better because context pressure becomes lifecycle management instead of a cliff. Aries should adopt that posture, but with a stronger substrate:

1. Detect context pressure.
2. Spill cooled content into MnemosFS objects.
3. Leave stable handles in the hot transcript.
4. Summarize by goal relevance, not generic compression.
5. Let the model rehydrate handles explicitly.

Bad compaction:

```text
big transcript -> one prose summary -> lost detail
```

Better compaction:

```text
big transcript -> run object + artifacts + lessons + handles + short active summary
```

This is where Aries can improve on existing systems: compaction should create durable memory structure, not just shorter chat.

## Memory Curator Loop

Later, MnemosFS can have a small curator loop. It should not own agent execution. It should maintain memory:

- inspect old scratch files
- promote durable lessons
- discard stale hot context
- fetch likely relevant handles before a run
- merge duplicate notes
- update links between decisions, failures, and fixes

This is metacognition as filesystem maintenance. It can use an LLM, but the output must become structured memory objects, not more invisible prose.

## Product Boundary

Keep the stack sharp:

```text
Ori Mnemos remembers.
MnemosFS makes memory navigable.
Aries Core runs.
Aries acts.
Ori Nous emerges when execution, memory, goals, compaction, and delegation share one substrate.
```

Aries Preview should not market Ori Nous as complete. Aries should dogfood the primitives until Ori Nous is earned.

## Next Build Sequence

1. Define MnemosFS URI layout and object schema.
2. Add `mem.search/read/write/link/children/promote` body primitives as wrappers over the current vault/Ori API.
3. Promote compose scratch files into `mnemos://projects/<project>/runs/` and `lessons/`.
4. Replace crude compaction with handle-based spill and rehydrate.
5. Add a memory-curator loop only after files/handles exist.

## Retrieval Triggers

This note should answer:

- What do we build next for Ori?
- How does Ori memory become useful for Aries?
- What comes after Compose Loop?
- How do we get closer to infinite context?
- How should compaction work in Aries?
- What is MnemosFS?

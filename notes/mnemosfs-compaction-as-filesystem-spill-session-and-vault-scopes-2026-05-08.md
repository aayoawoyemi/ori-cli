---
description: Compaction should spill a session transcript into structured MnemosFS files, split between session-scoped working files and vault-wide durable memory.
type: insight
tags:
  - ori
  - mnemosfs
  - compaction
  - active-memory
  - session-memory
  - infinite-context
---

# MnemosFS Compaction As Filesystem Spill

Date: 2026-05-08

## Retrieval Anchor

When asked about compaction, active memory, infinite context, session scope, or "what do we build next for Ori?", surface this node alongside `ori-mnemos-filesystem-memory-as-workspace-next-ori-build-2026-05-08`.

## Core Claim

Compaction should not be "summarize this chat and keep going."

Compaction should be a filesystem write:

```text
session transcript
  -> session-scoped working files
  -> vault-wide durable files
  -> hot-context handles and active summary
```

The model clears working context by moving state into structured memory files, then pulls back only what the current goal needs.

## Two Scopes

MnemosFS needs at least two memory scopes:

```text
mnemos://sessions/<session_id>/...
mnemos://vault/...
```

Session-scoped files are for active work:

```text
mnemos://sessions/<session_id>/scratch.md
mnemos://sessions/<session_id>/plan.md
mnemos://sessions/<session_id>/transcript.index.md
mnemos://sessions/<session_id>/artifacts/<handle>
mnemos://sessions/<session_id>/decisions.md
mnemos://sessions/<session_id>/open_questions.md
```

Vault-wide files are for durable memory:

```text
mnemos://vault/lessons/...
mnemos://vault/decisions/...
mnemos://vault/patterns/...
mnemos://vault/projects/<project>/...
mnemos://vault/people/...
mnemos://vault/system/gotchas/...
```

## Lifecycle

1. During a run, Compose Loop writes active state into the session scope.
2. When context pressure rises, compaction spills transcript chunks, tool outputs, and scratch state into session files.
3. Hot context keeps only a short active summary plus handles.
4. At completion, the harness promotes durable items into vault scope: lessons, decisions, gotchas, reusable artifacts.
5. Future runs search vault scope first, then rehydrate old session files only when needed.

## Why This Matters

This is the practical version of "infinite context." The system does not keep everything in the prompt. It keeps everything addressable.

Hot context becomes a working set. MnemosFS becomes the backing store. Compaction becomes the memory manager.

## Design Rule

Every compaction should produce structured outputs:

- active summary
- file handles
- artifacts
- lessons
- decisions
- unresolved questions
- verification state

Do not collapse everything into one prose blob. That destroys navigability.

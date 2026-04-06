# Phase 0 Spike

**Question:** Does one REPL block beat 10+ sequential tool calls on the permissions example?

**Task:** "Explain the permission system in this codebase."

**Two approaches compared:**

1. **Tool-calling (simulated Claude Code):** Grep("permission") → 40+ matches → Read each file → prose synthesis. 5-10 turns, ~15K tokens.

2. **REPL block (Ori CLI):** One Python code block that searches, clusters by file, fans out `rlm_call` per cluster, synthesizes. 1 turn.

## Files

```
spike/
├── body/
│   ├── indexer.py        # scan src/, regex symbol extraction, emit graph.json
│   ├── codebase.py       # CodebaseGraph class — search, cluster, get_context
│   ├── rlm.py            # rlm_call wrapper around Anthropic API
│   └── server.py         # JSON-RPC over stdin/stdout, exec with namespace
├── bridge.ts             # spawn python server, send code, return result
├── run.ts                # the experiment
└── graph.json            # emitted by indexer
```

## How to run

```bash
# 1. Build graph
cd spike/body && python indexer.py ../../src

# 2. Set API key
export ANTHROPIC_API_KEY=sk-ant-...

# 3. Run experiment
cd ../.. && npx tsx spike/run.ts
```

## What to measure

- Output quality (does it actually explain the permission system?)
- Token cost (compare to simulated tool-calling approach)
- Turn count (REPL: 1, tool-calling: estimated 5-10)
- Latency (wall-clock time)

## Decision point

If REPL output is qualitatively better OR cheaper, continue to Phase 1.
If REPL output is worse or similarly priced, pause and rethink architecture.

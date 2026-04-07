# Ori CLI

**Agentic coding harness with persistent memory and a REPL body. Open source. Multi-model. Local-first.**

v0.1.0-beta · Apache-2.0 · First push, April 7 2026 at 2 a.m. Documentation will be refined over the coming days. Community Discord in progress — contributions, testing, and discussion welcome.

Built on [Ori Mnemos](https://github.com/aayoawoyemi/Ori-Mnemos).

---

## Quick Start

```bash
npm install -g @ori-memory/aries
ori
```

The harness installs [Ori Mnemos](https://github.com/aayoawoyemi/Ori-Mnemos) as a dependency — persistent memory is included. First run walks through setup: model selection, API key configuration, optional vault connection. Sessions start immediately after.

---

## Overview

Ori CLI is a terminal-based agent harness for software engineering. It manages the agentic loop — prompt assembly, model invocation, tool dispatch, context management, memory persistence — as a structured cognitive environment built with Ink (React for terminals).

The harness is model-agnostic. It routes to Anthropic, Google, OpenAI, DeepSeek, Moonshot, Groq, OpenRouter, Ollama, and any OpenAI-compatible endpoint, including local GGUF models served by llama.cpp. Users provide their own API keys.

Two architectural components distinguish the system:

1. A **REPL body** — a persistent Python subprocess with a tree-sitter-indexed graph of the codebase in memory, providing the agent with structural navigation, judgment operations, and a computational reasoning surface.

2. **Native [Ori Mnemos](https://github.com/aayoawoyemi/Ori-Mnemos) integration** — persistent memory across sessions with learning retrieval, identity continuity, and a closed feedback loop between retrieval and utility.

---

## The REPL Body

### Problem

Standard coding agents interact with source code through text-oriented tools: read a file, search for a string, edit a line range. The agent perceives the codebase as a collection of flat text buffers and navigates sequentially — one file read, one grep, one edit at a time.

This sequential interaction model has a structural inefficiency. The agent cannot reason about the codebase as a whole. It cannot ask "which files are structurally central" or "does this new function duplicate existing logic" without manually reading and comparing files one by one. Each navigation step costs a full model turn — prompt assembly, inference, response parsing — regardless of whether the operation requires language model reasoning or could be resolved computationally.

### Architecture

Ori CLI provides a persistent Python subprocess — the **body** — that maintains a tree-sitter-parsed, graph-indexed representation of the entire repository in memory. The codebase is indexed at session start using tree-sitter grammars (TypeScript, JavaScript, Python) into a rustworkx directed graph. Files are nodes. Import and reference relationships are weighted edges. The graph is re-indexed after edits to maintain consistency.

The body exposes the following operations in the REPL namespace:

#### Structural Analysis

| Operation | Description |
|-----------|-------------|
| `codebase.search(query, limit)` | Full-text search across indexed symbols and content |
| `codebase.top_files(limit)` | Files ranked by PageRank over the import/reference graph |
| `codebase.hits(limit)` | HITS algorithm — separates hub files (orchestrators) from authority files (implementations) |
| `codebase.communities()` | Louvain community detection — module boundaries derived from dependency structure |
| `codebase.find_symbol(name)` | Symbol definition lookup across the project |
| `codebase.show_dependents(file)` | Reverse dependency traversal — what depends on this file |
| `codebase.show_dependencies(file)` | Forward dependency traversal — what this file depends on |
| `codebase.get_context(file, lines, window)` | Focused code slice with surrounding context |
| `codebase.cluster_by_file(matches)` | Group search results by file for structural reading |
| `codebase.list_files()` / `codebase.stats()` | Repository overview |

#### Judgment Operations

| Operation | Description |
|-----------|-------------|
| `codebase.find_similar_patterns(pattern, limit, mode)` | Three modes: `"name"` (token Jaccard on identifiers), `"signature"` (kind/name structural filter), `"shape"` (AST-shape matching on code snippets) |
| `codebase.detect_duplication(snippet, threshold)` | Exact and structural duplicate detection. Intended to be called before writing new functions |
| `codebase.is_consistent_with(snippet, reference, criteria)` | Compares new code against existing patterns. Returns deviation score across `"naming"`, `"structure"`, `"imports"`, or `"all"`. Reference may be a file path, list of paths, or language keyword |
| `codebase.suggest_location(description, limit)` | Ranks Louvain communities where new code structurally fits, with rationale |
| `codebase.find_convention(topic, limit)` | Extracts recurring patterns from high-PageRank files. Topics: error handling, logging, imports, async, API calls |

#### Recursive Self-Invocation (rlm_call)

The body includes `rlm_call` — a mechanism for the agent to spawn focused sub-LLM invocations from within REPL code. The agent writes Python that calls `rlm_call(question, context)`, which makes a plain API completion with a focused slice and returns the result as a Python value.

Depth is bounded architecturally: the sub-call receives a single user-turn prompt with no tools, no REPL, and no access to `rlm_call`. Its response is a string — data, not executable code. Parallel execution is supported via `rlm_batch` with an asyncio semaphore (default 5 concurrent). Call count is capped per top-level execution (default 15).

This enables compositional reasoning patterns: the agent decomposes a question into sub-questions, dispatches them in parallel, and synthesizes results — all within a single REPL execution, without consuming additional agentic loop turns.

### Output Discipline

The harness enforces a constraint on model output: do not narrate, do not announce tool calls, do not summarize results. When the agent needs to reason, it writes Python in the REPL that reasons computationally.

The rationale is mechanical. Every output token the model spends on narration ("Let me check the file...") is a token not spent on tool calls and computation. Natural language reasoning in the output stream is a form of redundancy when the same reasoning can be expressed as executable code that also produces a concrete result.

In preliminary testing on Claude Sonnet 4.5 with the REPL-mandatory harness (file navigation tools stripped, forcing all codebase interaction through the REPL body), we observed approximately **60% reduction in output tokens** compared to the same model with standard tool exposure. These numbers are from internal development testing, not controlled benchmarks. The effect appears model-conditional — models with strong tool-use training (Claude, GPT) benefit most; models with weaker tool-use capabilities (Qwen 3.6 in testing) did not show the same improvement. Rigorous evaluation is in progress.

### The Design Principle

The underlying position is that a language model operating on a codebase should not interact with it sequentially through text primitives. The codebase is a structured artifact — it has a dependency graph, community structure, naming conventions, architectural patterns. An agent with access to these structures as first-class queryable objects can reason comprehensively about the environment rather than navigating it one file at a time.

The REPL body is the mechanism that exposes this structure. The model does not receive a bigger context window. It receives an environment it can traverse.

The inspiration draws from Recursive Language Models ([Zhang, Krassa & Khattab, 2026](https://arxiv.org/abs/2512.24601)) — the position that context is an environment to be navigated, not input to be stuffed into a window. RLM applies this to single-session reasoning. The REPL body applies it to the coding agent's relationship with its codebase.

---

## Native Ori Memory

Ori CLI integrates with [Ori Mnemos](https://github.com/aayoawoyemi/Ori-Mnemos) at the harness level. The Ori MCP server runs as a subprocess, spawned at session start from the bundled dependency. The agent accesses the full Ori retrieval stack through the REPL body and through dedicated tool interfaces.

### REPL Memory Operations

| Operation | Description |
|-----------|-------------|
| `vault.query_ranked(query, limit)` | Four-signal RRF fusion (semantic + BM25 + PageRank + warmth) with Q-value reranking and co-occurrence PPR |
| `vault.query_important(limit)` | PageRank authority ranking over the knowledge graph |
| `vault.query_warmth(query, limit)` | Associative warmth field — recently active and reinforced notes |
| `vault.explore(query, limit)` | Recursive graph traversal with sub-question decomposition ([RMH](https://orimnemos.com/rmh) Constraint 2) |
| `vault.add(title, content, type)` | Capture to inbox mid-session |

### Tool Memory Operations

| Tool | Description |
|------|-------------|
| `VaultSearch` | Ranked retrieval via the model's tool-use interface |
| `VaultRead` | Read a specific note by title |
| `VaultExplore` | Recursive exploration via tool call |
| `VaultWarmth` | Inspect the warmth field |
| `VaultAdd` | Capture insights as tool calls |

### What Persists

- **Identity** (`self/identity.md`). Agent name, personality, methodology. Loaded at session start. Survives compaction. Present in every turn's system prompt.
- **Goals** (`self/goals.md`). Active project threads. Refreshed periodically via warm context, not loaded once at session start and left to go stale.
- **Knowledge** (`notes/`). Wiki-linked notes in a knowledge graph with ACT-R decay, spreading activation, four-signal retrieval, and learning Q-values. See the [Ori Mnemos README](https://github.com/aayoawoyemi/Ori-Mnemos) for the full retrieval architecture and the [Recursive Memory Harness paper](https://orimnemos.com/rmh) for the theoretical framework.
- **Operational state** (`ops/`). Daily status, reminders, session logs. High-decay memory that clears itself.
- **Project brain** (`.aries/memory/`). Per-project local memory that stays with the repository. Patterns, decisions, and learnings specific to the codebase.

### Warm Context

A ~2K token block is assembled at session start and refreshed every 10 turns: core identity, active goals, and the highest-warmth notes from the knowledge graph. This block is injected at the top of every system prompt and survives context compaction. It serves as the agent's minimum viable continuity — the persistent self that remains even when conversation history is compressed.

### Echo/Fizzle Feedback

When the harness retrieves memory notes before a model turn (preflight), it subsequently scans the model's response for references to those notes.

- **Echo**: The model referenced the note. The note's title terms appear in the response. A warmth boost is sent to Ori, which feeds into the Q-value reranking system. The note becomes more retrievable in future sessions.
- **Fizzle**: The note was retrieved but not referenced. No signal is sent. Natural ACT-R decay handles demotion.

This implements a closed feedback loop between retrieval and utility. The asymmetry is deliberate — false-negative echoes (missing a reference) are acceptable; false-positive echoes would corrupt Q-values. Over sessions, the retrieval surface converges toward notes that are genuinely useful for the agent's work patterns.

### Reflection

The harness implements a Smallville-inspired importance accumulator. Tool-using turns accumulate importance at 3 points per turn; plain conversation accumulates at 1. When the accumulator crosses a threshold (default 150), the harness triggers a reflection: the cheap model slot synthesizes recent activity into a single prose-as-title insight, which is written to the Ori vault. This creates durable knowledge from ephemeral session activity without manual capture.

---

## Phase-Gated Tool Exposure

Standard agent implementations expose all available tools on every API call. Each tool definition includes a full JSON schema. At 16+ tools, this represents 3–6K tokens of schema overhead per turn, regardless of whether the model requires those tools for the current operation.

Ori CLI implements phase-gated exposure:

| Phase | Tools Exposed (REPL mode) | Tools Exposed (bare mode) |
|-------|--------------------------|--------------------------|
| **Lean** (default) | Repl, Edit, Write, Bash, VaultAdd, ProjectSave | Read, Grep, Glob, Edit, Write, Bash, VaultAdd, ProjectSave |
| **Full** (auto-widened) | All 18+ registered tools | All 18+ registered tools |

The harness starts in lean phase. If the model requests a tool not in the lean set, the harness widens to full automatically on that turn. No tool-not-found errors. No manual phase management. Memory operations (VaultAdd, ProjectSave) are always available regardless of phase — memory capture is never gated.

Token savings: at 16 tools × ~300 tokens/schema × 20 turns, a typical session incurs ~96K tokens of schema overhead. Lean phase reduces this to ~18K in sessions where the model stays in explore/edit patterns.

---

## Multi-Model Router

The harness supports four model slots with independent provider configuration:

| Slot | Purpose |
|------|---------|
| `primary` | Main agent model for all standard turns |
| `reasoning` | Deep thinking — architecture decisions, complex debugging |
| `cheap` | Bulk operations — classification, reflection synthesis, importance scoring |
| `bulk` | Parallel subagent work |

### Supported Providers and Models

| Provider | Models | Auth |
|----------|--------|------|
| Anthropic | Opus 4.6, Sonnet 4.6, Haiku 4.5 | `ANTHROPIC_API_KEY` |
| Google | Gemini 2.5 Pro, Gemini 2.5 Flash | `GOOGLE_API_KEY` |
| OpenAI | GPT-5, GPT-4o, o4-mini | `OPENAI_API_KEY` |
| DeepSeek | DeepSeek Chat, DeepSeek Reasoner | `DEEPSEEK_API_KEY` |
| Moonshot | Kimi K2 | `MOONSHOT_API_KEY` |
| Groq | Llama 3.3 70B | `GROQ_API_KEY` |
| OpenRouter | 200+ models including free tier | `OPENROUTER_API_KEY` |
| llama.cpp | Any GGUF (local, no API key) | None |
| Ollama | Any pulled model | None |
| Custom | Any OpenAI-compatible endpoint | Configurable |

### Model Shortnames

| Shortname | Provider | Model | Context |
|-----------|----------|-------|---------|
| `opus` | Anthropic | claude-opus-4-6 | 1M |
| `sonnet` | Anthropic | claude-sonnet-4-6 | 200K |
| `haiku` | Anthropic | claude-haiku-4-5 | 200K |
| `gemini` | Google | gemini-2.5-pro | 1M |
| `flash` | Google | gemini-2.5-flash | 1M |
| `gpt5` | OpenAI | gpt-5 | 1M |
| `gpt4o` | OpenAI | gpt-4o | 128K |
| `deepseek` | DeepSeek | deepseek-chat | 128K |
| `deepseek-r1` | DeepSeek | deepseek-reasoner | 128K |
| `kimi` | Moonshot | kimi-k2 | 128K |
| `llama` | Groq | llama-3.3-70b | 128K |
| `local` | llama.cpp | Any loaded GGUF | 32K |
| `devstral` | llama.cpp | devstral | 131K |
| `qwen-coder-7b` | llama.cpp | qwen2.5-coder-7b | 32K |
| `phi4-mini` | llama.cpp | phi-4-mini | 131K |

### Local Model Configuration

```yaml
local:
  baseUrl: http://localhost:8080/v1
  gpuLayers: 20
  contextSize: 32768
  models:
    devstral:
      path: /path/to/devstral-small.gguf
      contextWindow: 131072
    qwen-coder-7b:
      path: /path/to/qwen2.5-coder-7b-instruct.gguf
      contextWindow: 32768
```

Start llama-server with: `llama-server -m <path>.gguf -c 32768 --n-gpu-layers 20 --port 8080`

---

## Context Management

### Compaction

When estimated token usage crosses a configurable threshold (default: 70% of context window), the harness compresses conversation history in two phases:

1. **Prune phase.** Old tool result content is erased, preserving call skeletons so the model retains awareness of what tools were used. The most recent tool results (last ~40K tokens) are protected.
2. **Summary phase.** Remaining conversation is summarized. Durable insights are extracted and persisted to vault or project brain before compression. Warm context survives intact.

### Prompt Caching

On Anthropic models, ambient signatures (codebase structure + vault state) are placed before a `cache_control` marker in the system prompt. The stable prefix is cached across turns via Anthropic's prompt caching, reducing per-turn input token cost for structural context that does not change between turns.

### Ambient Signatures

Two compressed representations are included in every turn's system prompt at configurable density (lean, standard, deep, max):

- **Codebase signature.** Top files by PageRank, community structure, key symbols, dependency patterns. Generated by the Python body at session start and after edits.
- **Vault signature.** Active notes, project distribution, warmth landscape, fading notes. Generated by Ori at session start and refreshed periodically.

These provide the agent with architectural proprioception — a compressed awareness of both codebase and memory state — without requiring explicit retrieval queries.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Ori CLI Harness                      │
│                                                             │
│  ┌───────────┐   ┌────────────┐   ┌──────────────────────┐ │
│  │  Ink TUI  │   │   Model    │   │   Phase-Gated Tool   │ │
│  │  React    │   │   Router   │   │     Exposure         │ │
│  │  Terminal │   │  (4 slots) │   │   lean ──► full      │ │
│  └───────────┘   └────────────┘   └──────────────────────┘ │
│                                                             │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                     Agent Loop                         │ │
│  │                                                        │ │
│  │  system prompt ──► model ──► tool dispatch ──► post    │ │
│  │                                                        │ │
│  │  Warm context refresh (every 10 turns)                 │ │
│  │  Echo/fizzle tracking (per turn)                       │ │
│  │  Importance accumulation ──► reflection (at threshold) │ │
│  │  Compaction (at context threshold)                     │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌────────────────────┐   ┌────────────────────────────┐   │
│  │    REPL Body       │   │    Ori Vault (MCP)         │   │
│  │                    │   │                            │   │
│  │  Python subprocess │   │  Persistent memory         │   │
│  │  tree-sitter index │   │  Knowledge graph           │   │
│  │  rustworkx graph   │   │  Learning retrieval        │   │
│  │  PageRank / HITS   │   │  ACT-R decay               │   │
│  │  Louvain community │   │  Q-value reranking         │   │
│  │  Judgment tools    │   │  Warm context assembly     │   │
│  │  rlm_call / batch  │   │  Echo/fizzle feedback      │   │
│  └────────────────────┘   └────────────────────────────┘   │
│                                                             │
│  ┌────────────────────┐   ┌─────────────────────────────┐  │
│  │  Project Brain     │   │  Filesystem · Bash · Web    │  │
│  │  (.aries/memory/)  │   │  Search · Fetch · Subagents │  │
│  │  Per-repo local    │   │  EnterPlanMode/ExitPlanMode │  │
│  └────────────────────┘   └─────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Tool Registry

| Tool | Category | Description |
|------|----------|-------------|
| `Repl` | Body | Execute Python in the persistent REPL body |
| `Bash` | System | Shell command execution |
| `Read` | Filesystem | Read file contents |
| `Write` | Filesystem | Write file contents |
| `Edit` | Filesystem | Targeted string replacement |
| `Glob` | Filesystem | File pattern matching |
| `Grep` | Filesystem | Content search with regex |
| `WebFetch` | Network | Fetch URL contents |
| `WebSearch` | Network | Web search (Brave, Tavily, Serper, SerpAPI) |
| `Agent` | Orchestration | Spawn subagent with independent context |
| `EnterPlanMode` | Planning | Enter structured planning mode |
| `ExitPlanMode` | Planning | Exit plan mode with approval gate |
| `VaultSearch` | Memory | Ranked retrieval from Ori vault |
| `VaultRead` | Memory | Read specific note by title |
| `VaultExplore` | Memory | Recursive graph traversal |
| `VaultWarmth` | Memory | Inspect warmth field |
| `VaultAdd` | Memory | Capture insight to vault inbox |
| `ProjectSearch` | Memory | Search project-local brain |
| `ProjectSave` | Memory | Save to project-local brain |

In REPL-mandatory mode, file navigation tools (Read, Grep, Glob, VaultSearch, VaultRead, VaultExplore, VaultWarmth, ProjectSearch) are stripped from the registry, forcing all codebase and memory navigation through the REPL body. This eliminates the meta-decision of which navigation tool to use and consolidates all exploration into composable Python.

---

## Configuration

`~/.aries/config.yaml` — generated with sensible defaults on first run.

```yaml
agent:
  name: Aries                    # Agent name (used in identity, prompts, TUI)

models:
  primary:
    provider: anthropic
    model: claude-sonnet-4-6
  reasoning:
    provider: anthropic
    model: claude-opus-4-6
  cheap:
    provider: google
    model: gemini-2.5-flash

vault:
  path: ~/brain                  # Ori vault location
  preflight: true                # Retrieve memory before each turn
  postflight: true               # Track echo/fizzle, accumulate importance

repl:
  enabled: true                  # Spawn Python body at session start
  timeoutMs: 30000               # Per-execution timeout
  maxRlmCalls: 15                # rlm_call cap per top-level exec
  sandbox: same_process          # same_process | docker | firecracker

compact:
  auto: true                     # Auto-compact at threshold
  threshold: 0.7                 # Fraction of context window

signature:
  codebase:
    level: standard              # lean | standard | deep | max
    maxTokens: 2000
  vault:
    level: standard
    maxTokens: 1500
  cachePrefix: true              # Anthropic prompt cache marker

permissions:
  mode: auto                     # auto | ask | manual
  allowBash: true
  allowWrite: true
  allowNetwork: true
```

| Section | Controls |
|---------|----------|
| `agent` | Agent name, display identity |
| `models` | Primary, reasoning, cheap, bulk model slots with independent providers |
| `local` | llama.cpp server path, GGUF mappings, GPU layers, context size |
| `vault` | Ori vault path, preflight/postflight toggles, reflection threshold |
| `projectBrain` | Per-project local memory: enabled, auto-extract, max memories |
| `repl` | Python body: timeout, sandbox mode, max iterations, max rlm_call invocations |
| `compact` | Auto-compaction threshold, tier classification |
| `signature` | Codebase + vault ambient signatures, density level, cache prefix |
| `permissions` | Auto/ask/manual mode, bash/write/network gates |
| `hooks` | Session start, pre/post tool use, stop, pre/post code execution |
| `webSearch` | Brave, Tavily, Serper, SerpAPI — provider selection and API key |
| `mcp` | Additional MCP servers to mount alongside Ori |

---

## Project Structure

```
ori-cli/
├── src/
│   ├── index.ts                 # Entry point — parchment terminal, session bootstrap
│   ├── loop.ts                  # Agent loop — turn management, phase tracking, compaction
│   ├── prompt.ts                # System prompt assembly — identity, rules, signatures
│   ├── config/                  # Configuration types and loading
│   ├── router/                  # Multi-model router and provider implementations
│   │   └── providers/           # Anthropic, Google, OpenAI-compatible, Groq, etc.
│   ├── tools/                   # Tool definitions and execution engine
│   ├── memory/                  # Vault integration, warm context, echo/fizzle, reflection
│   ├── repl/                    # REPL bridge — JSON-RPC protocol, restart-on-crash
│   ├── session/                 # Session storage and replay
│   ├── onboarding/              # First-run detection and setup
│   ├── ui/                      # Ink/React TUI — messages, markdown, status bar, input
│   └── utils/                   # Token estimation, message helpers
├── body/
│   ├── server.py                # Python REPL server (JSON-RPC over stdin/stdout)
│   ├── codebase.py              # CodebaseGraph — rustworkx graph with PageRank/HITS/Louvain
│   ├── indexer.py               # tree-sitter parser and symbol extraction
│   ├── judgment.py              # AST-shape matching, duplication detection, convention finding
│   ├── vault.py                 # Vault MCP client — memory operations from Python
│   ├── rlm.py                   # rlm_call — recursive sub-LLM invocation
│   ├── repl.py                  # REPL execution engine with security constraints
│   └── security.py              # Import whitelist, syscall restrictions
└── package.json
```

---

## Status

Beta. Phases 0–8 of the build plan are implemented and operational:

| Phase | Component | Status |
|-------|-----------|--------|
| 0 | Python body + REPL bridge | Shipped |
| 1 | Codebase graph indexing (tree-sitter + rustworkx) | Shipped |
| 2 | Vault body integration (MCP client in Python) | Shipped |
| 3 | rlm_call — recursive sub-LLM invocation | Shipped |
| 4 | Ambient signatures (codebase + vault) | Shipped |
| 5 | Agent loop refactor — phase gating, compaction | Shipped |
| 6 | Judgment tools — duplication, convention, consistency | Shipped |
| 7 | REPL-mandatory mode — strip navigation tools | Shipped |
| 8 | Multi-model routing, local model support | Shipped |

Remaining: Phase 9 (warmth signals in agent loop), Phase 10 (warm context expansion), Phase 12 (benchmark paper). Coming soon.

---

## License

Apache-2.0

---

Memory is sovereignty.

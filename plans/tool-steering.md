# Tool Steering Plan — Ori CLI

## Status: DRAFT
## Created: 2026-04-09

---

## Problem Statement

The model wastes tokens and turns when it uses Bash for navigation tasks that REPL handles better. The lean/widen phase system already hides legacy navigation tools (Read, Grep, Glob, VaultSearch, etc.) but doesn't address the model falling back to Bash for `cat`, `grep`, `find`, `ls` — which are navigation dressed as shell commands.

The research is clear:
- SWE-agent ACI: same model + better middleware = 10.7pp improvement
- arXiv 2505.18135: small description edits yield up to 10x change in tool usage frequency
- ToolMem (arXiv 2510.06664): per-tool capability summaries = 14.8–28.7% better selection
- Token co-occurrence routing: models pick tools based on description token overlap with the query

The proposed four-mode Task Mode system (Explore/Code/Research/Full) is **over-engineered for the marginal gain**. The lean set already reduced tools from 18 → 8. Going 8 → 4 saves ~1-2K tokens/turn in schemas — not the regime where ACI found its big wins. And it adds UX complexity (two mode axes: Alt+M × Alt+Z).

## What Actually Moves the Needle

Three interventions, ranked by impact/cost ratio:

### 1. Soft Rewrite Layer (HIGH impact, MEDIUM cost)
### 2. Description Asymmetry (HIGH impact, LOW cost)  
### 3. Explore Toggle (MEDIUM impact, LOW cost)

---

## Intervention 1: Soft Rewrite Layer

### What
When the model calls Bash with a navigation command (cat, grep, find, ls), the harness intercepts the call, rewrites it as the equivalent REPL operation, executes that instead, and returns the result as if Bash ran it. The model gets the data it wanted. Zero wasted turns. Over time, in-context learning trains the model to use REPL directly.

### Current State
`BashTool` already has a blocklist when REPL is enabled:

```
REPL_BLOCKED = ['cat', 'head', 'tail', 'less', 'grep', 'rg', 'find', 'fd', 'ls', 'dir', 'tree', 'wc']
```

When these are detected, the tool returns an error message telling the model to use REPL instead. This wastes a turn — the model has to re-issue the request as a REPL call.

### Proposed Change
Instead of returning an error, silently rewrite and execute:

| Model Requests | Harness Rewrites To | Notes |
|---------------|---------------------|-------|
| `cat src/loop.ts` | `fs.read("src/loop.ts")` | Full file content |
| `cat src/loop.ts \| head -50` | `fs.read("src/loop.ts", offset=0, limit=50)` | Partial read |
| `grep "pattern" src/**/*.ts` | `codebase.search("pattern", limit=20)` | Structured results |
| `grep -n "pattern" file.ts` | Search + filter to file | Single-file grep |
| `find . -name "*.ts"` | `codebase.list_files()` | Filtered listing |
| `ls src/` | `codebase.list_files()` filtered to prefix | Directory listing |
| `wc -l file.ts` | `fs.read()` + line count | Line count |

### Implementation Location
`src/tools/bash.ts` — inside the `execute()` method, before the REPL-blocked error check.

### Design Questions

**Q1: Should the rewrite be silent or annotated?**
- Silent: model gets pure results, learns nothing
- Annotated: append a one-line note like `[Routed via REPL: codebase.search("pattern")]`
- **Recommendation: Annotated.** The model learns the mapping. After a few turns it starts using REPL directly. This is in-context reinforcement, not just interception.

**Q2: How complex should the parser be?**
- We don't need a full shell parser. These are simple patterns:
  - `cat <path>` → fs.read
  - `grep [-flags] "pattern" <path-or-glob>` → codebase.search
  - `find . -name "pattern"` → list_files
  - `ls [path]` → list_files
- Edge cases (pipes, complex flags) fall through to the existing block message
- **Recommendation: Simple regex matching. If it doesn't match a known pattern, fall through to the block.**

**Q3: What about commands that are BOTH navigation and mutation?**
- `grep` + `sed` in a pipe? That's a mutation. Don't intercept.
- Rule: only intercept if the ENTIRE command is navigation. Any pipe to a write command → fall through.

### Acceptance Criteria
- [ ] `cat file.ts` returns file contents via REPL, with annotation
- [ ] `grep "pattern" **/*.ts` returns structured search results via REPL
- [ ] `find . -name "*.ts"` returns file list via REPL
- [ ] `ls src/` returns filtered file list via REPL
- [ ] Complex pipes (e.g., `grep X | sed Y`) fall through to existing block
- [ ] Build/test commands (`npm test`, `tsc`, `node`) are NOT intercepted
- [ ] Annotation line tells model the equivalent REPL call

---

## Intervention 2: Description Asymmetry

### What
Reshape tool descriptions so that Bash reads as heavy/cautionary/narrow and REPL reads as lean/capable/default. Research shows models route tool selection heavily based on description token overlap with the user's intent. If Bash's description says "file reading" anywhere, the model will route file-reading requests to Bash.

### Current Bash Description
Need to check, but likely mentions general shell capabilities.

### Proposed Bash Description
```
Execute shell commands for building, testing, and running code.
Use for: npm/npx, tsc, node, git, docker, make, compilation, test runners.
NOT for reading files, searching code, or listing directories — use Repl for those.
Constrained: some commands are blocked when Repl is available.
```

Key moves:
- Lead with build/test framing
- Explicitly name what it's NOT for
- The word "constrained" primes the model to expect limitations

### Proposed REPL Description
```
Execute Python in the body subprocess. The primary tool for code exploration,
file reading, memory retrieval, and any compositional work.
Available: codebase.search(), codebase.get_context(), fs.read(), vault.query_ranked(),
rlm_call(), rlm_batch(). Composes multiple operations in one call.
```

Key moves:
- "Primary tool" — assertive framing
- Lead with the exact operations (search, read, memory)
- "Composes multiple operations" — signals efficiency

### Implementation Location
- Bash: `src/tools/bash.ts` — the tool's `description` field
- REPL: `src/tools/repl.ts` — the tool's `description` field
- System prompt: `src/prompt.ts` — few-shot examples section

### Acceptance Criteria
- [ ] Bash description mentions ONLY build/test/run use cases
- [ ] Bash description explicitly says "NOT for reading/searching"
- [ ] REPL description says "primary tool" and lists key operations
- [ ] No overlap in capability language between the two descriptions

---

## Intervention 3: Explore Toggle

### What
A single keybinding (Alt+Z) that toggles between two states:
- **Normal** — current lean tool set (8 tools)
- **Explore** — Repl only (1 tool) + VaultAdd + ProjectSave (memory writes always allowed)

This is a **safety** feature. When you're asking questions about the codebase and don't want the model touching anything, toggle Explore. It physically cannot call Edit, Write, or Bash.

### Why Not Four Modes
- Code mode ≈ current lean set minus web tools. Removing web access during coding is counterproductive (can't look up docs).
- Research mode already exists as a permission mode (Alt+M). Duplicating it as a task mode creates confusion.
- Full mode is already the fallback.
- Two modes with a toggle is simpler UX than four modes with a cycle.

### Implementation

**State:** Add `taskMode: 'normal' | 'explore'` to App state in `src/ui/app.tsx`.

**Keybinding:** Alt+Z in the input handler, same pattern as Alt+M.

**Tool filtering:** In `src/loop.ts`, the tool filtering block (line ~200) gets a new branch:

```typescript
if (taskMode === 'explore') {
  activeTools = allTools.filter(t => 
    t.name === 'Repl' || t.name === 'VaultAdd' || t.name === 'ProjectSave'
  );
}
```

This goes BEFORE the permissionMode checks — explore mode overrides everything.

**Status bar:** Show task mode next to permission mode in `src/ui/statusBar.tsx`:
```
[explore] [default]    or    [normal] [yolo]
```

**System prompt awareness:** When in explore mode, append to system prompt:
```
You are in EXPLORE mode. You can only read and search — no file modifications, 
no shell commands. Use Repl with codebase.* and vault.* to answer questions.
If the user asks you to make changes, tell them to switch to Normal mode (Alt+Z).
```

### Acceptance Criteria
- [ ] Alt+Z toggles between Normal and Explore
- [ ] In Explore mode, only Repl + VaultAdd + ProjectSave are visible to the model
- [ ] Status bar shows current task mode
- [ ] System prompt includes mode-aware instruction in Explore
- [ ] Switching modes mid-conversation takes effect on next model call

---

## Intervention 4 (Future): Few-Shot Routing Examples

### What
Add 2-3 examples to the system prompt showing REPL as the correct choice for common patterns. Not building this now — depends on measuring the impact of interventions 1-3 first.

### Examples (for later)
```
When asked to find where something is defined:
  ✓ Repl: codebase.find_symbol("functionName")
  ✗ Bash: grep -rn "functionName" src/

When asked to understand a file:
  ✓ Repl: print(fs.read("src/loop.ts", offset=0, limit=50))
  ✗ Bash: head -50 src/loop.ts

When asked to search across the codebase:
  ✓ Repl: results = codebase.search("pattern", limit=20)
  ✗ Bash: grep -rn "pattern" src/
```

---

## Implementation Order

```
Phase A: Description Asymmetry (30 min)
  - Rewrite Bash + REPL tool descriptions
  - Zero infrastructure change, immediate effect
  - Can measure before/after in next session

Phase B: Soft Rewrite Layer (2-3 hours)
  - Regex-based command parser in bash.ts
  - REPL bridge calls for each pattern
  - Annotation suffix on results
  - Test coverage for each rewrite pattern

Phase C: Explore Toggle (1-2 hours)
  - App state + Alt+Z keybinding
  - Tool filter branch in loop.ts
  - Status bar display
  - System prompt mode awareness
```

---

## What We're NOT Building

- **Four-mode task system** — over-engineered for marginal gain
- **Auto-detection of task phase** — models can't introspect needs (proven by lean/widen failure)
- **Mandatory REPL** — Qwen data shows models spin without convergence when forced
- **Tool experience notes** — good idea but separate concern, doesn't block these interventions

---

## Open Questions

1. Should the soft rewrite layer have a config toggle to disable it? (For debugging, or if a future model handles Bash nav fine on its own)
2. Should Explore mode also hide WebFetch/WebSearch, or keep them? (Reading web pages is exploration, but it's also a side-effect channel)
3. Do we need telemetry on rewrite frequency to know when description asymmetry has trained the model enough to remove the rewrite layer?

---

## Decision Requested

Prince Ayo — review this plan. Key choices:

1. **Annotated vs silent rewrites** — I recommend annotated (model learns the mapping)
2. **Explore mode tool set** — Repl + VaultAdd + ProjectSave, or also include WebFetch/WebSearch?
3. **Implementation order** — A → B → C as written, or different priority?
4. **Any of the open questions** you have a strong opinion on?

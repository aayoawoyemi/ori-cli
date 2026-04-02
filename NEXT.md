# What's Next — Ori CLI

## Immediate (next build session)

### Ambient Memory / Warm Context Layer
- Assemble always-present ~2-3K token block at session start
- Identity + goals + user model + last reflection + top warm notes
- Refresh every N turns (not every turn)
- Conversation arc tracking for warmth queries
- Proactive surfacing when preflight notes cross relevance threshold
- Reflection → identity feedback loop

### Per-Model System Prompts
- Different prompts tuned for Anthropic vs Gemini vs OpenAI
- From OpenCode research: each model family has different strengths/quirks
- Same prompt to every model is suboptimal

### UI Polish
- Port Claude Code rendering more closely (horizontal rules, exact colors)
- Test and iterate on the Ink components with real usage
- Fix any streaming/display issues found during testing

## Medium-term

### More Providers (Phase 4 gaps)
- OpenAI provider (GPT-5, o4-mini)
- Moonshot/Kimi K2.5 provider
- Ollama provider (local models)
- OpenAI-compatible provider (any endpoint)

### Shadow Git Snapshots
- Per-step file snapshots for undo (from KiloCode research)
- `.aries/snapshots/` shadow git repo
- /undo command to revert last write

### Tests
- Zero test coverage currently
- Loop tests, preflight tests, compaction tests, router tests
- Research engine integration tests

### npm Publish
- Package as @ori-memory/aries
- Global install: npm i -g @ori-memory/aries
- `ori` or `aries` command

## Research / Deep Dive

### Active Memory — What Does It Mean?
The big open question. Current memory is passive — the vault stores things,
preflight retrieves them. Active memory means:
- The vault changes itself based on what happens
- Notes strengthen, weaken, connect, and disconnect autonomously
- The memory system has its own agency, not just responding to queries
- See brainstorm below.

### Epistemic Integrity V1
- LLM-driven contradiction detection (not just keyword heuristics)
- Agreement threshold calibration from real session data
- Devil's advocate turns
- Outcome tracking with predictions
- CATTS connection (confidence-aware compute scaling)
- Publishable paper angle: memory as antidote to sycophancy

### Research Engine Battle-Testing
- Run /research on real queries, evaluate quality
- Compare output to manual research
- Tune depth levels, source ranking, reflection loop count

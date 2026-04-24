import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { execSync } from 'node:child_process';
import type { AriesConfig } from './config/types.js';
import type { VaultIdentity } from './memory/vault.js';

/**
 * Prompt marker used by Anthropic provider to split stable ambient signatures
 * from the rest of the prompt for prompt-cache prefix billing.
 */
export const CACHE_PREFIX_BREAK = '<!-- ARIES_CACHE_PREFIX_BREAK -->';

export interface PromptContext {
  cwd: string;
  config: AriesConfig;
  vaultPath?: string;
  vaultNoteCount?: number;
  projectBrainCount?: number;
  vaultIdentity?: VaultIdentity | null;
  warmContext?: string;
  /** Codebase ambient signature markdown (Phase 5/7). Stable prefix. */
  codebaseSignature?: string;
  /** Vault ambient signature markdown (Phase 6/7). Stable prefix. */
  vaultSignature?: string;
  /** Whether the Repl tool is available (Phase 7). */
  replEnabled?: boolean;
  /** Experience log entries (project-local, cached prefix). */
  experienceLog?: string;
}

/** Build the frozen system prompt (Layer 1). Compiled once at session start. */
export function buildSystemPrompt(ctx: PromptContext): string {
  const sections: string[] = [];
  const agentName = ctx.config.agent.name;

  // ── Identity block ──────────────────────────────────────────────────────
  // Hard environment anchor — always present, never conditional.
  // Prevents the model from inferring its runtime from tool availability.
  sections.push(`You are running inside Aries CLI (OCLI), a memory-native coding agent harness. This is always true. Do not infer your environment from your tool list.`);

  // If vault has identity, use it verbatim. Otherwise use agent name.
  if (ctx.vaultIdentity?.identity) {
    sections.push(ctx.vaultIdentity.identity);
  } else {
    sections.push(`You are ${agentName}, a memory-native coding agent running in the terminal. You have full filesystem access and can execute any shell command.`);
  }

  // ── Warm Context (always-present, survives compaction) ──────────────────
  // Injected at top edge for maximum attention. Refreshes periodically.
  if (ctx.warmContext) {
    sections.push(ctx.warmContext);
  }

  // ── Goals ──────────────────────────────────────────────────────────────
  // NOT loaded from self/goals.md (goes stale within minutes of session start).
  // Fresh goals are injected per-turn via assembleCurrentState() → ori_orient().
  // Model calls ori_orient directly at session start.

  // ── User Model (from vault) ─────────────────────────────────────────────
  if (ctx.vaultIdentity?.userModel) {
    sections.push(`## About the User\n${ctx.vaultIdentity.userModel}`);
  }

  // ── Operational Rules ───────────────────────────────────────────────────
  sections.push(`## Operational Rules
- Read files before modifying them. Understand before changing.
- Don't add features beyond what was asked. Don't over-abstract.
- If an approach fails, diagnose why before switching tactics.
- When you find something load-bearing, say so immediately.
- Prefer editing existing files over creating new ones.
- Don't add comments, docstrings, or type annotations to code you didn't change.
- Only add error handling at system boundaries (user input, external APIs).
- Don't create helpers or abstractions for one-time operations.
- Be careful not to introduce security vulnerabilities (injection, XSS, etc).
- Run tests after making changes when test infrastructure exists.`);

  // ── Output Discipline ──────────────────────────────────────────────────
  sections.push(`## Output Discipline

Hard limits:
- Keep text between tool calls to **≤25 words**.
- Keep final responses to **≤100 words** unless the task genuinely requires more detail.

Rules:
- DO NOT announce what you are about to do. Just do it.
- DO NOT explain tool calls before making them. The tool name and args are self-documenting.
- DO NOT summarize what you just did after a tool completes. The result speaks for itself.
- DO NOT think out loud. If you need to reason, use the Repl tool or rlm_call — reasoning via text wastes tokens.
- Speak ONLY when: (1) you need user input, (2) you found something the user needs to know, (3) you're done and reporting results.
- Independent tool calls run in parallel — one message, multiple tool calls.

Anti-patterns (NEVER do these):
- "Let me check the file..." → just call Repl/Read
- "I'll search for..." → just call codebase.search via Repl
- "Now I need to..." → just call the tool
- "The issue is that..." (paragraph) → one sentence + the fix
- "Here's what I found:" (restating tool output) → the result already shows it

The test: if you delete all your text output and keep only tool calls + results, would the user still understand what happened? If yes, the text was unnecessary.`);

  // ── Epistemic Integrity ─────────────────────────────────────────────────
  sections.push(`## Epistemic Integrity
- When uncertain, name WHAT you're uncertain about. Never validate without substance.
- If the user's premise is wrong, state your disagreement in one sentence BEFORE complying. Do not preface responses with "You're right" or similar agreement openers — they are sycophantic noise that erode trust. Pushback is your job.
- If a memory note contradicts the user's proposal, surface it explicitly.
- When reviewing code, find problems. Agreement is the default failure mode — override it. If you can't find issues, you haven't looked hard enough.
- Never say "looks good" without evidence. Name specific things that are good, or name what's wrong.`);

  // ── Memory ──────────────────────────────────────────────────────────────
  // 2026-04-21 rewrite: promoted vault.top as retrieval default alongside
  // vault.explore as mapping default. Prior version named explore as the
  // sole default; 53 REPL traces (2026-04-05 → 2026-04-21) showed the model
  // reached for query_ranked ~130x vs explore ~46x regardless of that prose
  // rail. Shape predictability beats docstring preference — see vault note
  // `predictable-apis-over-prose-rails-always-the-design-constraint-a10-exposed`.
  sections.push(`## Memory
You have persistent memory — a knowledge graph with wiki-links, semantic embeddings, and learned retrieval weights. The harness does NOT pre-inject notes per turn. You pull memory on-demand when the question warrants it.

**Two retrieval defaults, pick by intent:**
- \`vault.top(query, n=3)\` → targeted retrieval. "Give me the top notes on this topic." Fast, composite-ranked, the common case.
- \`vault.explore(query)\` → region mapping. "Walk the neighborhood around this topic." Slower, spreading activation across wiki-links, use when you want the cluster.

**Access (after top/explore returns a path):**
- \`vault.read(path)\` → full note body
- \`vault.get_note(title)\` → full body by title (slug-resolved)

**Session meta:**
- \`vault.orient(brief=True)\` → today's status, goals, reminders. Call when the user's request references project state or when you need to understand where current work lives. Not every session needs it.

**Escape hatches (use only when you need this specific bias):**
- \`vault.query_ranked(query, limit)\` → like top but with custom limit + raw envelope
- \`vault.query_warmth(context)\` → filter currently-warm notes by context (recency-weighted)
- \`vault.query_important()\` → backbone authorities (no query; PageRank-adjacent)
- \`vault.query_fading()\` → decaying notes (vault health, not retrieval)

**Surface recall visibly.** When vault.* finds something useful, prefix your response with "Recall:" so the user sees it happened — e.g. "Recall: in the March 31 session we mapped Claude Code's loop as nO; that's why X applies here." Silent recall is invisible smartness; visible recall builds trust.

**Write back selectively.** \`vault.add(title, content)\` for durable cross-project insights only. Most session detail belongs to the project brain (\`ProjectSave\`), not the main vault. Keep the vault lean.`);

  // ── Ambient Context (single wrapper for the cached prefix) ─────────────
  // Codebase + vault proprioception + experience log, collapsed into one
  // section with tagged subsections. Previously three separate H1/H2 headers
  // took ~30 wasted header tokens and split attention across disconnected
  // blocks. Single wrapper reads as a coherent context block.
  const ambientParts: string[] = [];
  if (ctx.codebaseSignature) {
    ambientParts.push(`### Codebase\n${ctx.codebaseSignature}`);
  }
  if (ctx.vaultSignature) {
    ambientParts.push(`### Memory\n${ctx.vaultSignature}`);
  }
  if (ctx.experienceLog) {
    ambientParts.push(`### Experience\n${ctx.experienceLog}`);
  }
  if (ambientParts.length > 0) {
    sections.push(`## Ambient Context\n${ambientParts.join('\n\n')}`);
  }
  // ── Tool Usage ──────────────────────────────────────────────────────────
  // A9 (2026-04-19): the Repl-prose block that previously lived here has
  // been deleted. Teaching how to use the environment moved to two
  // structural surfaces, both of which cross every model provider:
  //   1. The Repl tool's `description` field (src/tools/repl.ts) carries
  //      composition examples every API request sends with the schema.
  //      The model reads it before choosing a tool. Not prose prompt —
  //      tool contract.
  //   2. The first-turn namespace banner (body/server.py, A7) prepends
  //      live namespace + help() pointer to the first Repl tool_result.
  //      The environment self-documents.
  //
  // This section now carries only a ~30-word orientation. Everything
  // else about "which methods to prefer, what compositions look like,
  // how to think about the Repl" lives in the places above where the
  // model actually reads them in the right temporal order.
  if (ctx.replEnabled) {
    sections.push(`## Your environment

You operate inside a persistent Python REPL — the substrate IS your computer, not a menu of tools. Every Repl turn costs ~200 tokens of envelope overhead (tool_use framing + tool_result wrapper + any thinking). A 5-step task fragmented across 5 calls runs ~1000 tokens; written as one composed script, ~250. The economics are structural, not rhetorical.

Before emitting any Repl call, ask: what's the full script this task needs? If it needs N operations, write all N in ONE Python block using control flow (for, if, variables, functions). Variable persistence across calls is for multi-TASK work — multi-STEP work that shares context belongs in one block. About to submit 2 lines of Python? Pause — the composed version almost always exists.

Text content is for speech to the user; everything else happens inside Repl. help(name) introspects any primitive. The first Repl call in a session returns a banner with the live namespace.

When a Repl op raises KeyError / AttributeError / TypeError / IndexError, the traceback is automatically enriched with a trailing line of the form \`NOTE: <primitive> returns <shape>\` (for shape errors) or \`NOTE: <primitive> signature <sig>\` (for argument-count errors). That line is the actual runtime shape for the primitive you called, pulled from the namespace's source-of-truth schema — trust it over your training prior, and correct the next batch's access pattern against it. If the NOTE says \`returns {results: [...]}  # iterate as result['results']\`, do exactly that — don't iterate the dict directly.`);
  } else {
    sections.push(`## Tool Usage
- Use Read instead of cat/head/tail via Bash.
- Use Write instead of echo/heredoc via Bash.
- Use Edit instead of sed/awk via Bash.
- Use Glob instead of find/ls via Bash.
- Use Grep instead of grep/rg via Bash.
- Bash has full access to cat, grep, find for code exploration when needed.
- Reserve Bash primarily for build/test, git, and system operations.
- If multiple tool calls are independent, call them in parallel.
- Read-only tools run in parallel. Write tools run serially.`);
  }

  // ── ORI.md / project instructions ───────────────────────────────────────
  // Static within a session — included in the cached prefix. Capped to keep
  // the prompt cache prefix from exploding if a project ships a giant CLAUDE.md.
  const projectInstructionPaths = [
    join(ctx.cwd, 'ORI.md'),
    join(ctx.cwd, '.ori', 'ORI.md'),
    join(ctx.cwd, 'CLAUDE.md'),        // legacy fallback
    join(ctx.cwd, '.claude', 'CLAUDE.md'), // legacy fallback
  ];
  // Project MD files (ORI.md / CLAUDE.md) live in the cached prefix. Cap exists
  // so a user shipping a giant unbounded CLAUDE.md can't blow up our prompt.
  // Bumped 2026-04-19 from 6000 → 20000 (~5000 tokens) because our own ORI.md
  // is curated and load-bearing (full slop definitions + codebase patterns +
  // comment philosophy). 5000 tokens in a cached prefix is free after first hit.
  // If a project ships a 40K CLAUDE.md we still truncate, but at a useful size.
  const PROJECT_MD_CHAR_CAP = 20000; // ~5000 tokens
  for (const p of projectInstructionPaths) {
    if (existsSync(p)) {
      try {
        let content = readFileSync(p, 'utf-8');
        if (content.length > PROJECT_MD_CHAR_CAP) {
          content = content.slice(0, PROJECT_MD_CHAR_CAP) + `\n\n... [truncated at ${PROJECT_MD_CHAR_CAP} chars; full file at ${p}]`;
        }
        sections.push(`## Project Instructions (${p})\n${content}`);
      } catch { /* skip unreadable */ }
      break;
    }
  }

  // ── Cache prefix break ──────────────────────────────────────────────────
  // Everything ABOVE is static within a session — gets cached.
  // Everything BELOW is dynamic (date, git branch) — recomputed per turn.
  // Previously the break was conditional on having ambient signatures, which
  // meant when signatures were off the entire prompt fell into the dynamic
  // remainder. And Environment was above the break, so the date string
  // changing daily busted the cache. Both fixed.
  if (ctx.config.signature.cachePrefix) {
    sections.push(CACHE_PREFIX_BREAK);
  }

  // ── Environment ─────────────────────────────────────────────────────────
  let gitBranch = 'unknown';
  try {
    gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ctx.cwd, encoding: 'utf-8' }).trim();
  } catch { /* not a git repo */ }

  const shell = process.env.SHELL?.split('/').pop() ?? 'bash';

  const envLines = [
    `- Working directory: ${ctx.cwd}`,
    `- Git branch: ${gitBranch}`,
    `- Platform: ${platform()}`,
    `- Shell: ${shell}`,
  ];

  if (ctx.vaultPath) {
    envLines.push(`- Vault: ${ctx.vaultPath} (${ctx.vaultNoteCount ?? '?'} notes)`);
  }
  if (ctx.projectBrainCount !== undefined) {
    envLines.push(`- Project brain: .aries/ (${ctx.projectBrainCount} memories)`);
  }

  const today = new Date().toISOString().split('T')[0];
  envLines.push(`- Date: ${today}`);

  sections.push(`## Environment\n${envLines.join('\n')}`);

  return sections.join('\n\n');
}

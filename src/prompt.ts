import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { platform, homedir } from 'node:os';
import { execSync } from 'node:child_process';
import type { AriesConfig } from './config/types.js';
import type { VaultIdentity } from './memory/vault.js';
import type { SystemPromptInput, SystemPromptParts } from './router/types.js';

/**
 * Prompt marker used by the Anthropic provider to split stable content from
 * volatile session content for prompt-cache prefix billing.
 */
export const CACHE_PREFIX_BREAK = '<!-- ARIES_CACHE_PREFIX_BREAK -->';

export function splitSystemPromptInput(input: SystemPromptInput): SystemPromptParts {
  if (typeof input !== 'string') {
    return {
      stable: input.stable.trim(),
      volatile: input.volatile.trim(),
    };
  }
  const idx = input.indexOf(CACHE_PREFIX_BREAK);
  if (idx === -1) {
    return { stable: '', volatile: input.trim() };
  }
  return {
    stable: input.slice(0, idx).trim(),
    volatile: input.slice(idx + CACHE_PREFIX_BREAK.length).trim(),
  };
}

export function renderSystemPrompt(input: SystemPromptInput): string {
  const { stable, volatile } = splitSystemPromptInput(input);
  return [stable, volatile].map(s => s.trim()).filter(Boolean).join('\n\n');
}

function joinPromptSections(...sections: Array<string | undefined>): string {
  return sections.map(s => s?.trim()).filter(Boolean).join('\n\n');
}

function markdownFence(text: string, info = 'markdown'): string {
  let fence = '```';
  while (text.includes(fence)) fence += '`';
  return `${fence}${info}\n${text.trimEnd()}\n${fence}`;
}

export interface ComposeRequestPromptOptions {
  mode: 'compose' | 'goal';
  requestId: string;
  scratchContent?: string;
  scratchError?: string;
  verificationFilled?: boolean;
}

const FINAL_ANSWER_READINESS_AUDIT = `## Final Answer Readiness Audit

Verification is present in the request scratch. Before calling \`done(value)\`:
- Restate the objective as concrete deliverables or success criteria.
- Map every explicit requirement, named file, command, test, gate, and deliverable to concrete evidence.
- Inspect the current files, command output, test results, runtime state, or other real evidence for each item.
- Check that each passing test, verifier, manifest, or green status covers the requirement it is being used as evidence for.
- Identify any missing, incomplete, weakly verified, or uncovered requirement.
- If anything is missing or uncertain, continue with verify or repair work instead of calling \`done(value)\`.

Call \`done(value)\` only when current evidence covers the objective and no required work remains.`;

export function buildComposeRequestSystemPrompt(
  base: SystemPromptInput,
  opts: ComposeRequestPromptOptions,
): SystemPromptParts {
  const baseParts = splitSystemPromptInput(base);
  const protocol = `## Compose Loop Protocol

Before a Repl call in this request, emit one text block:

<compose_preflight>
purpose: <what this Repl will accomplish>
primitives: <comma-separated namespace primitives>
inputs: <state, vars, scratch, files, or prior findings consumed>
expected_outputs: <facts, edits, state keys, or verification result produced>
failure_modes: <main ways this cell can fail or mislead>
persists: <state.put key, scratch section, file path, or none>
cell_kind: scout | composed | verify | repair | commit
</compose_preflight>

After a Repl result, emit one text block before the next Repl:

<compose_update>
findings: <what the result established>
next_move: <next action>
</compose_update>

The harness parses these blocks and records them in the request scratch. Repl accepts only structurally valid request progress.

End every compose-mode request with a final Repl cell that calls \`done(answer)\`. The final cell can be commit-only — just a \`done(...)\` call (or one variable assignment then \`done(value)\`); no preflight or update is required for it because commit cells are exempt from the gate. The bench grader and downstream tools pattern-match the value passed to \`done()\`, not natural-language prose. If you synthesize the answer in text and stop, the answer does not get scored — always close with \`done(answer)\`.`;

  const scratch = opts.scratchContent?.trim()
    ? `## Compose Request State\n- mode: ${opts.mode}\n- request_id: ${opts.requestId}\n\n## Request Scratch\n${markdownFence(capText(opts.scratchContent, 24000, 'request scratch'), 'markdown')}`
    : `## Compose Request State\n- mode: ${opts.mode}\n- request_id: ${opts.requestId}\n\n## Request Scratch\n(active; no readable content${opts.scratchError ? `: ${opts.scratchError}` : ''})`;
  const finalAudit = opts.verificationFilled ? FINAL_ANSWER_READINESS_AUDIT : '';

  return {
    stable: baseParts.stable ? joinPromptSections(baseParts.stable, protocol) : '',
    volatile: joinPromptSections(baseParts.stable ? baseParts.volatile : joinPromptSections(baseParts.volatile, protocol), scratch, finalAudit),
  };
}

export interface PromptContext {
  cwd: string;
  config: AriesConfig;
  vaultPath?: string;
  vaultNoteCount?: number;
  projectBrainCount?: number;
  vaultIdentity?: VaultIdentity | null;
  warmContext?: string;
  /** Codebase ambient signature markdown. Stable enough to live above cache break. */
  codebaseSignature?: string;
  /** Vault ambient signature markdown. Stable enough to live above cache break. */
  vaultSignature?: string;
  /** Whether the code tool is available. */
  replEnabled?: boolean;
  /** Loop2 extracts fenced Python directly from assistant text; no tool schema is sent. */
  loop2?: boolean;
  /** Loop3 uses a structured Repl tool-call action channel. */
  loop3?: boolean;
  /** Experience log entries (project-local, cached prefix). */
  experienceLog?: string;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

function capText(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n\n... [${label} truncated at ${maxChars} chars]`;
}

function readAriesMdSections(cwd: string): string[] {
  // Keep ARIES.md in the cached prefix: these files are session-level rules,
  // not per-turn state. The cap remains generous because user/project rules are
  // authoritative; cache retention absorbs the steady-state cost.
  const ARIES_MD_CHAR_CAP = 20000;
  const sections: string[] = [];
  const tiers: Array<{ path: string; label: string }> = [
    { path: join(homedir(), '.aries', 'ARIES.md'), label: 'global' },
    { path: join(cwd, 'ARIES.md'), label: 'project' },
  ];

  for (const { path, label } of tiers) {
    if (!existsSync(path)) continue;
    try {
      const content = capText(readFileSync(path, 'utf-8'), ARIES_MD_CHAR_CAP, path);
      sections.push(`## Code Rules (${label} ARIES.md)\n${content}`);
    } catch {
      // Unreadable local rule files should not block startup. The body/tools
      // can still surface filesystem errors if the user asks about the file.
    }
  }

  return sections;
}

function getGitBranch(cwd: string): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Build the Aries system prompt.
 *
 * 2026-05-04: Replaced the Pi-derived RFC/XML constitution with a lean
 * substrate contract. The old prompt described a generic rigorous coding
 * agent and then taught code-mode as an add-on. That was backwards for Aries:
 * the product thesis is the place the model inhabits, a computer-backed
 * persistent Python session. Keep the cached prefix small, stable, and true.
 */
export function buildSystemPrompt(ctx: PromptContext): SystemPromptParts {
  const sections: string[] = [];
  const agentName = firstLine(ctx.config.agent.name) || 'Aries';

  sections.push(
    `You are ${agentName}, a coding agent running in a persistent, computer-backed Python session on the user's machine.

${agentName} gives you a long-lived Python session with APIs for operating the computer. Write Python programs in that session to inspect, modify, verify, and explain real software systems.`,
  );

  if (ctx.replEnabled === false) {
    sections.push(
      `## Operating Model

The code substrate is unavailable in this session. Use the available CLI tools directly and preserve the same engineering contract.`,
    );
  } else {
    if (ctx.loop3) {
      sections.push(
        `## Operating Model

Your primary action surface is the \`Repl\` tool. Each tool call executes one Python program in the persistent body.

The body namespace exposes (live; verify with \`api.stub()\` and \`api.describe(name)\`):
- \`fs.read/write/edit/glob/grep/listdir/tree/context\` for files
- \`shell.run(cmd, timeout=, cwd=)\` for shell execution
- \`web.fetch(url)\` and \`web.search(query)\` for web access
- \`codebase.search(query)\` and \`codebase.find_symbol(name)\` for code navigation
- \`vault.top(query, n=)\`, \`vault.add(...)\`, and \`vault.search(...)\` for memory
- \`say(text)\` for synthesis output, captured in the result
- \`done(value)\` to commit the final answer and end the agent turn
- \`state.put(key, value, note='')\`, \`state.get(key)\`, and \`state.receipts()\` for durable session handoff
- \`plan.create(...)\`, \`plan.enter_phase(id)\`, \`plan.exit_phase(id, outputs)\` for goal-layer plans
- \`spanner.escalate(reason, layers=)\` for model-declared escalation into planned work

Compose multi-step programs in one Repl call. Python variables persist across calls as scratch. Use \`state.*\` for planned or cross-cell handoff; \`plan.exit_phase()\` rejects phases whose declared \`produces_state\` keys are missing.

For complex or user-flagged goals, create a detailed plan with layers and phases before execution. Each phase declares intent, primitives, \`consumes_state\`, \`produces_state\`, and composition, then runs as one or two composed Repl cells bracketed by \`plan.enter_phase(...)\` and \`plan.exit_phase(...)\`. Call \`state.put(...)\` for every produced key before exiting the phase. Call \`spanner.escalate(...)\` when the task needs planned layers.

Final answer: pass to \`done(...)\`. Patches, code, explanations, and Markdown can be embedded as triple-quoted Python strings.

Example:

\`\`\`
hits = codebase.search("CACHE_PREFIX_BREAK")
for h in hits[:3]:
    say(f"{h['path']}:{h['line']}  {h['snippet']}")
state.put("cache_break_hits", hits[:3], note="top codebase hits for the constant")
selected = state.get("cache_break_hits")
done({"file": hits[0]["path"], "line": hits[0]["line"]})
\`\`\`

Inspect the live API with \`api.stub()\`, \`api.describe(name)\`, and \`api.costs()\`. Trust the live API over memory or examples.`,
      );
    } else if (ctx.loop2) {
      sections.push(
        `## Operating Model

Your primary action surface is fenced Python in assistant text. When you need to operate the computer, emit one or more markdown fences:

\`\`\`py id="short-title" t="30s"
# Python code here
\`\`\`

Supported fence metadata:
- \`id="short-title"\` labels the cell
- \`t="15s"\`, \`t="2m"\`, or \`t="500ms"\` sets the timeout
- \`rst=true\` is accepted for compatibility; do not rely on it for reset behavior in this spike

Do not describe code you intend to run without emitting a \`\`\`py fence. Text with no Python fences is treated as your final natural-language answer.

The Python session persists across fenced code cells:
- variables, functions, preloaded modules, and discovered facts persist
- intermediate results can stay in Python instead of returning to the model every step

The session exposes the computer through preloaded APIs:
- \`fs\` for files
- \`shell\` for commands
- \`codebase\` for indexed repo navigation
- \`vault\` for durable memory
- \`web\` for web access when available
- \`api\` for live namespace inspection
- \`state\` for durable cross-phase handoff
- \`say\`, \`ask\`, and \`done\` for communication

Common primitive return shapes (both aliases work where shown):
- \`shell.run(cmd, timeout=30, cwd=None)\` -> \`{ stdout, stderr, code, exit_code, duration_ms, ok }\`
- \`fs.read(path, offset=0, limit=None)\` -> \`str\` (raises on miss)
- \`codebase.search(query, limit=50)\` -> \`list[{ file, path, line, snippet, text }]\`
- \`vault.top(query, n=3)\` -> \`{ "results": [{ title, path, score }] }\`

Write one composed Python program per turn. Compose multiple steps inside the cell — share variables in the namespace, then either say() your synthesis or done() your commit. Each turn = one program:

\`\`\`py id="find-and-read" t="30s"
hits = codebase.search("CACHE_PREFIX_BREAK")
for h in hits[:3]:
    say(f"{h['path']}:{h['line']}  {h['snippet']}")
    say(fs.read(h['path']))
\`\`\`

One cell, one round-trip, three composed steps. Prefer this over many small parallel probes that duplicate work or guess paths.

Commit final answers with \`done(value)\` from inside a \`py\` cell. If the answer needs to include Markdown, a TypeScript patch, or another fenced block, put that text inside the Python value passed to \`done(...)\`; do not emit outer prose or non-Python fences as the final answer.

Inspect the live API with \`api.stub()\`, \`api.describe(name)\`, and \`api.costs()\`. Trust the live API over memory or examples.`,
      );
    } else {
      sections.push(
        `## Operating Model

Your primary action surface is \`code\`. See the \`code\` action description for cell syntax.

The Python session persists across code calls:
- variables, functions, preloaded modules, and discovered facts persist
- intermediate results can stay in Python instead of returning to the model every step

The session exposes the computer through preloaded APIs:
- \`fs\` for files
- \`shell\` for commands
- \`codebase\` for indexed repo navigation
- \`vault\` for durable memory
- \`web\` for web access when available
- \`api\` for live namespace inspection
- \`state\` for durable cross-phase handoff
- \`say\`, \`ask\`, and \`done\` for communication

Inspect the live API with \`api.stub()\`, \`api.describe(name)\`, and \`api.costs()\`. Trust the live API over memory or examples.`,
      );
    }

    sections.push(
      `## IO Contract

Treat Python variables as scratch working memory. Treat \`state.*\` as the durable session handoff surface.

Import statements are forbidden by the sandbox. Use preloaded modules (json, os.path, re, collections, itertools, math, datetime, random, statistics) and namespace APIs; inspect live names with \`api.stub()\`.

Use \`print()\` only for diagnostics; printed output may be capped, hidden, or summarized.

Use \`say(text)\` only when code needs to speak visibly during execution.

Use \`done(value)\` to commit a program result back to the harness. Prefer structured values: dicts, lists, strings, or concise summaries.

After code gathers evidence or makes changes, write the final synthesis as normal assistant text.`,
    );

    sections.push(
      `## Work Shape

Write small programs that operate the computer.

Keep going inside one code call when the next step can be computed in Python:
- search then read relevant files
- inspect then edit
- edit then verify
- gather evidence then return a structured result

Stop and return to the user only when the work is complete, user input is needed, or the task is blocked.`,
    );
  }

  sections.push(
    `## Engineering Contract

Read before editing. Verify changes you make.

Do not commit, force-push, or overwrite user work without explicit instruction.

Report observed facts; do not claim verification you did not run.`,
  );

  const identityParts: string[] = [];
  if (ctx.vaultIdentity?.identity) {
    identityParts.push(capText(ctx.vaultIdentity.identity, 2000, 'vault identity'));
  }
  if (ctx.vaultIdentity?.userModel) {
    identityParts.push(`About the user:\n${capText(ctx.vaultIdentity.userModel, 2000, 'user model')}`);
  }
  if (identityParts.length > 0) {
    sections.push(`## Personal Context\n${identityParts.join('\n\n')}`);
  }

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

  sections.push(...readAriesMdSections(ctx.cwd));

  if (ctx.config.signature.cachePrefix) {
    sections.push(CACHE_PREFIX_BREAK);
  }

  // Warm context may refresh during long sessions, so keep it below the cache
  // break. It remains close to the session facts without invalidating the
  // stable substrate/rules prefix.
  if (ctx.warmContext) {
    sections.push(`## Warm Context\n${ctx.warmContext}`);
  }

  const shell = process.env.SHELL?.split('/').pop() ?? 'bash';
  const envLines = [
    `- Working directory: ${ctx.cwd}`,
    `- Git branch: ${getGitBranch(ctx.cwd)}`,
    `- Platform: ${platform()}`,
    `- Shell: ${shell}`,
  ];
  if (ctx.vaultPath) {
    envLines.push(`- Vault: ${ctx.vaultPath} (${ctx.vaultNoteCount ?? '?'} notes)`);
  }
  if (ctx.projectBrainCount !== undefined) {
    envLines.push(`- Project brain: .aries/ (${ctx.projectBrainCount} memories)`);
  }
  envLines.push(`- Date: ${new Date().toISOString().split('T')[0]}`);
  sections.push(`## Session\n${envLines.join('\n')}`);

  return splitSystemPromptInput(sections.join('\n\n'));
}

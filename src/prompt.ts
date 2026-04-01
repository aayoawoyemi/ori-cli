import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { execSync } from 'node:child_process';
import type { AriesConfig } from './config/types.js';
import type { VaultIdentity } from './memory/vault.js';

export interface PromptContext {
  cwd: string;
  config: AriesConfig;
  vaultPath?: string;
  vaultNoteCount?: number;
  projectBrainCount?: number;
  vaultIdentity?: VaultIdentity | null;
}

/** Build the frozen system prompt (Layer 1). Compiled once at session start. */
export function buildSystemPrompt(ctx: PromptContext): string {
  const sections: string[] = [];
  const agentName = ctx.config.agent.name;

  // ── Identity block ──────────────────────────────────────────────────────
  // If vault has identity, use it verbatim. Otherwise use agent name.
  if (ctx.vaultIdentity?.identity) {
    sections.push(ctx.vaultIdentity.identity);
  } else {
    sections.push(`You are ${agentName}, a memory-native coding agent running in the terminal. You have full filesystem access and can execute any shell command.`);
  }

  // ── Goals (from vault) ──────────────────────────────────────────────────
  if (ctx.vaultIdentity?.goals) {
    sections.push(`## Current Goals\n${ctx.vaultIdentity.goals}`);
  }

  // ── User Model (from vault) ─────────────────────────────────────────────
  if (ctx.vaultIdentity?.userModel) {
    sections.push(`## About the User\n${ctx.vaultIdentity.userModel}`);
  }

  // ── Operational Rules ───────────────────────────────────────────────────
  sections.push(`## Operational Rules
- Be direct. Be concise. Respond in your own voice.
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

  // ── Memory Context ──────────────────────────────────────────────────────
  sections.push(`## Memory
You have tiered memory that works automatically:
- **Preflight**: Before every turn, relevant memories are retrieved from the project brain (.aries/) and vault (Ori) and injected into your context. You don't need to ask for them.
- **Postflight**: After every response, the system writes back — bumping relevance on accessed notes and accumulating importance.
- **Compaction**: When context fills, insights are classified (ephemeral/project/vault) and saved to the appropriate tier before summarizing. Nothing valuable is lost.
- **Explicit tools**: You also have VaultSearch, VaultRead, VaultAdd, VaultExplore, VaultWarmth, and ProjectSearch for manual deep dives when preflight isn't enough.`);

  // ── Tool Usage ──────────────────────────────────────────────────────────
  sections.push(`## Tool Usage
- Use Read instead of cat/head/tail via Bash.
- Use Write instead of echo/heredoc via Bash.
- Use Edit instead of sed/awk via Bash.
- Use Glob instead of find/ls via Bash.
- Use Grep instead of grep/rg via Bash.
- Reserve Bash for system commands and terminal operations.
- If multiple tool calls are independent, call them in parallel.
- Read-only tools run in parallel. Write tools run serially.`);

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

  // ── CLAUDE.md / project instructions ────────────────────────────────────
  const claudeMdPaths = [
    join(ctx.cwd, 'CLAUDE.md'),
    join(ctx.cwd, '.claude', 'CLAUDE.md'),
  ];
  for (const p of claudeMdPaths) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, 'utf-8');
        sections.push(`## Project Instructions (${p})\n${content}`);
      } catch { /* skip unreadable */ }
      break;
    }
  }

  return sections.join('\n\n');
}

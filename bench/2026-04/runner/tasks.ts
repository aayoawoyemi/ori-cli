/**
 * Bench tasks — 10 read-only investigations across aries, claude-code, pi.
 *
 * Each task has a prompt, an objective grader, and target metrics.
 * Graders are data-driven (regex arrays) — flexible without per-task code.
 */

export interface Grader {
  /** Every pattern must appear in the final answer (case-insensitive, regex). */
  mustContainAll?: string[];
  /** At least N of these patterns must appear. */
  mustContainAtLeast?: { n: number; patterns: string[] };
  /** Optional anti-pattern — if present, fails. */
  mustNotContain?: string[];
}

export interface BenchTask {
  id: string;
  category: 'dogfood' | 'external';
  prompt: string;
  grader: Grader;
  /** Reference answer summary, surfaced in result for human-readable verification. */
  reference: string;
  target: {
    tokens: number;
    toolCalls: number;
    wallMs: number;
  };
}

export const TASKS: BenchTask[] = [
  // ── Dogfood: aries internals ─────────────────────────────────────────────
  {
    id: '01-cache-break-trace',
    category: 'dogfood',
    prompt:
      "Where is CACHE_PREFIX_BREAK defined and how does the Anthropic provider use it? " +
      "Name the file and line for the constant, the function that splits the system prompt on it, " +
      "cite src/router/providers/anthropic.ts where the native Anthropic provider consumes the split, " +
      "and list three things that go above the break vs three things below.",
    grader: {
      mustContainAll: [
        'src/prompt\\.ts',
        'splitSystemPromptInput|splitSystemPromptByCacheBoundary|split.*cache.*boundary',
        'anthropic\\.ts',
      ],
      mustContainAtLeast: {
        n: 3,
        patterns: ['identity', 'warm context', 'operational rules', 'memory', 'codebase signature', 'vault signature', 'project instructions', 'environment', 'date', 'git branch'],
      },
    },
    reference: 'src/prompt.ts:12 (constant), :241-243 (insertion point), src/router/providers/anthropic.ts:105-119 (splitter), :381-410 (use). Above: identity, warm, rules, memory, signatures, project. Below: env (cwd, git, platform, shell, date — date busts cache).',
    target: { tokens: 8000, toolCalls: 5, wallMs: 60000 },
  },

  {
    id: '02-code-import-detector-fix',
    category: 'dogfood',
    prompt:
      "In bench/2026-04/fixtures/import-detector-bug.ts, the code tool rejects valid Python imports like `import json` as TypeScript/JavaScript before the import-specific lint can explain that imports are forbidden. " +
      "Find the detector, explain the exact regex bug, and give the minimal TypeScript patch. Do not edit files; inspect the source and answer from the code.",
    grader: {
      mustContainAll: [
        'looksLikeTypeScriptOrJavaScript',
        'import json|from collections|Python import',
        'TypeScript|JavaScript|TS\\/JS',
        'Imports are forbidden|import-specific|import lint',
      ],
      mustContainAtLeast: {
        n: 2,
        patterns: [
          'import\\s+type',
          'from\\s+["\\\']',
          'side-effect',
          '\\{',
          'do not match|avoid matching|stop matching',
        ],
      },
    },
    reference: 'The broad /^\\s*import\\s+(?:type\\s+)?[{*\\w]/ regex matches Python imports. Split TS/JS import detection into import type, import { ... }, import * ..., import name from "...", and side-effect import "..."; let Python import/from statements fall through to the import-forbidden lint.',
    target: { tokens: 6000, toolCalls: 2, wallMs: 30000 },
  },

  {
    id: '03-mode-reminder-inventory',
    category: 'dogfood',
    prompt:
      "List every place in src/loop.ts that injects a synthetic <system-reminder> into the message stream. " +
      "For each, name the trigger condition.",
    grader: {
      mustContainAll: [
        'research',
        'plan',
        'recovery|consecutive.*fail',
        'rejection|repeated',
      ],
      mustContainAtLeast: {
        n: 4,
        patterns: ['research', 'explore', 'plan', 'recovery', 'rejection', 'fail'],
      },
    },
    reference: '5 sites in loop.ts:395-490 — research-mode, explore-mode, plan-mode, recovery (consecutiveFailureTurns>0), repeated-tool-rejection.',
    target: { tokens: 6000, toolCalls: 1, wallMs: 30000 },
  },

  {
    id: '04-postflight-gate',
    category: 'dogfood',
    prompt: "When does the postflight cheap-call fire in src/loop.ts? What's the exact gate condition?",
    grader: {
      mustContainAll: [
        'tool.use|tool_use|tool use|tool work|turnHadToolWork',
        'tool.result|tool_result',
      ],
      mustContainAtLeast: {
        n: 1,
        patterns: ['last 3', 'three message', 'recent.*message', 'slice'],
      },
    },
    reference: 'loop.ts:858-876. turnHadToolWork = last 3 messages contain tool_use OR tool_result block. Skips text-only chat turns.',
    target: { tokens: 4000, toolCalls: 1, wallMs: 20000 },
  },

  {
    id: '05-vault-warmth-trace',
    category: 'dogfood',
    prompt: "Trace one vault.warmth() call from the Repl namespace through to the underlying Ori MCP method. Name each layer.",
    grader: {
      mustContainAll: [
        'body/vault\\.py|vault\\.py',
        'bridge|JSON.RPC|json-rpc|repl/bridge',
        'ori_warmth|warmth|Ori|MCP',
      ],
    },
    reference: 'body/vault.py warmth → src/repl/bridge.ts JSON-RPC → Ori MCP ori_warmth tool. Crosses Python→TS at the bridge.',
    target: { tokens: 8000, toolCalls: 4, wallMs: 60000 },
  },

  // ── External: pi-mono navigation ─────────────────────────────────────────
  {
    id: '06-pi-system-prompt',
    category: 'external',
    prompt:
      "Open bench/2026-04/fixtures/pi-mono/packages/coding-agent/src/core/system-prompt.ts. " +
      "What's the first sentence of the default system prompt (when no customPrompt is set), " +
      "and what sections come after it?",
    grader: {
      mustContainAll: [
        'expert.coding.assistant|coding agent harness',
        'pi',
      ],
      mustContainAtLeast: {
        n: 3,
        patterns: ['Available tools', 'Guidelines', 'documentation', 'date', 'cwd|working directory'],
      },
    },
    reference: 'system-prompt.ts:131-147. First sentence: "You are an expert coding assistant operating inside pi, a coding agent harness." Sections: Available tools, Guidelines, Pi documentation, date, cwd.',
    target: { tokens: 5000, toolCalls: 1, wallMs: 30000 },
  },

  {
    id: '07-pi-parallel-tool',
    category: 'external',
    prompt:
      "In pi-mono's packages/agent/src/agent-loop.ts, where is the decision made whether tool calls execute in parallel vs sequential? " +
      "What triggers sequential mode?",
    grader: {
      mustContainAll: [
        'executeToolCalls',
        'sequential',
        'executionMode|toolExecution',
      ],
      mustContainAtLeast: {
        n: 1,
        patterns: ['executeToolCallsSequential', 'executeToolCallsParallel'],
      },
    },
    reference: 'agent-loop.ts:338-353. Sequential when config.toolExecution === "sequential" OR any tool has executionMode === "sequential". Dispatches to executeToolCallsSequential vs executeToolCallsParallel.',
    target: { tokens: 6000, toolCalls: 2, wallMs: 30000 },
  },

  {
    id: '08-pi-provider-compare',
    category: 'external',
    prompt:
      "pi-mono has both openai-completions.ts and openai-responses.ts in packages/ai/src/providers/. " +
      "What's the API-level difference between OpenAI's Completions API and Responses API? " +
      "Why does pi support both?",
    grader: {
      mustContainAll: [
        'completions',
        'responses',
      ],
      mustContainAtLeast: {
        n: 1,
        patterns: ['stateful|previous_response_id|server.side', 'reasoning', 'newer|legacy', 'compatibility'],
      },
    },
    reference: 'Completions = legacy chat completions endpoint. Responses = newer stateful API (previous_response_id, built-in tools, reasoning tokens). Pi supports both for provider compatibility (different model providers expose one or the other).',
    target: { tokens: 10000, toolCalls: 3, wallMs: 60000 },
  },

  {
    id: '09-pi-tool-count',
    category: 'external',
    prompt:
      "How many tools does pi-mono's coding-agent expose by default in packages/coding-agent/src/core/tools/? Name each.",
    grader: {
      mustContainAll: [
        '\\b7\\b|\\bseven\\b',
        'read',
        'bash',
        'edit',
        'write',
        'grep',
        'find',
        'ls',
      ],
    },
    reference: '7 tools: read, bash, edit, write, grep, find, ls.',
    target: { tokens: 3000, toolCalls: 1, wallMs: 20000 },
  },

  {
    id: '10-pi-agent-loop',
    category: 'external',
    prompt:
      "What's the line count of pi-mono's packages/agent/src/agent-loop.ts, " +
      "and what are the top-level exported functions?",
    grader: {
      mustContainAll: [
        '\\b68[0-9]\\b|\\b6[78][0-9]\\b', // 683 ± 5
        'agentLoop',
      ],
      mustContainAtLeast: {
        n: 2,
        patterns: ['agentLoop\\b', 'agentLoopContinue', 'runAgentLoop', 'runAgentLoopContinue'],
      },
    },
    reference: '683 lines. Exports: agentLoop, agentLoopContinue, runAgentLoop, runAgentLoopContinue.',
    target: { tokens: 4000, toolCalls: 2, wallMs: 20000 },
  },
];

export function gradeAnswer(grader: Grader, answer: string): { passed: boolean; missing: string[]; reasons: string[] } {
  const missing: string[] = [];
  const reasons: string[] = [];

  if (grader.mustContainAll) {
    for (const pattern of grader.mustContainAll) {
      const re = new RegExp(pattern, 'i');
      if (!re.test(answer)) {
        missing.push(`mustContainAll: ${pattern}`);
      }
    }
  }

  if (grader.mustContainAtLeast) {
    const matched = grader.mustContainAtLeast.patterns.filter((p) => new RegExp(p, 'i').test(answer));
    if (matched.length < grader.mustContainAtLeast.n) {
      missing.push(`mustContainAtLeast(${grader.mustContainAtLeast.n}): only matched ${matched.length} of ${grader.mustContainAtLeast.patterns.length}`);
    }
  }

  if (grader.mustNotContain) {
    for (const pattern of grader.mustNotContain) {
      if (new RegExp(pattern, 'i').test(answer)) {
        reasons.push(`hit mustNotContain: ${pattern}`);
      }
    }
  }

  return {
    passed: missing.length === 0 && reasons.length === 0,
    missing,
    reasons,
  };
}

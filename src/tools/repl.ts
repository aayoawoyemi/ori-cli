/**
 * Repl tool — lets the model execute Python in the body subprocess.
 *
 * Wraps bridge.exec() as a standard Tool. When the model calls this,
 * it gets access to the full REPL namespace: codebase, vault, rlm_call,
 * rlm_batch, safe builtins. Output comes back as tool_result.
 */
import type { Tool, ToolContext } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';
import type { ReplHandle } from '../repl/setup.js';

// ── Repl tool description — the structural teaching channel ──────────────
// Why this description is long and example-heavy: the `description` field
// is part of the tool schema, which every provider (Anthropic, OpenAI-
// compat, OpenRouter) sends to the model on every request BEFORE the
// model emits any tool_use. It lives in the cached prefix, so it costs
// nothing per turn after cache warms. A prompt paragraph describing the
// same thing is soft (ignorable, not provider-uniform, not cache-aligned);
// a packed tool description is structural (part of the contract, seen
// first-turn, cross-model, cached).
//
// The examples matter more than the prose. Models in-context-learn from
// patterns. Three compositions + one anti-pattern teach what "compose
// multiple operations per call" actually looks like in Python.
//
// Keep in sync with the namespace registered in body/server.py's
// _build_namespace and with the first-turn banner in _format_first_turn_banner.

const REPL_DESCRIPTION = `Run Python in your persistent namespace. State (variables, imports, computations) survives across Repl calls in the same session.

Pre-loaded in the namespace: codebase, vault, fs, shell, web, rlm_call, rlm_batch, say, ask, json, reindex. The first Repl call in a session returns a tool_result whose header lists exactly what's loaded for your session (some primitives depend on config).

Compose multiple operations per call. A single composed call is how you win — it is faster, cheaper, and produces tighter reasoning than N fragmented calls.

# Example: search → read top 3 → parallel summarize
hits = codebase.search("auth middleware", limit=20)
top = hits[:3]
pairs = [(fs.read(h['file']), "what does this file do?") for h in top]
summaries = rlm_batch(pairs)
for h, s in zip(top, summaries):
    say(f"{h['file']}: {s}")

# Example: verify-then-edit
content = fs.read("src/auth.ts")
assert "oldPattern" in content, "target not present"
fs.edit("src/auth.ts", "oldPattern", "newPattern")
say("Edited src/auth.ts — 1 replacement.")

# Example: branch on repo state
if fs.glob("package.json"):
    result = shell.run("npm test")
    say(f"Tests: exit {result['code']}")
else:
    say("No package.json — skipping test run.")

Anti-pattern: calling Repl once to read, once to search, once to write. Compose them. Variables persist across calls, but composition inside ONE call is always cheaper and produces tighter reasoning.

Restrictions: no imports (namespace is pre-loaded), no eval/exec/open, no dunder attribute access.`;

export class ReplTool implements Tool {
  readonly name = 'Repl';
  readonly description = REPL_DESCRIPTION;
  readonly readOnly = false;

  constructor(private getHandle: () => ReplHandle | null) {}

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            // One-line pointer — full namespace + composition examples live
            // in the tool description above. Don't duplicate them here.
            description:
              'Python code to execute. See tool description for pre-loaded namespace + composition patterns. Use print() or say() for output.',
          },
        },
        required: ['code'],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    _ctx: ToolContext,
  ): Promise<ToolResult> {
    const handle = this.getHandle();
    if (!handle) {
      return {
        id: '',
        name: this.name,
        output: 'REPL not available. Set `repl.enabled: true` in config and restart.',
        isError: true,
      };
    }

    const code = (input.code as string) ?? '';
    if (!code.trim()) {
      return { id: '', name: this.name, output: 'Empty code block.', isError: true };
    }

    // ── Client-side lint: catch common guaranteed-failure patterns ─────
    // The AST guard on the Python side rejects these too, but it costs a
    // bridge round-trip. Catching locally saves ~50ms and, more importantly,
    // the error message can be specific about what to do instead.
    const importMatch = code.match(/^\s*(?:import|from)\s+[\w.]+/m);
    if (importMatch) {
      return {
        id: '',
        name: this.name,
        output: `Repl rejected: imports are forbidden (you wrote "${importMatch[0].trim()}"). The Repl namespace is PRE-LOADED with what you need — use these objects directly, no import needed:\n  - fs.read(path) / fs.listdir(path) / fs.glob(pattern, path)\n  - codebase.search / find_symbol / get_context / show_dependents / communities / find_convention\n  - vault.explore / query_ranked / query_warmth / add / orient\n  - rlm_call(slice, question) / rlm_batch([...])\nTry again WITHOUT the import. If you need a stdlib function, it's not available — describe what you need and use the pre-loaded objects.`,
        isError: true,
      };
    }

    // TypeScript syntax sneaking into Python Repl (Sonnet does this occasionally)
    if (/^\s*(?:const|let|var|function|interface|type)\s+\w+/m.test(code)) {
      return {
        id: '',
        name: this.name,
        output: `Repl rejected: this code looks like TypeScript/JavaScript. The Repl runs Python. Rewrite using Python syntax (def not function, = not const, dict not interface, etc).`,
        isError: true,
      };
    }

    const result = await handle.exec({ code }, _ctx.signal);

    if (result.rejected) {
      return {
        id: '',
        name: this.name,
        output: `AST guard rejected: ${result.rejected.reason}`,
        isError: true,
      };
    }

    if (result.timed_out) {
      return {
        id: '',
        name: this.name,
        output: `Timed out after ${result.duration_ms}ms`,
        isError: true,
      };
    }

    // Format output for the model
    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout.trimEnd());
    if (result.stderr) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
    if (result.exception) parts.push(`[exception]\n${result.exception.trimEnd()}`);

    const statsParts: string[] = [`${result.duration_ms}ms`];
    if (result.rlm_stats && result.rlm_stats.call_count > 0) {
      statsParts.push(
        `${result.rlm_stats.call_count} rlm calls`,
        `${result.rlm_stats.total_tokens} tokens`,
      );
    }
    parts.push(`(${statsParts.join(' · ')})`);

    return {
      id: '',
      name: this.name,
      output: parts.join('\n\n') || '(no output)',
      isError: result.exception !== null,
    };
  }
}

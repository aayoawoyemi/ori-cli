# bench / 2026-04 — runner

Programmatic three-way comparison: aries-cli vs Claude Code vs pi-coding-agent.

## Pre-reqs

```bash
# 1. Build aries
npm run build

# 2. Make sure CLIs are on PATH (or set env)
which claude          # Claude Code
which pi              # pi-coding-agent (or set PI_CLI=/path/to/pi)

# 3. Clone pi-mono fixture for external tasks
git clone https://github.com/badlogic/pi-mono bench/2026-04/fixtures/pi-mono
(cd bench/2026-04/fixtures/pi-mono && git rev-parse HEAD) > bench/2026-04/runs/.PIN.txt

# 4. Auth: Anthropic API key (claude + aries default to Anthropic)
export ANTHROPIC_API_KEY=...
```

## Run

```bash
# Full matrix: 10 tasks × 3 CLIs = 30 runs
npx tsx bench/2026-04/runner/run.ts

# Single task across all CLIs
npx tsx bench/2026-04/runner/run.ts --task 01-cache-break-trace

# Single CLI across all tasks
npx tsx bench/2026-04/runner/run.ts --cli aries-cli

# One cell
npx tsx bench/2026-04/runner/run.ts --task 01-cache-break-trace --cli aries-cli
```

## Output

```
bench/2026-04/runs/{YYYY-MM-DD}/
  {task-id}-{cli}.json              # structured result per run
  {task-id}-{cli}.transcript.txt    # raw transcript / session log
  SUMMARY.md                        # aggregate matrix + per-CLI averages
```

## How invocation works per CLI

| CLI | Invocation | Output source |
|---|---|---|
| aries-cli | `node dist/index.js "<prompt>"` with `ARIES_HEADLESS=1` | session log at `~/.aries/sessions/{id}/*.jsonl` (newest after run) |
| claude-code | `claude -p --output-format stream-json --include-partial-messages --dangerously-skip-permissions --model claude-opus-4-7` (prompt via stdin) | stdout (newline-delimited JSON) |
| pi-coding-agent | `pi --mode json --model claude-opus-4-7 "<prompt>"` | stdout (newline-delimited JSON) |

## What gets captured

- `tokens.input` / `cached` / `output` / `total` — provider usage events
- `tool_calls.total` + `by_tool` — count of tool_use blocks
- `final_answer` — last assistant text block (used for grading)
- `wall_ms` — process wall time, from spawn to exit
- `success` — boolean from regex grader (see `tasks.ts`)
- `success_details.missing` — which grader patterns missed (debug failed runs)
- `fragmentation.ratio` — actual_tool_calls / target_tool_calls (1.0 = optimal)
- `compose` — Aries compose-loop rollups: quick/compose/goal request counts, cells/request, preflight coverage, gate rejection reasons, scout/verify/repair counts, and micro cells by mode
- `exit_code` — CLI exit status

## Grader logic

Each task in `tasks.ts` has a `Grader`:

```ts
{
  mustContainAll: string[];                    // every regex must match
  mustContainAtLeast: { n: number; patterns: string[] };  // at least N match
  mustNotContain?: string[];                   // anti-patterns (optional)
}
```

Fail-soft: if a CLI produces nothing (timeout, crash), the result is recorded
with `success: false` and a notes field. We don't bail the whole run.

## Common failure modes + fixes

- **`Cannot find module 'dist/index.js'`** → run `npm run build`
- **`spawn claude ENOENT`** → Claude Code not on PATH; install or symlink
- **`spawn pi ENOENT`** → set `PI_CLI=/full/path/to/pi`
- **External tasks (06-10) fail** → fixture missing; clone pi-mono per pre-reqs
- **aries returns 0 tokens** → loop.ts didn't emit usage to session log; verify the patch in commit landed
- **aries timeout** → 5-min default; some tasks need more for cold codebase index. Bump `TIMEOUT_MS` in `run.ts`

## Anti-patterns

- ❌ Re-running a failed task with a tweaked prompt — that's tuning. Update `tasks.ts` once, re-run all CLIs.
- ❌ Comparing against the legacy `bench/results/phase7-*` — those are zero-data placeholders (auth-failed runs).
- ❌ Running the bench from inside an aries session — the auto-watcher will restart aries on file changes.

## Vault cross-post

After each run, copy `runs/{date}/SUMMARY.md` into the vault:

```bash
cp bench/2026-04/runs/{date}/SUMMARY.md \
   ~/brain/notes/aries-bench-{date}-aries-vs-cc-vs-pi.md
```

(Add frontmatter to the vault note: `---\ntype: benchmark\ntags: [aries, cli, benchmarks]\n---`.)

## Extending

- **New task**: append to `TASKS` in `tasks.ts` with prompt + grader + reference.
- **New CLI**: add invocation builder + parser in `parsers.ts`, register in `run.ts`'s `CliName` union and `getInvocation`.
- **LLM-as-judge**: replace `gradeAnswer` in `tasks.ts` with a model call that compares `finalAnswer` to `task.reference`.

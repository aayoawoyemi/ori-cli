# bench / 2026-04

Three-way comparison: **aries-cli** vs **Claude Code** vs **pi-coding-agent**, same Opus model, ten tasks, manual runs.

## Why this exists

We've been arguing harness architecture from anecdote. This bench replaces that with numbers. Every architectural decision after 2026-04-26 (codemode tweaks, loop separation, possible TS body migration) gates on running the suite and showing the delta.

## Status

- **Phase7 results (`bench/results/phase7-*`) are superseded.** Every row in those files is a zero-data placeholder — the runner errored out on missing `GOOGLE_API_KEY` before any task executed. Kept on disk for historical reference only.
- **This bench is the new baseline.** Manual runs, three CLIs, ten tasks, structured output.

## How to run

Manual. No runner. The point is honest measurement, not automation.

For each `(task, cli)` pair:

1. Open the CLI fresh (new session, no carry-over context).
2. Paste the task prompt verbatim from `TASKS.md`.
3. Let it run to completion (or until you'd give up in real use).
4. Capture results into `runs/{YYYY-MM-DD}/{task-id}-{cli}.json` using `RESULT_TEMPLATE.json` as the schema.
5. Mark success against the reference answer in `TASKS.md`.

Per task: 3 CLIs × 1 run = 3 runs. Total: 30 runs to fill the matrix.

## What gets captured

| Field | Source |
|---|---|
| `tokens.input` / `tokens.cached` / `tokens.output` | CLI's reported usage at session end |
| `tool_calls.total` / `tool_calls.by_tool` | Count tool-use blocks in the transcript |
| `fragmentation.ops_per_logical_action` | Tool calls divided by distinct logical steps in the reference answer |
| `wall_ms` | Stopwatch the human runs while watching |
| `success` | Reference-answer match (y/n) per `TASKS.md` |
| `notes` | Anything qualitative — meandering, oscillation, mode-confusion |

## Where results live

- **Repo**: `bench/2026-04/runs/{YYYY-MM-DD}/` — full JSON per run + a `SUMMARY.md` rolled up by hand from the matrix.
- **Vault**: cross-post `SUMMARY.md` to `~/brain/notes/aries-bench-{YYYY-MM-DD}-aries-vs-cc-vs-pi.md` so future sessions can recall it via `vault.search`.

## Fixtures

External tasks (6-10) target **pi-mono** at a frozen commit. Clone once before running:

```bash
git clone https://github.com/badlogic/pi-mono bench/2026-04/fixtures/pi-mono
cd bench/2026-04/fixtures/pi-mono && git checkout <pin-commit>
```

Pin commit: capture `git rev-parse HEAD` after cloning and record it in `runs/{date}/PIN.txt`. Re-runs must use the same commit or note the diff.

## Decision gates

- **After first full matrix run**: aries vs pi vs CC table. We know who's winning on what.
- **After Phase 1 cheap fixes** (per `bench/2026-04/PHASE_PLAN.md` if drafted): re-run, measure delta, lock numbers.
- **Before Phase 3 TS prototype**: pick the 3 tasks the prototype will be measured on. Freeze them.

## Anti-patterns

- ❌ Running the bench yourself while editing aries — model picks up file changes mid-task.
- ❌ Re-running a failed task with a "better prompt" — that's tuning, not measuring. Fix the prompt in `TASKS.md` once, re-run all three CLIs.
- ❌ Treating one run as signal — three runs per task per CLI when the variance matters.
- ❌ Ignoring fragmentation rate — token totals can lie when one path is cached and another isn't.

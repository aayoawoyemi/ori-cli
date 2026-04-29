# SWE-bench Lite — single-task pilot

A minimal harness for running ONE SWE-bench-Lite task end-to-end against
either `aries-cli` or `claude-code`. Designed for spot-checks, not
leaderboards. No batching, no scoring across CLIs in one shot — fire one
task at a time, watch it, decide whether to fire another.

## One-time setup

```bash
npx tsx bench/swe-lite/fetch-tasks.ts
```

Downloads the SWE-bench Lite test split (300 tasks) from Hugging Face
into `bench/swe-lite/tasks.json` and prints a shortlist of
small-repo candidates (marshmallow / pytest / pylint / requests / flask /
click — all pure-Python, fast install).

You also need `python` on PATH (for venv creation) and `git`.

## Run one task

```bash
# aries
npx tsx bench/swe-lite/run.ts --task marshmallow-code__marshmallow-1359 --cli aries-cli

# claude-code
npx tsx bench/swe-lite/run.ts --task marshmallow-code__marshmallow-1359 --cli claude-code
```

What happens, in order:
1. `git clone` the repo into `workspaces/<id>/repo`.
2. `git checkout <base_commit>`.
3. Apply `test_patch` so the failing test exists in the tree.
4. Create `workspaces/<id>/venv`, `pip install` the repo + pytest.
5. Spawn the agent with `cwd=repo` and the GitHub-issue text as the prompt.
6. Run the FAIL_TO_PASS and PASS_TO_PASS tests via pytest in the venv.
7. Write `results/<id>-<cli>.json` and print a one-line summary.

## Cost discipline

Defaults are tuned for cheap pilots:

| knob | default | env var |
|---|---|---|
| model | `claude-sonnet-4-6` | `BENCH_MODEL` |
| max turns | 20 | `BENCH_MAX_TURNS` |
| agent timeout | 15 min | `BENCH_AGENT_TIMEOUT_MS` |
| pytest timeout | 5 min | `BENCH_PYTEST_TIMEOUT_MS` |

A marshmallow-tier task costs roughly **$0.50–$2** on Sonnet. Pylint or
pytest tasks tend to be heavier (more files for the agent to read). Run
one, look at the result, decide whether to run another.

## Re-run shortcuts

```bash
# Re-run agent on the same workspace (skip clone + install)
npx tsx bench/swe-lite/run.ts --task <id> --cli aries-cli --skip-setup

# Re-grade a workspace without re-running the agent
npx tsx bench/swe-lite/run.ts --task <id> --cli aries-cli --skip-setup --skip-agent
```

`--skip-setup` is the big one — clone + install is the slow part of a
fresh run. After the first run, every retry should use it.

## What "success" means

```
ftp.passed == FAIL_TO_PASS.length   AND
ftp.failed == 0  AND  ftp.errored == 0  AND
ptp.failed == 0  AND  ptp.errored == 0   (first 30 PASS_TO_PASS tests)
```

We cap PASS_TO_PASS at the first 30 to keep grading time bounded.
Full SWE-bench grading runs every PASS_TO_PASS test; we don't, because
this is a pilot.

## Inspecting a run

```bash
# What did the agent change?
git -C bench/swe-lite/workspaces/<id>/repo diff HEAD

# Aries session log (turn-by-turn tool calls + tokens)
ls -t ~/.aries/sessions/3bb966f197f7/ | head -3

# Result JSON
cat bench/swe-lite/results/<id>-<cli>.json
```

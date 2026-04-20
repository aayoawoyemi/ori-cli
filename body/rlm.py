"""
rlm_call — recursive self-invocation via Anthropic API.

Core primitive of the REPL harness. Spawns a fresh LLM instance with a focused
slice and sub-question. Returns the answer as a Python value.

Hard rails:
  - Call count cap (_max_calls_per_exec, default 15 per top-level exec) —
    enforced by an explicit counter, prevents runaway cost
  - Parallel degree cap (_max_parallel, default 5) — asyncio semaphore,
    avoids rate limits
  - Token budget — injected into sub-call prompt + max_tokens
  - Per-call trajectory captured for later training data

Depth cap = 1 is guaranteed ARCHITECTURALLY, not by runtime counting:
  1. rlm_call makes a plain Anthropic API completion
  2. The sub-LLM has a single user-turn prompt. No tools. No REPL. No rlm_call.
  3. Its response is a string returned to the outer REPL as a Python value
  4. The string is data, not code — cannot spawn further sub-calls
  If a future change (e.g. adding tool-use to the sub-call prompt) breaks
  any of these properties, depth >1 becomes possible. No runtime guard
  exists today because there is no path for depth to exceed 1.

Parallel execution via `rlm_batch` using asyncio.gather. Independent sub-calls
run concurrently, bounded by semaphore to avoid rate limits.
"""
from __future__ import annotations

import asyncio
from typing import Optional, Any

# Lazy-imported on first call to avoid import cost when rlm_call is unused
_AsyncOpenAI = None
_client: Any = None

# Configuration (set via configure_rlm op)
# Default model chosen 2026-04-19: openai/gpt-oss-20b (was qwen/qwen3-14b).
# Rationale:
#   - 3x cheaper on input ($0.03/M vs $0.10/M) and 2x cheaper on output
#     ($0.14/M vs $0.30/M) on OpenRouter as of April 2026.
#   - Benchmarks above Qwen3 32B on focused tasks (MMLU 85.3, CodeForces 74.3,
#     GPQA 71.5) — i.e. not just cheaper but better for the rlm workload
#     (short focused summarization / extraction).
#   - Does not exhibit the empty-response-at-low-max_tokens quirk we hit
#     with Qwen 14B. The max_tokens floor in _call_single still applies as
#     defense-in-depth if a different model gets swapped in later.
# If you change this, update the comment in src/config/types.ts and the
# default-model pick in src/index.ts resolveRlmConfig — all three must
# agree, and config.repl.rlmModel overrides all three when set.
_api_key: Optional[str] = None
_base_url: Optional[str] = None
_model: str = "openai/gpt-oss-20b"
_max_calls_per_exec: int = 15
_max_parallel: int = 5  # concurrent calls in rlm_batch

# Per-exec state (reset before each exec)
_call_count = 0
_total_input_tokens = 0
_total_output_tokens = 0
_call_log: list[dict] = []


def configure(api_key: str, base_url: Optional[str] = None, model: Optional[str] = None, max_calls: Optional[int] = None) -> None:
    """Set credentials + defaults. Called via server.py configure_rlm op."""
    global _api_key, _base_url, _model, _max_calls_per_exec, _client, _AsyncOpenAI
    _api_key = api_key
    _base_url = base_url
    if model:
        _model = model
    if max_calls:
        _max_calls_per_exec = max_calls
    # Lazy-import openai (OpenAI-compatible protocol — works with OpenRouter, Qwen, DeepSeek, Ollama, etc.)
    if _AsyncOpenAI is None:
        from openai import AsyncOpenAI as _A
        _AsyncOpenAI = _A
    kwargs: dict = {"api_key": api_key}
    if base_url:
        kwargs["base_url"] = base_url
    _client = _AsyncOpenAI(**kwargs)


def is_configured() -> bool:
    return _client is not None


def reset_stats() -> None:
    """Reset per-exec counters. Called before each exec."""
    global _call_count, _total_input_tokens, _total_output_tokens, _call_log
    _call_count = 0
    _total_input_tokens = 0
    _total_output_tokens = 0
    _call_log = []


def get_stats() -> dict:
    """Return current per-exec stats."""
    return {
        "call_count": _call_count,
        "total_tokens": _total_input_tokens + _total_output_tokens,
        "input_tokens": _total_input_tokens,
        "output_tokens": _total_output_tokens,
        "calls": list(_call_log),
    }


def _build_prompt(slice_: Any, sub_question: str, budget: int) -> str:
    """Construct the focused sub-call prompt."""
    slice_str = slice_ if isinstance(slice_, str) else str(slice_)
    # Limit slice to avoid sending huge payloads
    if len(slice_str) > 20_000:
        slice_str = slice_str[:20_000] + "\n\n...(truncated)"
    word_limit = max(40, budget // 4)
    return f"""You are a focused sub-reasoner. One task, one answer.

Context slice:
---
{slice_str}
---

Question: {sub_question}

Answer in under {word_limit} words. Direct, specific, no preamble."""


async def _call_single(slice_: Any, sub_question: str, budget: int) -> str:
    """Execute one async API call. Updates global stats on success."""
    global _call_count, _total_input_tokens, _total_output_tokens

    if _client is None:
        return "(rlm_call not configured — no API key)"

    if _call_count >= _max_calls_per_exec:
        return f"(rlm budget exhausted: max {_max_calls_per_exec} calls per exec)"

    # Reserve a slot BEFORE making the call
    _call_count += 1
    call_num = _call_count

    prompt = _build_prompt(slice_, sub_question, budget)

    # Floor max_tokens at 250 — empirically observed that Qwen 14B (our
    # default sub-reasoner) returns "" when max_tokens <~200 on a large
    # prompt (~8K chars). The model appears to spend some tokens on
    # internal reasoning/formatting before emitting, and with ≤150 tokens
    # available there's nothing left for output. The prompt still tells
    # the model to answer in `word_limit` words (≈ budget/4), so this
    # floor only affects the truncation headroom, not the apparent
    # response length — the model still obeys the word-count instruction.
    # 250 is the lowest floor that produced consistent non-empty answers
    # across the caller sites we tested (codebase.rlm_batch summarization
    # at budget_per=150). If a different sub-reasoner needs a different
    # floor, thread that in via configure_rlm rather than hard-coding per-model.
    effective_max_tokens = max(budget, 250)

    try:
        response = await _client.chat.completions.create(
            model=_model,
            max_tokens=effective_max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
    except Exception as e:
        _call_log.append({
            "call_num": call_num,
            "question": sub_question[:100],
            "error": str(e)[:200],
        })
        return f"(rlm_call error: {str(e)[:200]})"

    answer = ""
    if response.choices and response.choices[0].message.content:
        answer = response.choices[0].message.content

    in_tok = response.usage.prompt_tokens if response.usage else 0
    out_tok = response.usage.completion_tokens if response.usage else 0
    _total_input_tokens += in_tok
    _total_output_tokens += out_tok
    _call_log.append({
        "call_num": call_num,
        "question": sub_question[:100],
        "input_tokens": in_tok,
        "output_tokens": out_tok,
    })
    return answer


# ---------- Public REPL API ----------

def rlm_call(slice_: Any, sub_question: str, budget: int = 1000) -> str:
    """
    Spawn a fresh sub-model (default gpt-oss-20b via OpenRouter) with a
    focused context slice + one question. Returns the answer as a string.

    This is the single-shot fan-OUT primitive. The sub-model sees ONLY
    the slice you pass — not your full conversation history, not your
    tools. That's the point: cheap focused reasoning on a bounded slice,
    returning a string you can treat as data.

    Args:
        slice_: the context the sub-model needs (str or any value — will
          be stringified if not already). Truncated to 20KB to keep per-call
          cost bounded; package the relevant bits yourself.
        sub_question: the specific question. Be direct: "Summarize what this
          file does in one paragraph" beats "Tell me about this file."
        budget: max_tokens cap for the sub-model's response (floored at 250
          internally to prevent empty-response on reasoning-heavy models).
          Word-limit instruction in the prompt is roughly budget/4 words.

    Returns the sub-model's answer string.

    Example (summarize ONE file):
        content = fs.read("src/loop.ts")
        summary = rlm_call(content, "What is the main responsibility of this file?", budget=200)
        say(f"loop.ts: {summary}")

    For parallel fan-out over many inputs, use `rlm_batch`.
    """
    return asyncio.run(_call_single(slice_, sub_question, budget))


def rlm_batch(pairs: list, budget_per: int = 1000) -> list[str]:
    """
    Parallel fan-out — run rlm_call on a list of (slice, question) pairs
    concurrently, bounded by an internal semaphore to avoid rate limits.
    Answers are returned in input order so you can zip them back with
    the original items.

    This is the primary tool for "summarize 20 files in parallel" or
    "extract findings from 10 sources in one call" patterns. Sequential
    rlm_calls are the biggest latency trap; use `rlm_batch` whenever
    you have ≥2 independent sub-questions.

    Args:
        pairs: list of (slice, sub_question) tuples
        budget_per: max_tokens per sub-call (same flooring as rlm_call)

    Returns list of strings in the same order as `pairs`.

    Example (fan-out file summaries, then zip with originals):
        top_files = codebase.pagerank(limit=10)
        pairs = [(fs.read(p), "one-paragraph summary") for p, _ in top_files]
        summaries = rlm_batch(pairs, budget_per=200)
        for (path, score), summary in zip(top_files, summaries):
            say(f"{path} ({score:.3f}): {summary}")

    Example (extract findings from research sources):
        handles = research.ingest(discovered[:8])
        pairs = [
            (research.load(h['handle'], 'fullText'),
             "Extract the key claim + supporting evidence in 2 sentences.")
            for h in handles
        ]
        nuggets = rlm_batch(pairs, budget_per=300)
    """
    if not pairs:
        return []

    async def _run_batch():
        sem = asyncio.Semaphore(_max_parallel)
        async def _bounded(slice_, q):
            async with sem:
                return await _call_single(slice_, q, budget_per)
        tasks = [_bounded(s, q) for s, q in pairs]
        return await asyncio.gather(*tasks, return_exceptions=False)

    return asyncio.run(_run_batch())

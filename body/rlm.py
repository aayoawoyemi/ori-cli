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
_api_key: Optional[str] = None
_base_url: Optional[str] = None
_model: str = "qwen/qwen3-14b"
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

    try:
        response = await _client.chat.completions.create(
            model=_model,
            max_tokens=budget,
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
    Spawn a fresh LLM instance with a focused slice + sub-question.
    Returns the sub-model's answer as a string.
    Synchronous interface; internally runs one async call.
    """
    return asyncio.run(_call_single(slice_, sub_question, budget))


def rlm_batch(pairs: list, budget_per: int = 1000) -> list[str]:
    """
    Run rlm_call on a list of (slice, question) pairs IN PARALLEL.
    Returns list of answers in same order as input pairs.
    Bounded by _max_parallel semaphore to avoid rate limits.
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

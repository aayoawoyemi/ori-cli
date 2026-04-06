"""
rlm_call — recursive self-invocation via Anthropic API.

Spike implementation: direct API call, no depth tracking, basic budget rails.
Hard call count cap enforced globally.
"""
import os
import json
from anthropic import Anthropic

# Global state — hard rails
_call_count = 0
_max_calls = 15
_total_tokens = 0
_call_log = []

# Default model for sub-calls: cheap/fast
SUBCALL_MODEL = "claude-sonnet-4-5-20250929"

_client = None


DRY_RUN = os.environ.get("ORI_SPIKE_DRY_RUN") == "1"


def _get_client():
    global _client
    if _client is None:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError(
                "ANTHROPIC_API_KEY env var required (or set ORI_SPIKE_DRY_RUN=1)."
            )
        _client = Anthropic(api_key=api_key)
    return _client


def rlm_call(slice_: str, sub_question: str, budget: int = 1000) -> str:
    """
    Spawn a fresh LLM instance on a focused slice + sub-question.

    Args:
      slice_: the context slice (code snippet, docs, etc.)
      sub_question: what to ask about this slice
      budget: max output tokens

    Returns:
      The sub-model's answer as a string.
    """
    global _call_count, _total_tokens

    if _call_count >= _max_calls:
        return f"(rlm_call budget exhausted: max {_max_calls} calls)"

    _call_count += 1

    if DRY_RUN:
        # Stubbed: just echo structure so we can test the pipeline
        _call_log.append({
            "question": sub_question[:80],
            "input_tokens": len(slice_) // 4,
            "output_tokens": 50,
        })
        return f"[DRY_RUN stub] answer to: {sub_question[:120]}"

    prompt = f"""You are a focused sub-reasoner. You have exactly one task.

Context slice:
---
{slice_}
---

Question: {sub_question}

Provide a concise, direct answer. Under {budget // 4} words. No preamble."""

    try:
        response = _get_client().messages.create(
            model=SUBCALL_MODEL,
            max_tokens=budget,
            messages=[{"role": "user", "content": prompt}],
        )
    except Exception as e:
        return f"(rlm_call error: {e})"

    answer = response.content[0].text
    tokens = response.usage.input_tokens + response.usage.output_tokens
    _total_tokens += tokens
    _call_log.append({
        "question": sub_question[:80],
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
    })
    return answer


def rlm_batch(pairs: list, budget_per: int = 1000) -> list:
    """
    Run rlm_call on a list of (slice, question) pairs.
    Spike: sequential. Production would use async.
    """
    return [rlm_call(s, q, budget_per) for s, q in pairs]


def get_stats() -> dict:
    return {
        "call_count": _call_count,
        "total_tokens": _total_tokens,
        "calls": _call_log,
    }


def reset_stats():
    global _call_count, _total_tokens, _call_log
    _call_count = 0
    _total_tokens = 0
    _call_log = []

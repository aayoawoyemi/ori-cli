"""
Stay Spanner primitive for model-driven escalation plus telemetry.

The model owns escalation (option A): it calls spanner.escalate(...) when it
decides the task needs planned layers. The harness observes and logs that
decision, but does not auto-flip tiers from brittle heuristics.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Spanner:
    """Model-driven tier state exposed as `spanner` in the REPL."""

    def __init__(self):
        self._tier = "exploration"
        self._reason = ""
        self._layers: int | None = None
        self._events: list[dict[str, Any]] = []

    def escalate(self, reason: str, layers: int | None = None, tier: str = "planned") -> dict[str, Any]:
        """Declare that the current task should move into a planned tier."""
        clean_tier = str(tier or "planned").strip() or "planned"
        if clean_tier not in {"exploration", "one_shot", "planned"}:
            return {"error": "spanner.escalate: tier must be exploration, one_shot, or planned"}
        clean_reason = str(reason or "").strip()
        if not clean_reason:
            return {"error": "spanner.escalate: reason is required"}
        if layers is not None:
            try:
                layers = int(layers)
            except (TypeError, ValueError):
                return {"error": "spanner.escalate: layers must be an integer"}
            if layers < 1:
                return {"error": "spanner.escalate: layers must be >= 1"}
        self._tier = clean_tier
        self._reason = clean_reason
        self._layers = layers
        event = {
            "type": "spanner_escalated",
            "timestamp": _now(),
            "tier": self._tier,
            "layers": self._layers,
            "reason": self._reason,
        }
        self._events.append(event)
        return self.status()

    def status(self) -> dict[str, Any]:
        """Return current tier for tool-result visibility."""
        return {
            "tier": self._tier,
            "reason": self._reason,
            "layers": self._layers,
        }

    def drain_events(self) -> list[dict[str, Any]]:
        events = self._events[:]
        self._events.clear()
        return events

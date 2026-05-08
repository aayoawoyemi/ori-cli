"""
Goal-plan primitive for Loop3's Python body.

This is intentionally provider-neutral and body-local. The model can create a
structured plan, enter/exit phases while it executes composed Repl cells, and
the harness can attach phase telemetry to each tool result without depending on
Anthropic prompt cache or a top-level planning tool.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _slug(text: str, fallback: str = "goal") -> str:
    raw = re.sub(r"[^a-zA-Z0-9]+", "-", text.strip().lower()).strip("-")
    return (raw or fallback)[:72]


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    if isinstance(value, (list, tuple, set)):
        return [str(item).strip() for item in value if str(item).strip()]
    return [str(value)]


def _json_safe(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return str(value)


class Plan:
    """Mutable, intent-scoped plan state exposed as `plan` in the REPL."""

    REQUIRED_PHASE_FIELDS = ("intent", "primitives", "produces_state", "composition")

    def __init__(
        self,
        project_root: Callable[[], str | None],
        state_has: Callable[[str], bool] | None = None,
    ):
        self._project_root = project_root
        self._state_has = state_has or (lambda _key: False)
        self._plan: dict[str, Any] | None = None
        self._active_phase_id: str | None = None
        self._cell_phase_id: str | None = None
        self._last_phase_id: str | None = None
        self._events: list[dict[str, Any]] = []

    def create(
        self,
        goal: str,
        intent: str = "",
        layers: list[dict[str, Any]] | None = None,
        slug: str | None = None,
    ) -> dict[str, Any]:
        """Create a plan file with detailed Layer -> Phase -> Composition shape.

        `layers` should be a list like:
            [{
              "id": "1",
              "name": "Recon",
              "phases": [{
                "id": "1.1",
                "intent": "...",
                "primitives": ["codebase.search", "fs.read"],
                "consumes_state": ["candidate_files"],
                "produces_state": ["ranked_docs"],
                "composition": "parallel gather + dedupe"
              }]
            }]
        """
        goal_text = str(goal).strip()
        if not goal_text:
            return {"error": "plan.create: goal is required"}

        normalized_layers, warnings = self._normalize_layers(layers or [])
        path = self._new_path(slug or goal_text)
        self._plan = {
            "goal": goal_text,
            "intent": str(intent or "").strip(),
            "path": str(path),
            "created_at": _now(),
            "updated_at": _now(),
            "layers": normalized_layers,
            "warnings": warnings,
        }
        self._active_phase_id = None
        self._cell_phase_id = None
        self._last_phase_id = None
        self._persist()
        self._emit("plan_created", goal=goal_text, path=str(path), layer_count=len(normalized_layers), warnings=warnings)
        return {
            "ok": True,
            "path": str(path),
            "goal": goal_text,
            "layer_count": len(normalized_layers),
            "phase_count": sum(len(layer.get("phases", [])) for layer in normalized_layers),
            "warnings": warnings,
        }

    def read(self) -> str:
        """Return the current plan file contents."""
        if not self._plan:
            return ""
        path = Path(self._plan["path"])
        try:
            return path.read_text(encoding="utf-8")
        except OSError:
            return self._render()

    def append_layer(
        self,
        name: str,
        phases: list[dict[str, Any]],
        rationale: str = "",
        layer_id: str | None = None,
    ) -> dict[str, Any]:
        """Append a new detailed layer after prior layer output is known."""
        if not self._plan:
            return {"error": "plan.append_layer: no plan exists; call plan.create first"}
        next_index = len(self._plan["layers"]) + 1
        raw = {
            "id": layer_id or str(next_index),
            "name": name,
            "rationale": rationale,
            "phases": phases,
        }
        layers, warnings = self._normalize_layers([raw])
        layer = layers[0]
        self._plan["layers"].append(layer)
        self._plan.setdefault("warnings", []).extend(warnings)
        self._touch()
        self._persist()
        self._emit("layer_appended", layer_id=layer["id"], name=layer["name"], phase_count=len(layer["phases"]), warnings=warnings)
        return {"ok": True, "layer": layer, "warnings": warnings}

    def enter_phase(self, phase_id: str) -> dict[str, Any]:
        """Mark a planned phase as active before running its composed work."""
        if not self._plan:
            return {"error": "plan.enter_phase: no plan exists; call plan.create first"}
        phase = self._phase_by_id(str(phase_id))
        if not phase:
            return {"error": f"plan.enter_phase: unknown phase {phase_id}"}
        phase["status"] = "in_progress"
        phase["started_at"] = phase.get("started_at") or _now()
        self._active_phase_id = str(phase_id)
        self._cell_phase_id = str(phase_id)
        self._touch()
        self._persist()
        consumes_state = [str(key) for key in phase.get("consumes_state", [])]
        missing_consumes = []
        for key in consumes_state:
            try:
                if not self._state_has(key):
                    missing_consumes.append(key)
            except Exception:
                missing_consumes.append(key)
        self._emit(
            "phase_entered",
            phase_id=str(phase_id),
            expected_primitives=phase.get("primitives", []),
            consumes_state=consumes_state,
            missing_consumes_state=missing_consumes,
            produces_state=phase.get("produces_state", []),
            composition=phase.get("composition", ""),
        )
        return {"ok": True, "phase": self._phase_public(phase)}

    def exit_phase(self, phase_id: str | None = None, outputs: Any = None) -> dict[str, Any]:
        """Mark the active phase complete and optionally record produced values."""
        if not self._plan:
            return {"error": "plan.exit_phase: no plan exists; call plan.create first"}
        pid = str(phase_id or self._active_phase_id or "")
        if not pid:
            return {"error": "plan.exit_phase: phase_id required when no phase is active"}
        phase = self._phase_by_id(pid)
        if not phase:
            return {"error": f"plan.exit_phase: unknown phase {pid}"}
        produces_state = [str(key) for key in phase.get("produces_state", [])]
        missing_state = []
        for key in produces_state:
            try:
                if not self._state_has(key):
                    missing_state.append(key)
            except Exception:
                missing_state.append(key)
        if missing_state:
            self._emit("phase_exit_rejected", phase_id=pid, missing_produces_state=missing_state)
            return {
                "error": "plan.exit_phase: missing produced state keys: " + ", ".join(missing_state),
                "missing_produces_state": missing_state,
                "phase": self._phase_public(phase),
            }
        phase["status"] = "done"
        phase["completed_at"] = _now()
        if outputs is not None:
            phase["outputs"] = _json_safe(outputs)
        self._last_phase_id = pid
        if self._active_phase_id == pid:
            self._active_phase_id = None
        self._touch()
        self._persist()
        self._emit(
            "phase_exited",
            phase_id=pid,
            outputs=_json_safe(outputs),
            produces_state=produces_state,
        )
        return {"ok": True, "phase": self._phase_public(phase)}

    def status(self) -> dict[str, Any]:
        """Return current plan state for the Repl result footer."""
        if not self._plan:
            return {"active": False}
        active_phase = self._phase_by_id(self._active_phase_id) if self._active_phase_id else None
        phase_contracts = []
        for layer in self._plan.get("layers", []):
            for phase in layer.get("phases", []):
                phase_contracts.append({
                    "id": phase.get("id"),
                    "consumes_state": phase.get("consumes_state", []),
                    "produces_state": phase.get("produces_state", []),
                    "status": phase.get("status", "planned"),
                })
        return {
            "active": True,
            "goal": self._plan["goal"],
            "intent": self._plan.get("intent", ""),
            "path": self._plan["path"],
            "active_phase_id": self._active_phase_id,
            "active_phase": self._phase_public(active_phase) if active_phase else None,
            "layer_count": len(self._plan.get("layers", [])),
            "phase_count": sum(len(layer.get("phases", [])) for layer in self._plan.get("layers", [])),
            "composition_policy": "telemetry",
            "state_contracts": phase_contracts,
            "warnings": self._plan.get("warnings", []),
        }

    def begin_cell(self) -> None:
        self._cell_phase_id = None
        self._last_phase_id = None

    def observe_cell(self, shape: dict[str, Any]) -> None:
        """Attach post-exec shape telemetry to the phase used by this cell."""
        if not self._plan:
            return
        phase_id = self._cell_phase_id or self._active_phase_id or self._last_phase_id
        if not phase_id:
            return
        phase = self._phase_by_id(phase_id)
        if not phase:
            return
        actual = [str(p) for p in shape.get("primitives_called", [])]
        actual_set = set(actual)
        expected = [str(p) for p in phase.get("primitives", [])]
        missing = [p for p in expected if p not in actual_set]
        extra = [p for p in actual if p not in expected and not p.startswith("plan.") and not p.startswith("spanner.")]
        event = {
            "phase_id": phase_id,
            "expected_primitives": expected,
            "actual_primitives": actual,
            "missing_primitives": missing,
            "extra_primitives": extra,
            "is_composed": bool(shape.get("is_composed")),
            "is_micro_repl": bool(shape.get("is_micro_repl")),
            "distinct_primitive_count": shape.get("distinct_primitive_count", 0),
            "stmt_count": shape.get("stmt_count", 0),
            "composition_kind": shape.get("composition_kind", ""),
            "composition": phase.get("composition", ""),
            "consumes_state": phase.get("consumes_state", []),
            "produces_state": phase.get("produces_state", []),
        }
        self._emit("phase_cell_observed", **event)
        self._cell_phase_id = None
        self._last_phase_id = None

    def drain_events(self) -> list[dict[str, Any]]:
        events = self._events[:]
        self._events.clear()
        return events

    def _new_path(self, text: str) -> Path:
        root = Path(self._project_root() or ".").resolve()
        plans_dir = root / ".aries" / "plans"
        plans_dir.mkdir(parents=True, exist_ok=True)
        base = _slug(text)
        suffix = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        return plans_dir / f"{base}-{suffix}.md"

    def _normalize_layers(self, layers: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
        warnings: list[str] = []
        out: list[dict[str, Any]] = []
        for layer_index, raw_layer in enumerate(layers, start=1):
            layer_id = str(raw_layer.get("id") or layer_index)
            raw_phases = raw_layer.get("phases") or []
            if not isinstance(raw_phases, list) or not raw_phases:
                warnings.append(f"layer {layer_id} has no phases")
                raw_phases = []
            phases: list[dict[str, Any]] = []
            for phase_index, raw_phase in enumerate(raw_phases, start=1):
                phase_id = str(raw_phase.get("id") or f"{layer_id}.{phase_index}")
                primitives = _as_list(raw_phase.get("primitives"))
                consumes_state = _as_list(raw_phase.get("consumes_state"))
                produces_state = _as_list(raw_phase.get("produces_state"))
                phase = {
                    "id": phase_id,
                    "intent": str(raw_phase.get("intent") or "").strip(),
                    "primitives": primitives,
                    "produces": str(raw_phase.get("produces") or "").strip(),
                    "consumes_state": consumes_state,
                    "produces_state": produces_state,
                    "composition": str(raw_phase.get("composition") or "").strip(),
                    "status": str(raw_phase.get("status") or "planned"),
                }
                for field in self.REQUIRED_PHASE_FIELDS:
                    if field == "primitives":
                        if not primitives:
                            warnings.append(f"phase {phase_id} missing primitives")
                    elif field == "produces_state":
                        if not produces_state:
                            warnings.append(f"phase {phase_id} missing produces_state")
                    elif not phase[field]:
                        warnings.append(f"phase {phase_id} missing {field}")
                phases.append(phase)
            out.append({
                "id": layer_id,
                "name": str(raw_layer.get("name") or f"Layer {layer_id}").strip(),
                "rationale": str(raw_layer.get("rationale") or "").strip(),
                "status": str(raw_layer.get("status") or "planned"),
                "phases": phases,
            })
        return out, warnings

    def _phase_by_id(self, phase_id: str | None) -> dict[str, Any] | None:
        if not phase_id or not self._plan:
            return None
        for layer in self._plan.get("layers", []):
            for phase in layer.get("phases", []):
                if str(phase.get("id")) == str(phase_id):
                    return phase
        return None

    def _phase_public(self, phase: dict[str, Any] | None) -> dict[str, Any] | None:
        if not phase:
            return None
        return {
            "id": phase.get("id"),
            "intent": phase.get("intent", ""),
            "primitives": phase.get("primitives", []),
            "produces": phase.get("produces", ""),
            "consumes_state": phase.get("consumes_state", []),
            "produces_state": phase.get("produces_state", []),
            "composition": phase.get("composition", ""),
            "status": phase.get("status", "planned"),
        }

    def _touch(self) -> None:
        if self._plan:
            self._plan["updated_at"] = _now()

    def _emit(self, event_type: str, **data: Any) -> None:
        self._events.append({"type": event_type, "timestamp": _now(), **data})

    def _persist(self) -> None:
        if not self._plan:
            return
        path = Path(self._plan["path"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self._render(), encoding="utf-8")

    def _render(self) -> str:
        if not self._plan:
            return ""
        lines = [
            f"# Goal Plan: {self._plan['goal']}",
            "",
            f"- intent: {self._plan.get('intent') or '(unspecified)'}",
            f"- created_at: {self._plan.get('created_at')}",
            f"- updated_at: {self._plan.get('updated_at')}",
            "- composition_policy: telemetry",
            "",
            "## Phase Contract",
            "Every phase must declare intent, primitives, produces_state, and composition.",
            "Use state.put(...) for produces_state keys before plan.exit_phase(...).",
            "Execute each phase with one or two composed Repl cells, not sequential single-primitive probes.",
            "",
        ]
        warnings = self._plan.get("warnings") or []
        if warnings:
            lines.extend(["## Plan Warnings", *[f"- {w}" for w in warnings], ""])
        layers = self._plan.get("layers") or []
        if not layers:
            lines.extend([
                "## Layer 1: <name>",
                "### Phase 1.1: <name>",
                "- intent: <why this phase exists>",
                "- primitives: <primitive.a>, <primitive.b>",
                "- consumes_state: <state keys read, or empty>",
                "- produces_state: <state keys written via state.put>",
                "- composition: <parallel_gather | fan_out_read | pipeline | verify>",
                "- status: planned",
                "",
            ])
            return "\n".join(lines)
        for layer in layers:
            lines.extend([
                f"## Layer {layer['id']}: {layer['name']}",
                f"- status: {layer.get('status', 'planned')}",
            ])
            if layer.get("rationale"):
                lines.append(f"- rationale: {layer['rationale']}")
            lines.append("")
            for phase in layer.get("phases", []):
                lines.extend([
                    f"### Phase {phase['id']}",
                    f"- intent: {phase.get('intent') or '(missing)'}",
                    f"- primitives: {', '.join(phase.get('primitives') or []) or '(missing)'}",
                    f"- produces: {phase.get('produces') or '(missing)'}",
                    f"- consumes_state: {', '.join(phase.get('consumes_state') or []) or '(none)'}",
                    f"- produces_state: {', '.join(phase.get('produces_state') or []) or '(missing)'}",
                    f"- composition: {phase.get('composition') or '(missing)'}",
                    f"- status: {phase.get('status', 'planned')}",
                ])
                if "outputs" in phase:
                    lines.append(f"- outputs: {json.dumps(phase['outputs'], ensure_ascii=True)[:1000]}")
                lines.append("")
        return "\n".join(lines)

import assert from 'node:assert/strict';
import { parseAries } from '../bench/2026-04/runner/parsers.js';

// ── Case 1: original baseline ──────────────────────────────────────────────
// One compose request with scout preflight + update, gate rejected once for
// update_required, no commit signal, no done. Followed by a quick request.
// Closure: commitsCount=0, donesCount=0 across 1 compose-or-goal request.
{
  const now = Date.now();
  const log = [
    { type: 'meta', model: 'test-model', vault: null, cwd: '.', agentName: 'Aries', timestamp: now },
    { type: 'request_mode_selected', request_id: 'req_c', mode: 'compose', reason: 'default', input_chars: 12, timestamp: now + 1 },
    { type: 'compose_preflight_parsed', request_id: 'req_c', cell_kind: 'scout', primitives: ['fs.read'], timestamp: now + 2 },
    { type: 'loop3_tool_use', turn: 1, tool_call_id: 'toolu_1', code_head: 'x = 1', code_tail: '', timestamp: now + 3 },
    { type: 'loop3_repl_shape', turn: 1, tool_call_id: 'toolu_1', primitives_called: ['fs.read'], is_micro_repl: true, is_composed: false, stmt_count: 1, timestamp: now + 4 },
    { type: 'loop3_cell_result', turn: 1, status: 'ok', duration_ms: 1, stdout_chars: 0, stderr_chars: 0, say_count: 0, timestamp: now + 5 },
    { type: 'compose_update_parsed', request_id: 'req_c', findings_chars: 9, next_move_chars: 4, timestamp: now + 6 },
    { type: 'compose_gate_rejected', request_id: 'req_c', reason_code: 'update_required', repl_count: 1, timestamp: now + 7 },
    { type: 'request_completed', request_id: 'req_c', mode: 'compose', terminated_via: 'natural', repl_count: 1, preflights_parsed: 1, updates_parsed: 1, gate_rejections: 1, scout_count: 1, timestamp: now + 8 },
    { type: 'request_mode_selected', request_id: 'req_q', mode: 'quick', reason: 'short_question', input_chars: 6, timestamp: now + 9 },
    { type: 'loop3_tool_use', turn: 2, tool_call_id: 'toolu_2', code_head: 'y = 2', code_tail: '', timestamp: now + 10 },
    { type: 'loop3_repl_shape', turn: 2, tool_call_id: 'toolu_2', primitives_called: ['api.stub'], is_micro_repl: true, is_composed: false, stmt_count: 1, timestamp: now + 11 },
    { type: 'loop3_cell_result', turn: 2, status: 'ok', duration_ms: 1, stdout_chars: 0, stderr_chars: 0, say_count: 0, timestamp: now + 12 },
    { type: 'request_completed', request_id: 'req_q', mode: 'quick', terminated_via: 'natural', repl_count: 1, timestamp: now + 13 },
  ].map(e => JSON.stringify(e)).join('\n');

  const m = parseAries(log, '', Number.MAX_SAFE_INTEGER);
  assert.equal(m.compose?.requests.total, 2);
  assert.equal(m.compose?.requests.compose, 1);
  assert.equal(m.compose?.requests.quick, 1);
  assert.equal(m.compose?.cells.total, 2);
  assert.equal(m.compose?.cells.perRequest, 1);
  assert.equal(m.compose?.preflights.parsed, 1);
  assert.equal(m.compose?.preflights.scout, 1);
  assert.equal(m.compose?.updatesParsed, 1);
  assert.equal(m.compose?.gateRejections.total, 1);
  assert.equal(m.compose?.gateRejections.updateRequired, 1);
  assert.equal(m.compose?.preflights.coveragePct, 33);
  assert.equal(m.compose?.microCellsByMode.compose, 1);
  assert.equal(m.compose?.microCellsByMode.quick, 1);
  // Quick request must NOT pollute the closure denominator.
  assert.equal(m.compose?.closure.composeOrGoalRequests, 1);
  assert.equal(m.compose?.closure.commitsCount, 0);
  assert.equal(m.compose?.closure.donesCount, 0);
  assert.equal(m.compose?.closure.commitRatePct, 0);
  assert.equal(m.compose?.closure.doneRatePct, 0);
}

// ── Case 2: explicit commit-kind preflight + structured done ───────────────
// Model declared a commit preflight then committed via done(). Closure:
// commitsCount=1, donesCount=1 over 1 compose-or-goal request.
{
  const now = Date.now();
  const log = [
    { type: 'meta', model: 'test', vault: null, cwd: '.', agentName: 'Aries', timestamp: now },
    { type: 'request_mode_selected', request_id: 'req_a', mode: 'compose', reason: 'default', input_chars: 12, timestamp: now + 1 },
    { type: 'compose_preflight_parsed', request_id: 'req_a', cell_kind: 'commit', primitives: ['done'], timestamp: now + 2 },
    { type: 'loop3_tool_use', turn: 1, tool_call_id: 'toolu_1', code_head: 'done("ok")', code_tail: '', timestamp: now + 3 },
    { type: 'loop3_repl_shape', turn: 1, tool_call_id: 'toolu_1', primitives_called: ['done'], is_micro_repl: true, is_composed: false, stmt_count: 1, timestamp: now + 4 },
    { type: 'loop3_done_committed', turn: 1, value: 'ok', value_type: 'str', value_chars: 2, timestamp: now + 5 },
    { type: 'loop3_completion', turn: 1, channel: 'done', assistant_chars: 0, cell_count: 1, elapsed_ms: 1, timestamp: now + 6 },
    { type: 'request_completed', request_id: 'req_a', mode: 'compose', terminated_via: 'done', repl_count: 1, preflights_parsed: 1, timestamp: now + 7 },
  ].map(e => JSON.stringify(e)).join('\n');

  const m = parseAries(log, '', Number.MAX_SAFE_INTEGER);
  assert.equal(m.compose?.preflights.commit, 1);
  assert.equal(m.compose?.closure.composeOrGoalRequests, 1);
  assert.equal(m.compose?.closure.commitsCount, 1);
  assert.equal(m.compose?.closure.donesCount, 1);
  assert.equal(m.compose?.closure.commitRatePct, 100);
  assert.equal(m.compose?.closure.doneRatePct, 100);
}

// ── Case 3: V2 exempt commit-only path ─────────────────────────────────────
// Model fired done(answer) directly without a commit preflight. The gate
// exempted it via reason_code=exempt_commit_only. This MUST count toward
// commitsCount even though preflights.commit stays at 0.
{
  const now = Date.now();
  const log = [
    { type: 'meta', model: 'test', vault: null, cwd: '.', agentName: 'Aries', timestamp: now },
    { type: 'request_mode_selected', request_id: 'req_b', mode: 'compose', reason: 'default', input_chars: 12, timestamp: now + 1 },
    { type: 'compose_preflight_parsed', request_id: 'req_b', cell_kind: 'scout', primitives: ['fs.read'], timestamp: now + 2 },
    { type: 'loop3_tool_use', turn: 1, tool_call_id: 'toolu_1', code_head: 'data = fs.read("x")', code_tail: '', timestamp: now + 3 },
    { type: 'loop3_repl_shape', turn: 1, tool_call_id: 'toolu_1', primitives_called: ['fs.read'], is_micro_repl: true, is_composed: false, stmt_count: 1, timestamp: now + 4 },
    { type: 'loop3_cell_result', turn: 1, status: 'ok', duration_ms: 1, stdout_chars: 0, stderr_chars: 0, say_count: 0, timestamp: now + 5 },
    { type: 'compose_update_parsed', request_id: 'req_b', findings_chars: 9, next_move_chars: 4, timestamp: now + 6 },
    // No commit preflight before the final cell — model jumps straight to
    // done(). Gate exempts via exempt_commit_only.
    { type: 'compose_gate_exempt', request_id: 'req_b', reason_code: 'exempt_commit_only', cell_code_chars: 12, timestamp: now + 7 },
    { type: 'loop3_tool_use', turn: 2, tool_call_id: 'toolu_2', code_head: 'done("hi")', code_tail: '', timestamp: now + 8 },
    { type: 'loop3_repl_shape', turn: 2, tool_call_id: 'toolu_2', primitives_called: ['done'], is_micro_repl: true, is_composed: false, stmt_count: 1, timestamp: now + 9 },
    { type: 'loop3_done_committed', turn: 2, value: 'hi', value_type: 'str', value_chars: 2, timestamp: now + 10 },
    { type: 'loop3_completion', turn: 2, channel: 'done', assistant_chars: 0, cell_count: 2, elapsed_ms: 1, timestamp: now + 11 },
    { type: 'request_completed', request_id: 'req_b', mode: 'compose', terminated_via: 'done', repl_count: 2, preflights_parsed: 1, timestamp: now + 12 },
  ].map(e => JSON.stringify(e)).join('\n');

  const m = parseAries(log, '', Number.MAX_SAFE_INTEGER);
  // No commit preflight was parsed.
  assert.equal(m.compose?.preflights.commit, 0);
  // But the exempt cell IS the closure signal — counts as a commit.
  assert.equal(m.compose?.closure.commitsCount, 1);
  assert.equal(m.compose?.closure.donesCount, 1);
  assert.equal(m.compose?.closure.commitRatePct, 100);
  assert.equal(m.compose?.closure.doneRatePct, 100);
}

// ── Case 4: exempt_repair_after_exception is NOT a closure signal ──────────
// V2's other exemption (repair preflight after an exceptioned cell) is a
// gate bypass, not a commit. It must not inflate commit_rate.
{
  const now = Date.now();
  const log = [
    { type: 'meta', model: 'test', vault: null, cwd: '.', agentName: 'Aries', timestamp: now },
    { type: 'request_mode_selected', request_id: 'req_x', mode: 'compose', reason: 'default', input_chars: 12, timestamp: now + 1 },
    { type: 'compose_preflight_parsed', request_id: 'req_x', cell_kind: 'composed', primitives: ['fs.read'], timestamp: now + 2 },
    { type: 'loop3_tool_use', turn: 1, tool_call_id: 'toolu_1', code_head: 'fs.read("missing")', code_tail: '', timestamp: now + 3 },
    { type: 'loop3_repl_shape', turn: 1, tool_call_id: 'toolu_1', primitives_called: ['fs.read'], is_micro_repl: true, is_composed: false, stmt_count: 1, timestamp: now + 4 },
    { type: 'loop3_cell_result', turn: 1, status: 'exception', duration_ms: 1, stdout_chars: 0, stderr_chars: 0, say_count: 0, timestamp: now + 5 },
    { type: 'compose_preflight_parsed', request_id: 'req_x', cell_kind: 'repair', primitives: ['fs.glob'], timestamp: now + 6 },
    // Repair preflight after exception — gate exempts the missing update.
    { type: 'compose_gate_exempt', request_id: 'req_x', reason_code: 'exempt_repair_after_exception', repl_count: 1, timestamp: now + 7 },
    { type: 'loop3_tool_use', turn: 2, tool_call_id: 'toolu_2', code_head: 'fs.glob("*.md")', code_tail: '', timestamp: now + 8 },
    { type: 'loop3_repl_shape', turn: 2, tool_call_id: 'toolu_2', primitives_called: ['fs.glob'], is_micro_repl: true, is_composed: false, stmt_count: 1, timestamp: now + 9 },
    { type: 'loop3_cell_result', turn: 2, status: 'ok', duration_ms: 1, stdout_chars: 0, stderr_chars: 0, say_count: 0, timestamp: now + 10 },
    { type: 'request_completed', request_id: 'req_x', mode: 'compose', terminated_via: 'natural', repl_count: 2, preflights_parsed: 2, timestamp: now + 11 },
  ].map(e => JSON.stringify(e)).join('\n');

  const m = parseAries(log, '', Number.MAX_SAFE_INTEGER);
  assert.equal(m.compose?.closure.composeOrGoalRequests, 1);
  assert.equal(m.compose?.closure.commitsCount, 0, 'repair-after-exception must not count as commit');
  assert.equal(m.compose?.closure.donesCount, 0);
  assert.equal(m.compose?.closure.commitRatePct, 0);
  assert.equal(m.compose?.closure.doneRatePct, 0);
}

// ── Case 5: multiple compose requests, partial closure ─────────────────────
// Three compose requests. One commits via preflight+done, one closes via
// exempt_commit_only without done(), one fails to close at all. Tests the
// rate calc is per-request not per-session.
{
  const now = Date.now();
  const log = [
    { type: 'meta', model: 'test', vault: null, cwd: '.', agentName: 'Aries', timestamp: now },
    // Request 1: commit preflight + done
    { type: 'request_mode_selected', request_id: 'req_1', mode: 'compose', timestamp: now + 1 },
    { type: 'compose_preflight_parsed', request_id: 'req_1', cell_kind: 'commit', timestamp: now + 2 },
    { type: 'loop3_done_committed', turn: 1, value: 'a', timestamp: now + 3 },
    { type: 'request_completed', request_id: 'req_1', mode: 'compose', terminated_via: 'done', repl_count: 1, timestamp: now + 4 },
    // Request 2: exempt_commit_only without done
    { type: 'request_mode_selected', request_id: 'req_2', mode: 'compose', timestamp: now + 5 },
    { type: 'compose_preflight_parsed', request_id: 'req_2', cell_kind: 'scout', timestamp: now + 6 },
    { type: 'compose_gate_exempt', request_id: 'req_2', reason_code: 'exempt_commit_only', cell_code_chars: 8, timestamp: now + 7 },
    { type: 'request_completed', request_id: 'req_2', mode: 'compose', terminated_via: 'natural', repl_count: 1, timestamp: now + 8 },
    // Request 3: no closure signal at all
    { type: 'request_mode_selected', request_id: 'req_3', mode: 'compose', timestamp: now + 9 },
    { type: 'compose_preflight_parsed', request_id: 'req_3', cell_kind: 'scout', timestamp: now + 10 },
    { type: 'request_completed', request_id: 'req_3', mode: 'compose', terminated_via: 'max_turns', repl_count: 1, timestamp: now + 11 },
  ].map(e => JSON.stringify(e)).join('\n');

  const m = parseAries(log, '', Number.MAX_SAFE_INTEGER);
  assert.equal(m.compose?.closure.composeOrGoalRequests, 3);
  assert.equal(m.compose?.closure.commitsCount, 2, 'req_1 (commit preflight) + req_2 (exempt) = 2');
  assert.equal(m.compose?.closure.donesCount, 1, 'only req_1 had structured done');
  assert.equal(m.compose?.closure.commitRatePct, 67);
  assert.equal(m.compose?.closure.doneRatePct, 33);
}

// ── Case 6: done() outside an active request scope is ignored ──────────────
// Defensive: if a stray loop3_done_committed event lands between requests,
// it must not be attributed to anything.
{
  const now = Date.now();
  const log = [
    { type: 'meta', model: 'test', vault: null, cwd: '.', agentName: 'Aries', timestamp: now },
    { type: 'loop3_done_committed', turn: 0, value: 'orphan', timestamp: now + 1 },
    { type: 'request_mode_selected', request_id: 'req_q', mode: 'quick', timestamp: now + 2 },
    { type: 'loop3_done_committed', turn: 1, value: 'q', timestamp: now + 3 },
    { type: 'request_completed', request_id: 'req_q', mode: 'quick', terminated_via: 'done', repl_count: 1, timestamp: now + 4 },
  ].map(e => JSON.stringify(e)).join('\n');

  const m = parseAries(log, '', Number.MAX_SAFE_INTEGER);
  // Only the quick request was selected. No compose-or-goal denominator.
  assert.equal(m.compose?.closure.composeOrGoalRequests, 0);
  assert.equal(m.compose?.closure.donesCount, 0);
  assert.equal(m.compose?.closure.commitsCount, 0);
}

console.log('compose bench parser smoke ok');

/**
 * SWE-Bench-Lite SUMMARY.md generator.
 *
 * Walks bench/swe-lite/results/*.json, groups by instance_id × cli, and
 * writes a SUMMARY.md to bench/swe-lite/results/. The column structure
 * mirrors bench/2026-04/runner/run.ts plus SWE-Bench-specific signals:
 * pass rate (FAIL_TO_PASS), diff lines, per-task token ratio (aries vs
 * Claude Code) — the load-bearing efficiency comparison.
 *
 * Usage:
 *   npx tsx bench/swe-lite/summarize.ts
 *
 * Idempotent — re-run any time. Reads only existing results JSON, never
 * spawns the agent or runs pytest. Old result files (pre-2026-05-08, no
 * `metrics` field) are tolerated: their telemetry columns render as `—`
 * but pass-rate and wall-time still aggregate.
 *
 * Result shape ASSUMED (from the upgraded run.ts):
 *   { instance_id, repo, cli, model, success,
 *     agent: { exitCode, wallMs, stdoutBytes, stderrTail, ariesSessionId? },
 *     fail_to_pass: { total, selectable, passed, failed[], errored[] },
 *     pass_to_pass: { ... },
 *     metrics?: Metrics  // present on post-upgrade runs only
 *   }
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Metrics } from '../2026-04/runner/parsers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');

type CliName = 'aries-cli' | 'claude-code' | 'pi-coding-agent';

interface SweResult {
  instance_id: string;
  repo: string;
  cli: CliName;
  model?: string;
  success: boolean;
  agent?: {
    exitCode?: number | null;
    wallMs?: number;
    stdoutBytes?: number;
    stderrTail?: string;
    ariesSessionId?: string;
  };
  diff_stat?: string;
  fail_to_pass?: {
    total: number;
    selectable: number;
    passed: number;
    failed: string[];
    errored: string[];
  };
  pass_to_pass?: {
    total: number;
    selectable: number;
    passed: number;
    failed: string[];
    errored: string[];
  };
  metrics?: Omit<Metrics, 'transcript'>;
  timestamp?: string;
}

function loadResults(): SweResult[] {
  if (!existsSync(RESULTS_DIR)) return [];
  const out: SweResult[] = [];
  for (const f of readdirSync(RESULTS_DIR)) {
    if (!f.endsWith('.json')) continue;
    if (f.endsWith('.transcript.jsonl') || f.endsWith('.session.jsonl')) continue;
    try {
      const r = JSON.parse(readFileSync(join(RESULTS_DIR, f), 'utf-8')) as SweResult;
      if (r.instance_id && r.cli) out.push(r);
    } catch {
      // skip malformed
    }
  }
  return out;
}

function diffLines(diffStat: string | undefined): number {
  // diff --stat output ends with a line like:
  //   "  3 files changed, 17 insertions(+), 4 deletions(-)"
  // We extract insertions+deletions as a single "lines touched" number.
  if (!diffStat) return 0;
  const ins = diffStat.match(/(\d+) insertion/);
  const del = diffStat.match(/(\d+) deletion/);
  return Number(ins?.[1] ?? 0) + Number(del?.[1] ?? 0);
}

function pct(num: number, denom: number, fallback = '—'): string {
  if (denom <= 0) return fallback;
  return `${Math.round((num / denom) * 100)}%`;
}

function fmtTokens(n: number): string {
  if (n === 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function summarize(): string {
  const results = loadResults();
  if (results.length === 0) {
    return '# bench / swe-lite — no results found\n\nRun some tasks first:\n```\nnpx tsx bench/swe-lite/run.ts --task <id> --cli aries-cli\n```\n';
  }

  // Group by task → cli
  const byTask = new Map<string, Map<CliName, SweResult>>();
  for (const r of results) {
    if (!byTask.has(r.instance_id)) byTask.set(r.instance_id, new Map());
    byTask.get(r.instance_id)!.set(r.cli, r);
  }
  const taskIds = [...byTask.keys()].sort();
  const clis: CliName[] = ['aries-cli', 'claude-code', 'pi-coding-agent'];

  let md = '# bench / swe-lite — run summary\n\n';
  md += `Generated: ${new Date().toISOString()}\n`;
  md += `Source: \`bench/swe-lite/results/*.json\` (${results.length} files, ${taskIds.length} tasks × ${clis.length} CLIs)\n\n`;

  // ── Per-task matrix ─────────────────────────────────────────────────
  md += `## Matrix\n\n`;
  md += `Per cell: success / total tokens / tool calls / [compose: cells/composed/preflight cov/gates/commits/dones] / wall / FTP / diff lines.\n\n`;
  md += `| task | aries-cli | claude-code | pi-coding-agent | aries token ratio vs CC |\n`;
  md += `|---|---|---|---|---|\n`;

  for (const taskId of taskIds) {
    const cells = clis.map((cli) => formatMatrixCell(byTask.get(taskId)?.get(cli)));
    const aries = byTask.get(taskId)?.get('aries-cli');
    const cc = byTask.get(taskId)?.get('claude-code');
    const aTok = aries?.metrics?.tokens.total ?? 0;
    const cTok = cc?.metrics?.tokens.total ?? 0;
    let ratio = '—';
    if (aTok > 0 && cTok > 0) {
      const r = cTok / aTok;
      ratio = r >= 1 ? `${r.toFixed(1)}× cheaper` : `${(1 / r).toFixed(1)}× more`;
    }
    md += `| ${taskId} | ${cells[0]} | ${cells[1]} | ${cells[2]} | ${ratio} |\n`;
  }

  md += `\nLegend: ✓/✗ pass / total tokens / tool calls / [c=cells, cmp=composed, pf=preflight coverage, g=gate rejections, k=commits, d=dones] / wallSec / FTP=FAIL_TO_PASS passed/total / diff lines touched.\n\n`;

  // ── Per-CLI aggregates ──────────────────────────────────────────────
  md += `## Per-CLI aggregates\n\n`;
  md += `| cli | pass rate | mean tokens | mean tools | loop3 cell comp | loop3 state reuse | loop3 useful ops/cell | compose reqs | preflight cov | gates | closure (commit/done) | mean wall | mean diff lines |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;

  for (const cli of clis) {
    const rs = results.filter((r) => r.cli === cli);
    if (rs.length === 0) continue;
    const passed = rs.filter((r) => r.success).length;
    // Only average over runs that actually carry token telemetry. A CLI
    // with 4 pre-upgrade runs (no metrics) should show "—" not "0", since
    // dividing-by-all-runs-including-untelemetered would understate the
    // true mean. Same logic for tools.
    const tokRuns = rs.filter((r) => r.metrics?.tokens.total != null && r.metrics.tokens.total > 0);
    const meanTokens = tokRuns.length > 0
      ? tokRuns.reduce((a, r) => a + (r.metrics?.tokens.total ?? 0), 0) / tokRuns.length
      : null;
    const toolRuns = rs.filter((r) => r.metrics?.toolCalls.total != null);
    const meanTools = toolRuns.length > 0
      ? toolRuns.reduce((a, r) => a + (r.metrics?.toolCalls.total ?? 0), 0) / toolRuns.length
      : null;
    const loop3Runs = rs.filter((r) => r.metrics?.loop3);
    const l3Composed = loop3Runs.reduce((a, r) => a + (r.metrics?.loop3?.composedCells ?? 0), 0);
    const l3Shape = loop3Runs.reduce((a, r) => a + (r.metrics?.loop3?.shapeRecords ?? 0), 0);
    const l3CompDensity = pct(l3Composed, l3Shape);
    const l3Reuse = loop3Runs.reduce((a, r) => a + (r.metrics?.loop3?.crossCellStateReuseCells ?? 0), 0);
    const l3Available = loop3Runs.reduce((a, r) => a + (r.metrics?.loop3?.cellsWithPriorStateAvailable ?? 0), 0);
    const l3ReuseDensity = pct(l3Reuse, l3Available);
    const l3Cells = loop3Runs.reduce((a, r) => a + (r.metrics?.loop3?.cells ?? 0), 0);
    const l3UsefulOps = loop3Runs.reduce((a, r) => a + (r.metrics?.loop3?.usefulOperations ?? 0), 0);
    const l3UsefulPerCell = l3Cells > 0 ? (l3UsefulOps / l3Cells).toFixed(2) : '—';
    const composeRuns = rs.filter((r) => r.metrics?.compose);
    const composeReqs = composeRuns.reduce((a, r) => a + (r.metrics?.compose?.requests.total ?? 0), 0);
    const composeCells = composeRuns.reduce((a, r) => a + (r.metrics?.compose?.cells.total ?? 0), 0);
    const composeGates = composeRuns.reduce((a, r) => a + (r.metrics?.compose?.gateRejections.total ?? 0), 0);
    const composePreflights = composeRuns.reduce((a, r) => a + (r.metrics?.compose?.preflights.parsed ?? 0), 0);
    const coverage = pct(composePreflights, composeCells + composeGates);
    const composeOrGoal = composeRuns.reduce((a, r) => a + (r.metrics?.compose?.closure.composeOrGoalRequests ?? 0), 0);
    const commits = composeRuns.reduce((a, r) => a + (r.metrics?.compose?.closure.commitsCount ?? 0), 0);
    const dones = composeRuns.reduce((a, r) => a + (r.metrics?.compose?.closure.donesCount ?? 0), 0);
    const closure = composeOrGoal > 0
      ? `${pct(commits, composeOrGoal)}commit(${commits}/${composeOrGoal})/${pct(dones, composeOrGoal)}done(${dones}/${composeOrGoal})`
      : '—';
    const meanWall = rs.reduce((a, r) => a + (r.agent?.wallMs ?? 0), 0) / rs.length / 1000;
    const meanDiff = rs.reduce((a, r) => a + diffLines(r.diff_stat), 0) / rs.length;
    const tokStr = meanTokens != null ? fmtTokens(meanTokens) : '—';
    const toolStr = meanTools != null ? meanTools.toFixed(1) : '—';
    md += `| ${cli} | ${passed}/${rs.length} | ${tokStr} | ${toolStr} | ${l3CompDensity} | ${l3ReuseDensity} | ${l3UsefulPerCell} | ${composeRuns.length > 0 ? composeReqs : '—'} | ${composeRuns.length > 0 ? coverage : '—'} | ${composeRuns.length > 0 ? composeGates : '—'} | ${closure} | ${meanWall.toFixed(1)}s | ${meanDiff.toFixed(1)} |\n`;
  }

  // ── Token efficiency headline ──────────────────────────────────────
  // The load-bearing comparison: across all (task, cli) pairs where BOTH
  // aries-cli AND claude-code ran the same task successfully, what's the
  // mean token ratio? This is the codemode-vs-traditional efficiency claim.
  const headPairs: { task: string; aries: number; cc: number }[] = [];
  for (const taskId of taskIds) {
    const a = byTask.get(taskId)?.get('aries-cli');
    const c = byTask.get(taskId)?.get('claude-code');
    if (!a || !c) continue;
    const aTok = a.metrics?.tokens.total ?? 0;
    const cTok = c.metrics?.tokens.total ?? 0;
    if (aTok > 0 && cTok > 0) headPairs.push({ task: taskId, aries: aTok, cc: cTok });
  }
  if (headPairs.length > 0) {
    md += `\n## Token efficiency: aries-cli vs claude-code\n\n`;
    md += `Tasks where both CLIs ran with token telemetry: ${headPairs.length}\n\n`;
    const totalA = headPairs.reduce((s, p) => s + p.aries, 0);
    const totalC = headPairs.reduce((s, p) => s + p.cc, 0);
    md += `- Total aries tokens: ${fmtTokens(totalA)}\n`;
    md += `- Total claude-code tokens: ${fmtTokens(totalC)}\n`;
    md += `- Aggregate ratio: **${(totalC / totalA).toFixed(2)}× cheaper** (aries uses ${pct(totalA, totalC)} of CC tokens)\n`;
    const ratios = headPairs.map((p) => p.cc / p.aries).sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)] ?? 0;
    md += `- Per-task median ratio: ${median.toFixed(2)}×\n`;
    md += `- Min/max: ${ratios[0]?.toFixed(2)}× / ${ratios[ratios.length - 1]?.toFixed(2)}×\n`;
  }

  // ── Failure attribution (if any) ────────────────────────────────────
  const failures = results.filter((r) => !r.success);
  if (failures.length > 0) {
    md += `\n## Failures\n\n`;
    md += `| task | cli | exit | FTP failed | FTP errored | wall |\n`;
    md += `|---|---|---|---|---|---|\n`;
    for (const f of failures) {
      const ftpFailed = (f.fail_to_pass?.failed ?? []).length;
      const ftpErrored = (f.fail_to_pass?.errored ?? []).length;
      const wall = ((f.agent?.wallMs ?? 0) / 1000).toFixed(0);
      md += `| ${f.instance_id} | ${f.cli} | ${f.agent?.exitCode ?? '?'} | ${ftpFailed} | ${ftpErrored} | ${wall}s |\n`;
    }
  }

  return md;
}

function formatMatrixCell(r: SweResult | undefined): string {
  if (!r) return '—';
  const mark = r.success ? '✓' : '✗';
  const tokens = r.metrics?.tokens.total;
  const tools = r.metrics?.toolCalls.total;
  const wall = ((r.agent?.wallMs ?? 0) / 1000).toFixed(0);
  // FTP display: prefer selectable (post-upgrade) but fall back to total
  // (pre-upgrade results that don't carry selectable). When neither is
  // present we render only the passed count.
  const ftpDenom = r.fail_to_pass?.selectable ?? r.fail_to_pass?.total;
  const ftp = r.fail_to_pass
    ? (ftpDenom != null ? `${r.fail_to_pass.passed}/${ftpDenom}` : `${r.fail_to_pass.passed}`)
    : '—';
  const diff = diffLines(r.diff_stat);
  // Compose suffix only when present (aries with compose-loop). For other
  // CLIs and pre-upgrade aries runs the block is absent.
  const c = r.metrics?.compose;
  const composeBlock = c
    ? `/${c.cells.total}c/${r.metrics?.loop3?.composedCells ?? 0}cmp/${c.preflights.coveragePct}%pf/${c.gateRejections.total}g/${c.closure.commitsCount}k/${c.closure.donesCount}d`
    : '';
  const tokStr = tokens != null && tokens > 0 ? fmtTokens(tokens) : '—';
  const toolStr = tools != null && tools >= 0 ? String(tools) : '—';
  return `${mark} ${tokStr}/${toolStr}${composeBlock}/${wall}s/FTP${ftp}/${diff}L`;
}

function main(): void {
  const md = summarize();
  const outPath = join(RESULTS_DIR, 'SUMMARY.md');
  writeFileSync(outPath, md, 'utf-8');
  console.log(`Wrote ${outPath} (${md.length} chars)`);
}

main();

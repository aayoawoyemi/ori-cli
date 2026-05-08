/**
 * Re-generate SUMMARY.md for a given run directory by loading all .json results.
 * Usage: npx tsx bench/2026-04/runner/resummarize.ts <runDir>
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TASKS } from './tasks.js';
import { parseAries, type Metrics } from './parsers.js';

type CliName = 'aries-cli' | 'claude-code' | 'pi-coding-agent';

interface RunResult {
  taskId: string;
  cli: CliName;
  model: string;
  startedAt: string;
  wallMs: number;
  metrics: {
    tokens: { input: number; cached: number; output: number; total: number };
    toolCalls: { total: number; byTool: Record<string, number> };
    loop2?: { turns: number; batches: number; cells: number; thinkingEvents: number; turnPredicates: number; cellsByStatus: { ok: number; exception: number; rejected: number; timeout: number } };
    loop3?: Metrics['loop3'];
    finalAnswer: string;
    transcript: string;
    observedModel?: string;
  };
  success: boolean;
  successDetails: { missing: string[]; reasons: string[] };
  notes: string;
  exitCode: number | null;
}

function loadAllResults(runDir: string): RunResult[] {
  const results: RunResult[] = [];
  const files = readdirSync(runDir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    try {
      const raw = readFileSync(join(runDir, file), 'utf-8');
      const parsed = JSON.parse(raw) as RunResult;
      if (parsed.taskId && parsed.cli) {
        if (parsed.cli === 'aries-cli') {
          const transcriptPath = join(runDir, `${parsed.taskId}-${parsed.cli}.transcript.txt`);
          const transcript = existsSync(transcriptPath)
            ? readFileSync(transcriptPath, 'utf-8')
            : parsed.metrics.transcript;
          if (transcript?.trim()) {
            parsed.metrics = parseAries(transcript, '', Number.MAX_SAFE_INTEGER);
            parsed.model = parsed.metrics.observedModel ?? parsed.model;
            writeFileSync(join(runDir, file), JSON.stringify(parsed, null, 2), 'utf-8');
          }
        }
        results.push(parsed);
      }
    } catch {
      // Skip malformed
    }
  }
  return results;
}

function summarize(runDir: string): void {
  const allResults = loadAllResults(runDir);
  if (allResults.length === 0) {
    console.error(`No .json result files found in ${runDir}`);
    process.exit(1);
  }

  const byTask: Record<string, RunResult[]> = {};
  for (const r of allResults) {
    (byTask[r.taskId] ??= []).push(r);
  }

  // Deduplicate: keep latest startedAt for each taskId+cli pair
  for (const taskId of Object.keys(byTask)) {
    const seen = new Map<string, RunResult>();
    for (const r of byTask[taskId]) {
      const key = r.cli;
      const existing = seen.get(key);
      if (!existing || r.startedAt > existing.startedAt) {
        seen.set(key, r);
      }
    }
    byTask[taskId] = [...seen.values()];
  }

  const models = [...new Set(allResults.map((r) => r.model))].join(', ');
  const dates = [...new Set(allResults.map((r) => r.startedAt.slice(0, 10)))].sort();

  let md = '# bench / 2026-04 — run summary\n\n';
  md += `Date: ${dates.join(', ')}\n`;
  md += `Model: ${models}\n\n`;
  md += `## Matrix\n\n`;
  md += `| task | aries-cli | claude-code | pi-coding-agent |\n`;
  md += `|---|---|---|---|\n`;

  // Build task list: known TASKS first, then extras from disk
  const knownIds = new Set(TASKS.map((t) => t.id));
  const extraIds = Object.keys(byTask).filter((id) => !knownIds.has(id)).sort();
  const allTaskIds = [...TASKS.map((t) => t.id), ...extraIds];

  for (const taskId of allTaskIds) {
    const cells = (['aries-cli', 'claude-code', 'pi-coding-agent'] as CliName[]).map((cli) => {
      const r = byTask[taskId]?.find((x) => x.cli === cli);
      if (!r) return '\u2014';
      const s = r.success ? '\u2713' : '\u2717';
      const loop2Cells = r.metrics.loop2?.cells;
      const loop2Thinking = r.metrics.loop2?.thinkingEvents;
      const loop3 = r.metrics.loop3;
      const compose = r.metrics.compose;
      const cellSuffix = loop2Cells !== undefined
        ? `/${loop2Cells}c${loop2Thinking !== undefined ? `/${loop2Thinking}t` : ''}`
        : loop3
          ? `/${loop3.cells}c/${loop3.composedCells}cmp/${loop3.pureProbes}probe${compose ? `/${compose.preflights.coveragePct}%pf/${compose.gateRejections.total}gate` : ''}`
          : '';
      return `${s} ${r.metrics.tokens.total}/${r.metrics.toolCalls.total}${cellSuffix}/${(r.wallMs / 1000).toFixed(0)}s`;
    });
    md += `| ${taskId} | ${cells[0]} | ${cells[1]} | ${cells[2]} |\n`;
  }
  md += `\nLegend: success / total tokens / execution batches-or-tool calls [/ Loop2 cells / Loop2 thinking events OR Loop3 cells / composed cells / inferred probe cells / preflight coverage / gate rejections] / wall seconds\n`;
  md += `Compose aggregates: reqs = total (quick/compose/goal), gates = total (preflight_required/update_required/scout_budget_exceeded), scout/verify/repair = parsed preflight cell kinds, micro by mode = quick/compose/goal/unknown.\n\n`;

  // Per-CLI aggregates
  md += `## Per-CLI aggregates\n\n`;
  md += `| cli | success rate | mean tokens | mean tool calls/batches | mean Loop2 cells | mean Loop2 thinking events | Loop3 cell comp | Loop3 state reuse | Loop3 probes/run | Loop3 useful ops/cell | Loop3 done path | compose reqs | preflight cov | gates | scout/verify/repair | micro by mode | Loop3 active/idle | mean wall |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const cli of ['aries-cli', 'claude-code', 'pi-coding-agent'] as CliName[]) {
    const rs = allResults.filter((r) => r.cli === cli);
    if (rs.length === 0) continue;
    const successCount = rs.filter((r) => r.success).length;
    const meanTokens = rs.reduce((a, r) => a + r.metrics.tokens.total, 0) / rs.length;
    const meanTools = rs.reduce((a, r) => a + r.metrics.toolCalls.total, 0) / rs.length;
    const loop2Runs = rs.filter((r) => r.metrics.loop2);
    const meanLoop2Cells = loop2Runs.length > 0
      ? loop2Runs.reduce((a, r) => a + (r.metrics.loop2?.cells ?? 0), 0) / loop2Runs.length
      : 0;
    const meanLoop2Thinking = loop2Runs.length > 0
      ? loop2Runs.reduce((a, r) => a + (r.metrics.loop2?.thinkingEvents ?? 0), 0) / loop2Runs.length
      : 0;
    const loop3Runs = rs.filter((r) => r.metrics.loop3);
    const loop3ShapeRecords = loop3Runs.reduce((a, r) => a + (r.metrics.loop3?.shapeRecords ?? 0), 0);
    const loop3Composed = loop3Runs.reduce((a, r) => a + (r.metrics.loop3?.composedCells ?? 0), 0);
    const loop3Cells = loop3Runs.reduce((a, r) => a + (r.metrics.loop3?.cells ?? 0), 0);
    const loop3UsefulOps = loop3Runs.reduce((a, r) => a + (r.metrics.loop3?.usefulOperations ?? 0), 0);
    const meanLoop3Probes = loop3Runs.length > 0
      ? loop3Runs.reduce((a, r) => a + (r.metrics.loop3?.pureProbes ?? 0), 0) / loop3Runs.length
      : 0;
    const loop3StructuredDone = loop3Runs.filter((r) => r.metrics.loop3?.structuredDone).length;
    const loop3StateReuseCells = loop3Runs.reduce((a, r) => a + (r.metrics.loop3?.crossCellStateReuseCells ?? 0), 0);
    const loop3StateAvailableCells = loop3Runs.reduce((a, r) => a + (r.metrics.loop3?.cellsWithPriorStateAvailable ?? 0), 0);
    const loop3StateReuseDensity = loop3StateAvailableCells > 0 ? `${Math.round((loop3StateReuseCells / loop3StateAvailableCells) * 100)}%` : '-';
    const loop3CompDensity = loop3ShapeRecords > 0 ? `${Math.round((loop3Composed / loop3ShapeRecords) * 100)}%` : '---';
    const loop3UsefulPerCell = loop3Cells > 0 ? (loop3UsefulOps / loop3Cells).toFixed(2) : '---';
    const loop3DonePath = loop3Runs.length > 0 ? `${loop3StructuredDone}/${loop3Runs.length}` : '---';
    const composeRuns = rs.filter((r) => r.metrics.compose);
    const composeReqs = composeRuns.reduce((a, r) => a + (r.metrics.compose?.requests.total ?? 0), 0);
    const composeQuick = composeRuns.reduce((a, r) => a + (r.metrics.compose?.requests.quick ?? 0), 0);
    const composeModeReqs = composeRuns.reduce((a, r) => a + (r.metrics.compose?.requests.compose ?? 0), 0);
    const composeGoal = composeRuns.reduce((a, r) => a + (r.metrics.compose?.requests.goal ?? 0), 0);
    const composeCells = composeRuns.reduce((a, r) => a + (r.metrics.compose?.cells.total ?? 0), 0);
    const composeGates = composeRuns.reduce((a, r) => a + (r.metrics.compose?.gateRejections.total ?? 0), 0);
    const composePreflights = composeRuns.reduce((a, r) => a + (r.metrics.compose?.preflights.parsed ?? 0), 0);
    const composeCoverageDenom = composeCells + composeGates;
    const composeCoverage = composeCoverageDenom > 0 ? `${Math.round((composePreflights / composeCoverageDenom) * 100)}%` : '---';
    const composeGateBreakdown = composeRuns.length > 0
      ? `${composeGates} (${composeRuns.reduce((a, r) => a + (r.metrics.compose?.gateRejections.preflightRequired ?? 0), 0)}pf/${composeRuns.reduce((a, r) => a + (r.metrics.compose?.gateRejections.updateRequired ?? 0), 0)}upd/${composeRuns.reduce((a, r) => a + (r.metrics.compose?.gateRejections.scoutBudgetExceeded ?? 0), 0)}scout)`
      : '---';
    const composeKinds = composeRuns.length > 0
      ? `${composeRuns.reduce((a, r) => a + (r.metrics.compose?.preflights.scout ?? 0), 0)}/${composeRuns.reduce((a, r) => a + (r.metrics.compose?.preflights.verify ?? 0), 0)}/${composeRuns.reduce((a, r) => a + (r.metrics.compose?.preflights.repair ?? 0), 0)}`
      : '---';
    const composeReqSummary = composeRuns.length > 0
      ? `${composeReqs} (${composeQuick}q/${composeModeReqs}c/${composeGoal}g)`
      : '---';
    const microByMode = composeRuns.length > 0
      ? `${composeRuns.reduce((a, r) => a + (r.metrics.compose?.microCellsByMode.quick ?? 0), 0)}q/${composeRuns.reduce((a, r) => a + (r.metrics.compose?.microCellsByMode.compose ?? 0), 0)}c/${composeRuns.reduce((a, r) => a + (r.metrics.compose?.microCellsByMode.goal ?? 0), 0)}g/${composeRuns.reduce((a, r) => a + (r.metrics.compose?.microCellsByMode.unknown ?? 0), 0)}?`
      : '---';
    const loop3ActiveIdle = loop3Runs.length > 0
      ? `${(loop3Runs.reduce((a, r) => a + (r.metrics.loop3?.activeElapsedMs ?? 0), 0) / 1000).toFixed(1)}s/${(loop3Runs.reduce((a, r) => a + (r.metrics.loop3?.idleMs ?? 0), 0) / 1000).toFixed(1)}s`
      : '---';
    const meanWall = rs.reduce((a, r) => a + r.wallMs, 0) / rs.length / 1000;
    md += `| ${cli} | ${successCount}/${rs.length} | ${meanTokens.toFixed(0)} | ${meanTools.toFixed(1)} | ${loop2Runs.length > 0 ? meanLoop2Cells.toFixed(1) : '\u2014'} | ${loop2Runs.length > 0 ? meanLoop2Thinking.toFixed(1) : '\u2014'} | ${loop3CompDensity} | ${loop3StateReuseDensity} | ${loop3Runs.length > 0 ? meanLoop3Probes.toFixed(1) : '\u2014'} | ${loop3UsefulPerCell} | ${loop3DonePath} | ${composeReqSummary} | ${composeCoverage} | ${composeGateBreakdown} | ${composeKinds} | ${microByMode} | ${loop3ActiveIdle} | ${meanWall.toFixed(1)}s |\n`;
  }

  writeFileSync(join(runDir, 'SUMMARY.md'), md, 'utf-8');
  const jsonFiles = readdirSync(runDir).filter((f) => f.endsWith('.json'));
  console.log(`Wrote: ${join(runDir, 'SUMMARY.md')}`);
  console.log(`  ${allResults.length} results from ${jsonFiles.length} JSON files`);
  console.log(`  Tasks: ${allTaskIds.filter((id) => byTask[id]?.length > 0).length}`);
  console.log(`  CLIs: ${[...new Set(allResults.map((r) => r.cli))].join(', ')}`);
}

const runDir = process.argv[2];
if (!runDir) {
  console.error('Usage: npx tsx bench/2026-04/runner/resummarize.ts <runDir>');
  process.exit(1);
}
summarize(runDir);

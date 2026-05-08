import type { ReplResult } from '../repl/types.js';
import type { ExtractedCell } from './codeExtractor.js';

export interface ExecutedCell {
  cell: ExtractedCell;
  stdout: string;
  stderr: string;
  exception: string | null;
  rejectedReason: string | null;
  timedOut: boolean;
  durationMs: number;
  sayTexts: string[];
  doneValue?: unknown;
}

export interface ExecutionResultEnvelope {
  xml: string;
  status: 'ok' | 'error' | 'note';
  totalDurationMs: number;
  doneValue?: unknown;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function tail(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function debugStdoutChars(): number {
  const raw = Number(process.env.ARIES_CODE_DEBUG_STDOUT_CHARS ?? '0');
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

function stripFirstTurnBanner(stdout: string): string {
  if (!stdout.startsWith('=== Aries body ready ===')) {
    return stdout;
  }
  const lines = stdout.split('\n');
  const shapesIdx = lines.findIndex((line) => line.trim() === 'Shapes:');
  const anchorIdx = shapesIdx >= 0
    ? shapesIdx
    : lines.findIndex((line) => line.startsWith('State persists across code calls.'));
  if (anchorIdx < 0) return '';
  const blankAfterBanner = lines.findIndex((line, idx) => idx > anchorIdx && line.trim() === '');
  if (blankAfterBanner < 0) return '';
  return lines.slice(blankAfterBanner + 1).join('\n');
}

export function mapReplResultToCell(cell: ExtractedCell, result: ReplResult): ExecutedCell {
  const cleanStdout = stripFirstTurnBanner(result.stdout);
  return {
    cell,
    stdout: cleanStdout,
    stderr: result.stderr,
    exception: result.exception,
    rejectedReason: result.rejected?.reason ?? null,
    timedOut: result.timed_out,
    durationMs: result.duration_ms,
    sayTexts: result.say_texts ?? [],
    doneValue: result.done?.value,
  };
}

export function formatExecutionResult(input: {
  cells: ExecutedCell[];
  notes: string[];
  forceStatus?: 'ok' | 'error' | 'note';
}): ExecutionResultEnvelope {
  const { cells, notes, forceStatus } = input;
  const stdoutDebugCap = debugStdoutChars();
  const totalDurationMs = cells.reduce((sum, cell) => sum + cell.durationMs, 0);
  const lastDone = [...cells].reverse().find((cell) => cell.doneValue !== undefined)?.doneValue;

  let status: 'ok' | 'error' | 'note' = 'ok';
  if (notes.length > 0 && cells.length === 0) status = 'note';
  for (const cell of cells) {
    if (cell.exception || cell.rejectedReason || cell.timedOut) {
      status = 'error';
      break;
    }
  }
  if (forceStatus) status = forceStatus;

  const lines: string[] = [];
  lines.push(
    `<execution_result cells="${cells.length}" status="${status}" duration_ms="${totalDurationMs}">`,
  );

  for (const note of notes) {
    lines.push(`  <note>${escapeXml(note)}</note>`);
  }

  for (const cell of cells) {
    let cellStatus = 'ok';
    if (cell.exception) cellStatus = 'exception';
    else if (cell.rejectedReason) cellStatus = 'rejected';
    else if (cell.timedOut) cellStatus = 'timeout';

    const idAttr = cell.cell.id ? ` id="${escapeXml(cell.cell.id)}"` : '';
    lines.push(
      `  <cell index="${cell.cell.index}"${idAttr} status="${cellStatus}" duration_ms="${cell.durationMs}">`,
    );

    for (const say of cell.sayTexts) {
      lines.push(`    <say>${escapeXml(say)}</say>`);
    }

    if (cell.doneValue !== undefined) {
      lines.push(`    <done>${escapeXmlText(formatUnknown(cell.doneValue))}</done>`);
    }

    if (cell.stderr.trim()) {
      lines.push(`    <stderr>${escapeXml(cell.stderr.trim())}</stderr>`);
    }
    if (cell.exception?.trim()) {
      lines.push(`    <exception>${escapeXml(cell.exception.trim())}</exception>`);
    }
    if (cell.rejectedReason?.trim()) {
      lines.push(`    <rejected>${escapeXml(cell.rejectedReason.trim())}</rejected>`);
    }
    if (cell.timedOut) {
      lines.push(`    <timeout>true</timeout>`);
    }

    if (stdoutDebugCap > 0 && cell.stdout.trim()) {
      lines.push(`    <stdout_debug>${escapeXml(tail(cell.stdout.trim(), stdoutDebugCap))}</stdout_debug>`);
    }

    lines.push('  </cell>');
  }

  lines.push('</execution_result>');

  return {
    xml: lines.join('\n'),
    status,
    totalDurationMs,
    doneValue: lastDone,
  };
}

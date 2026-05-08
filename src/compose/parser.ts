/**
 * Parser for the compose sub-loop's structured assistant text blocks.
 *
 * The model emits these blocks in its normal text stream BEFORE/AFTER Repl
 * tool calls. The harness extracts them, writes their contents into the
 * scratch markdown file, and uses them to gate the next Repl execution.
 *
 *   <compose_preflight>
 *   purpose: <one sentence>
 *   primitives: vault.top, vault.explore, fs.read
 *   inputs: <what's already in state/vars>
 *   expected_outputs: <what this cell should produce>
 *   failure_modes: <what could go wrong>
 *   persists: state.put("notes", ...) | none
 *   cell_kind: scout | composed | verify | repair | commit
 *   </compose_preflight>
 *
 *   <compose_update>
 *   findings: <what the cell actually produced>
 *   next_move: <what to do next>
 *   </compose_update>
 *
 * Parser is INTENTIONALLY LENIENT:
 *   - Missing fields → block accepted, missing fields are undefined.
 *   - Unknown fields → ignored (with a warning logged).
 *   - Malformed XML → block ignored entirely (no field extraction).
 *   - Multiple blocks of the same type → last one wins (the most recent
 *     preflight/update is what the gate evaluates against).
 *
 * The strictness lives in the gate, not the parser. The gate refuses to
 * run a Repl when needsPreflight && !lastPreflight, which is the point
 * where lenient parsing meets structural enforcement.
 */

export type CellKind = 'scout' | 'composed' | 'verify' | 'repair' | 'commit' | string;

export interface ParsedPreflight {
  purpose?: string;
  primitives?: string[];
  inputs?: string;
  expected_outputs?: string;
  failure_modes?: string;
  persists?: string;
  cell_kind?: CellKind;
  /** Raw text of the preflight body (for archival into scratch). */
  raw: string;
}

export interface ParsedUpdate {
  findings?: string;
  next_move?: string;
  raw: string;
}

export interface ParseResult {
  /** Most recent preflight block in the text, or null. */
  preflight: ParsedPreflight | null;
  /** Most recent update block in the text, or null. */
  update: ParsedUpdate | null;
  /** Warnings logged during parsing — unknown fields, malformed structure. */
  warnings: string[];
}

const PREFLIGHT_RE = /<compose_preflight>([\s\S]*?)<\/compose_preflight>/gi;
const UPDATE_RE = /<compose_update>([\s\S]*?)<\/compose_update>/gi;

const PREFLIGHT_FIELDS = new Set([
  'purpose', 'primitives', 'inputs', 'expected_outputs',
  'failure_modes', 'persists', 'cell_kind',
]);

const UPDATE_FIELDS = new Set(['findings', 'next_move']);

/**
 * Parse compose blocks out of accumulated assistant text.
 *
 * Idempotent and pure — no side effects. Same input always produces same
 * output. The agent calls this on the assistant_message event boundary
 * with the full accumulated text from that turn.
 */
export function parseComposeBlocks(text: string): ParseResult {
  const warnings: string[] = [];
  const preflightMatches = Array.from(text.matchAll(PREFLIGHT_RE));
  const updateMatches = Array.from(text.matchAll(UPDATE_RE));

  const preflight = preflightMatches.length > 0
    ? parsePreflightBody(preflightMatches[preflightMatches.length - 1]![1] ?? '', warnings)
    : null;
  const update = updateMatches.length > 0
    ? parseUpdateBody(updateMatches[updateMatches.length - 1]![1] ?? '', warnings)
    : null;

  return { preflight, update, warnings };
}

/**
 * Parse a key:value body (one field per line, blank lines OK).
 * Continuation lines (indented or starting with -) extend the prior field.
 */
function parseKeyValueBody(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = body.split(/\r?\n/);
  let currentKey: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (currentKey !== null) {
      fields.set(currentKey, buffer.join('\n').trim());
    }
    currentKey = null;
    buffer = [];
  };
  for (const line of lines) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (m && (line[0] && !/\s/.test(line[0]))) {
      flush();
      currentKey = m[1]!.toLowerCase();
      buffer = [m[2] ?? ''];
    } else if (currentKey !== null) {
      buffer.push(line.trim());
    }
    // lines outside any field (header text, empty lines before first field)
    // are silently ignored.
  }
  flush();
  return fields;
}

function parsePreflightBody(body: string, warnings: string[]): ParsedPreflight {
  const fields = parseKeyValueBody(body);
  const out: ParsedPreflight = { raw: body.trim() };

  for (const [k, v] of fields) {
    if (!PREFLIGHT_FIELDS.has(k)) {
      warnings.push(`compose_preflight: unknown field '${k}'`);
      continue;
    }
    if (k === 'primitives') {
      // Comma- or whitespace-separated list of primitive names.
      out.primitives = v.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    } else if (k === 'cell_kind') {
      out.cell_kind = v.trim().toLowerCase() as CellKind;
    } else {
      (out as any)[k] = v;
    }
  }
  return out;
}

function parseUpdateBody(body: string, warnings: string[]): ParsedUpdate {
  const fields = parseKeyValueBody(body);
  const out: ParsedUpdate = { raw: body.trim() };
  for (const [k, v] of fields) {
    if (!UPDATE_FIELDS.has(k)) {
      warnings.push(`compose_update: unknown field '${k}'`);
      continue;
    }
    (out as any)[k] = v;
  }
  return out;
}

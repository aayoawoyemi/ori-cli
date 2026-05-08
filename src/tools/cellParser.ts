/**
 * Markdown cell parser for the Repl tool.
 *
 * Parses Pi-style fenced code cells from a single string input. Each cell
 * is a markdown fenced code block. The opening fence's info string carries
 * metadata: language (optional), positional duration (optional), and
 * attributes (key=value pairs).
 *
 * Examples:
 *   ```py id="step1" t="15s" rst=true
 *   import json
 *   data = json.loads(read('package.json'))
 *   ```
 *
 *   ```py
 *   display(data)
 *   ```
 *
 *   ```python id="quick" 5s
 *   x = 1 + 1
 *   ```
 *
 * Grammar (info string after opening ```):
 *   <lang>? <duration>? (title-fragment | key=value)*
 *
 * Languages supported (v1): py, python. (js/javascript deferred to a future
 * batch — coupled with body-side JS kernel work.)
 *
 * Positional duration: `15s`, `500ms`, `2m`, or a bare integer (seconds).
 * Default 30s. The `t=<duration>` attribute overrides.
 *
 * Attributes:
 *   id="..."   cell label, shown in trace
 *   t=<dur>    timeout override
 *   rst=true   wipe kernel before running this cell
 *
 * Anything that doesn't match (lang | duration | key=value) is treated as
 * a title fragment and joined into the id if no explicit id is given. This
 * is the Pi convention — `\`\`\`py extract config` produces id "extract config".
 *
 * Text outside fenced blocks is ignored — the model can write a preface
 * explaining intent. Malformed cells (unclosed fence, bad metadata) return
 * a teaching error rather than executing.
 */

export interface ParsedCell {
  /** 1-indexed position in the input (cells are numbered starting at 1). */
  index: number;
  /** Cell label from `id="..."` or title fragments. May be undefined. */
  id?: string;
  /** Language id; only "py"/"python" supported in v1. */
  language: 'py' | 'python';
  /** Cell body — Python code, no fence markers, no leading/trailing newline. */
  code: string;
  /** Timeout in milliseconds; undefined means use default (30000). */
  timeoutMs?: number;
  /** True if `rst=true` set — wipe kernel before this cell's exec. */
  reset: boolean;
  /** 1-indexed line where the opening fence starts (for error reporting). */
  startLine: number;
}

export interface CellParseResult {
  cells: ParsedCell[];
  /** Teaching error if the input was malformed. cells may still be partially populated. */
  error?: string;
}

const SUPPORTED_LANGS = new Set(['py', 'python']);
const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/;

function parseDuration(token: string): number | undefined {
  const m = token.trim().match(DURATION_RE);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const unit = m[2] ?? 's';
  switch (unit) {
    case 'ms':
      return Math.round(n);
    case 's':
      return Math.round(n * 1000);
    case 'm':
      return Math.round(n * 60_000);
    default:
      return undefined;
  }
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * Tokenize a fence info string into fragments. Honors quoted values so
 * `id="hello world"` produces a single token `id=hello world`.
 */
function tokenizeFenceInfo(info: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < info.length) {
    while (i < info.length && /\s/.test(info[i])) i++;
    if (i >= info.length) break;

    // Try to read a key=value with potentially quoted value
    const remainder = info.slice(i);
    const kvMatch = remainder.match(/^([A-Za-z_][\w-]*)=(?:"([^"]*)"|'([^']*)'|(\S*))/);
    if (kvMatch) {
      const key = kvMatch[1];
      const value = kvMatch[2] ?? kvMatch[3] ?? kvMatch[4] ?? '';
      tokens.push(`${key}=${value}`);
      i += kvMatch[0].length;
      continue;
    }

    // Otherwise read a single bareword
    let j = i;
    while (j < info.length && !/\s/.test(info[j])) j++;
    const tok = info.slice(i, j);
    if (tok) tokens.push(tok);
    i = j;
  }
  return tokens;
}

interface ParsedFenceMeta {
  language?: 'py' | 'python';
  timeoutMs?: number;
  id?: string;
  reset: boolean;
  unrecognized: string[];
}

function parseFenceMeta(info: string): ParsedFenceMeta {
  const tokens = tokenizeFenceInfo(info);
  const meta: ParsedFenceMeta = { reset: false, unrecognized: [] };
  const titleFragments: string[] = [];

  for (const tok of tokens) {
    if (SUPPORTED_LANGS.has(tok)) {
      meta.language = tok as 'py' | 'python';
      continue;
    }
    // Bare duration?
    const asDuration = parseDuration(tok);
    if (asDuration !== undefined && DURATION_RE.test(tok)) {
      meta.timeoutMs = asDuration;
      continue;
    }
    // key=value?
    if (tok.includes('=')) {
      const eqIdx = tok.indexOf('=');
      const key = tok.slice(0, eqIdx);
      const value = stripQuotes(tok.slice(eqIdx + 1));
      switch (key) {
        case 'id':
          meta.id = value;
          continue;
        case 't': {
          const d = parseDuration(value);
          if (d !== undefined) meta.timeoutMs = d;
          continue;
        }
        case 'rst':
          meta.reset = value === 'true' || value === '1';
          continue;
        default:
          meta.unrecognized.push(tok);
          continue;
      }
    }
    // Title fragment
    titleFragments.push(tok);
  }

  if (!meta.id && titleFragments.length > 0) {
    meta.id = titleFragments.join(' ');
  }

  return meta;
}

/**
 * Parse a single string of markdown-fenced cells into structured cell objects.
 *
 * Behavior:
 * - Text outside fenced blocks is ignored (preface, narration).
 * - Each opening fence ` ``` ` followed by metadata starts a cell.
 * - The cell body runs from the line after the opening fence up to the next
 *   line starting with ` ``` `.
 * - An unclosed fence produces a teaching error and the cells parsed so far.
 * - An unsupported language produces a teaching error per cell.
 * - A cell with no body (empty between fences) is allowed; it'll just be a
 *   no-op.
 *
 * `prevLanguage` lets a bare fence (` ``` ` with no metadata) inherit the
 * previous cell's language. v1 only supports py/python so this is mostly
 * cosmetic; sets up for js support later.
 */
export function parseCells(input: string): CellParseResult {
  const cells: ParsedCell[] = [];
  const lines = input.split('\n');
  let i = 0;
  let cellIndex = 0;
  let prevLanguage: 'py' | 'python' = 'py';

  while (i < lines.length) {
    const line = lines[i];
    const openMatch = line.match(/^\s*```(.*)$/);
    if (!openMatch) {
      i++;
      continue;
    }

    const info = openMatch[1].trim();
    const startLine = i + 1; // 1-indexed
    const meta = parseFenceMeta(info);

    if (!meta.language) {
      meta.language = prevLanguage;
    }
    if (!SUPPORTED_LANGS.has(meta.language)) {
      return {
        cells,
        error: `Cell at line ${startLine}: language "${meta.language}" not supported. Use \`py\` or \`python\`.`,
      };
    }
    prevLanguage = meta.language;

    // Collect body until closing fence
    i++;
    const bodyLines: string[] = [];
    while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
      bodyLines.push(lines[i]);
      i++;
    }
    if (i >= lines.length) {
      return {
        cells,
        error: `Cell at line ${startLine}: opening fence has no closing \`\`\`. Each cell must end with a line containing only \`\`\`.`,
      };
    }

    cellIndex++;
    cells.push({
      index: cellIndex,
      id: meta.id,
      language: meta.language,
      code: bodyLines.join('\n'),
      timeoutMs: meta.timeoutMs,
      reset: meta.reset,
      startLine,
    });
    i++; // skip closing fence
  }

  if (cells.length === 0) {
    return {
      cells: [],
      error:
        'No code cells found. Submit at least one fenced cell: ```py id="<title>"\\n<code>\\n```',
    };
  }

  return { cells };
}

/**
 * Convert legacy `{plan, operations: [{purpose, code}]}` shape into a single
 * markdown-cell string. Used by the repair shim during the cell migration.
 */
export function legacyOpsToCellString(ops: Array<{ purpose?: string; code: string }>): string {
  return ops
    .map((op) => {
      const id = op.purpose ? ` id="${op.purpose.replace(/"/g, '\\"')}"` : '';
      return '```py' + id + '\n' + op.code + '\n```';
    })
    .join('\n\n');
}

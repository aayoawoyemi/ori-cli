export interface ExtractedCell {
  index: number;
  language: 'py' | 'python';
  id?: string;
  timeoutMs?: number;
  reset: boolean;
  code: string;
}

export interface CodeExtractionResult {
  cells: ExtractedCell[];
  notes: string[];
  hasAnyFence: boolean;
}

const SUPPORTED_LANGS = new Set(['py', 'python']);
const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/;
function parseDuration(token: string): number | undefined {
  const match = token.trim().match(DURATION_RE);
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = match[2] ?? 's';
  if (unit === 'ms') return Math.round(n);
  if (unit === 'm') return Math.round(n * 60_000);
  return Math.round(n * 1000);
}

function tokenizeInfo(info: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < info.length) {
    while (i < info.length && /\s/.test(info[i])) i++;
    if (i >= info.length) break;

    const remainder = info.slice(i);
    const kv = remainder.match(/^([A-Za-z_][\w-]*)=(?:"([^"]*)"|'([^']*)'|(\S*))/);
    if (kv) {
      const key = kv[1];
      const value = kv[2] ?? kv[3] ?? kv[4] ?? '';
      tokens.push(`${key}=${value}`);
      i += kv[0].length;
      continue;
    }

    let j = i;
    while (j < info.length && !/\s/.test(info[j])) j++;
    tokens.push(info.slice(i, j));
    i = j;
  }
  return tokens;
}

function parseFenceInfo(info: string): {
  language?: string;
  id?: string;
  timeoutMs?: number;
  reset: boolean;
} {
  const tokens = tokenizeInfo(info);
  let language: string | undefined;
  let id: string | undefined;
  let timeoutMs: number | undefined;
  let reset = false;
  const titleParts: string[] = [];

  for (const token of tokens) {
    if (!language && /^[A-Za-z][A-Za-z0-9_-]*$/.test(token)) {
      language = token.toLowerCase();
      continue;
    }

    const bareDuration = parseDuration(token);
    if (bareDuration !== undefined) {
      timeoutMs = bareDuration;
      continue;
    }

    const eq = token.indexOf('=');
    if (eq >= 0) {
      const key = token.slice(0, eq);
      const value = token.slice(eq + 1);
      if (key === 'id') {
        id = value;
        continue;
      }
      if (key === 't') {
        const d = parseDuration(value);
        if (d !== undefined) timeoutMs = d;
        continue;
      }
      if (key === 'rst') {
        reset = value === 'true' || value === '1';
        continue;
      }
    }

    titleParts.push(token);
  }

  if (!id && titleParts.length > 0) {
    id = titleParts.join(' ');
  }

  return { language, id, timeoutMs, reset };
}

export function extractCodeCells(text: string): CodeExtractionResult {
  const lines = text.split('\n');
  const cells: ExtractedCell[] = [];
  const notes: string[] = [];
  let hasAnyFence = false;

  let inFence = false;
  let fenceInfo = '';
  let fenceStartLine = 0;
  let bodyLines: string[] = [];

  const pushFence = () => {
    const parsed = parseFenceInfo(fenceInfo);
    const language = parsed.language?.toLowerCase();
    if (!language || !SUPPORTED_LANGS.has(language)) {
      return;
    }
    cells.push({
      index: cells.length + 1,
      language: language as 'py' | 'python',
      id: parsed.id,
      timeoutMs: parsed.timeoutMs,
      reset: parsed.reset,
      code: bodyLines.join('\n'),
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inFence) {
      const open = line.match(/^\s*```(.*)$/);
      if (!open) continue;
      hasAnyFence = true;
      inFence = true;
      fenceInfo = open[1].trim();
      fenceStartLine = i + 1;
      bodyLines = [];
      continue;
    }

    if (/^\s*```\s*$/.test(line)) {
      pushFence();
      inFence = false;
      fenceInfo = '';
      bodyLines = [];
      fenceStartLine = 0;
      continue;
    }

    bodyLines.push(line);
  }

  if (inFence) {
    notes.push(
      `unclosed code fence starting at line ${fenceStartLine}; close each block with \`\`\`.`,
    );
  }
  return { cells, notes, hasAnyFence };
}

import { parseComposeBlocks } from './parser.js';

const OPEN_TAG_RE = /<compose_(preflight|update)>/i;
const OPEN_PREFIXES = ['<compose_preflight>', '<compose_update>'];

/**
 * Streaming display filter for compose protocol blocks.
 *
 * The raw XML is still preserved in the model transcript and scratch file.
 * This filter is only for the terminal timeline: complete protocol blocks
 * become compact one-line receipts, and incomplete streamed tags are held
 * until their closing tag arrives.
 */
export class ComposeDisplayFilter {
  private buffer = '';

  reset(): void {
    this.buffer = '';
  }

  push(chunk: string): string {
    if (!chunk) return '';
    this.buffer += chunk;
    return this.drainComplete();
  }

  flush(): string {
    const out = this.drainComplete();
    this.buffer = '';
    return out;
  }

  private drainComplete(): string {
    let text = this.buffer;
    this.buffer = '';
    let out = '';

    while (text) {
      const open = OPEN_TAG_RE.exec(text);
      if (!open) {
        const [emit, hold] = splitPotentialTagPrefix(text);
        this.buffer = hold;
        out += emit;
        return out;
      }

      out += text.slice(0, open.index);
      const kind = (open[1] ?? '').toLowerCase();
      const closeTag = `</compose_${kind}>`;
      const lowerText = text.toLowerCase();
      const closeIndex = lowerText.indexOf(closeTag, open.index + open[0].length);
      if (closeIndex < 0) {
        this.buffer = text.slice(open.index);
        return out;
      }

      const block = text.slice(open.index, closeIndex + closeTag.length);
      out = appendReceipt(out, renderComposeBlock(block));
      text = text.slice(closeIndex + closeTag.length);
    }

    return out;
  }
}

export function renderComposeBlocksForDisplay(text: string): string {
  const filter = new ComposeDisplayFilter();
  return filter.push(text) + filter.flush();
}

function renderComposeBlock(block: string): string {
  const parsed = parseComposeBlocks(block);
  if (parsed.preflight) {
    const purpose = compact(parsed.preflight.purpose || 'preflight');
    const meta: string[] = [];
    if (parsed.preflight.cell_kind) meta.push(`kind=${compact(parsed.preflight.cell_kind)}`);
    if (parsed.preflight.primitives && parsed.preflight.primitives.length > 0) {
      meta.push(`primitives=${formatList(parsed.preflight.primitives)}`);
    }
    return meta.length > 0 ? `Next: ${purpose} (${meta.join(', ')})` : `Next: ${purpose}`;
  }

  if (parsed.update) {
    const finding = compact(parsed.update.findings || 'update');
    const next = compact(parsed.update.next_move || '');
    return next ? `Found: ${finding}; next=${next}` : `Found: ${finding}`;
  }

  return '';
}

function appendReceipt(out: string, receipt: string): string {
  if (!receipt) return out;
  const prefix = out && !out.endsWith('\n') ? '\n' : '';
  return `${out}${prefix}${receipt}\n`;
}

function splitPotentialTagPrefix(text: string): [emit: string, hold: string] {
  const lower = text.toLowerCase();
  let holdLength = 0;
  for (const prefix of OPEN_PREFIXES) {
    const max = Math.min(prefix.length - 1, lower.length);
    for (let len = max; len > holdLength; len--) {
      if (prefix.startsWith(lower.slice(-len))) {
        holdLength = len;
        break;
      }
    }
  }
  if (holdLength === 0) return [text, ''];
  return [text.slice(0, -holdLength), text.slice(-holdLength)];
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 140);
}

function formatList(values: string[]): string {
  const clean = values.map(compact).filter(Boolean);
  if (clean.length <= 4) return clean.join(',');
  return `${clean.slice(0, 4).join(',')}+${clean.length - 4}`;
}

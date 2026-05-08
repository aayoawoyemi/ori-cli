import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { captureSnapshot } from './snapshot.js';
import type { Tool } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';

// ── Fuzzy Matching Strategies ───────────────────────────────────────────────
// Adopted from KiloCode's 9-strategy approach. LLMs constantly produce
// slightly-off old_string values — wrong indentation, extra whitespace,
// escaped characters, missing trailing newlines.

type MatchStrategy = {
  name: string;
  transform: (s: string) => string;
};

const STRATEGIES: MatchStrategy[] = [
  { name: 'exact', transform: s => s },
  { name: 'trimmed', transform: s => s.split('\n').map(l => l.trimEnd()).join('\n') },
  { name: 'whitespace-normalized', transform: s => s.replace(/[ \t]+/g, ' ') },
  { name: 'indent-flexible', transform: s => s.split('\n').map(l => l.trimStart()).join('\n') },
  { name: 'escape-normalized', transform: s => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"') },
  { name: 'boundary-trimmed', transform: s => s.trim() },
];

/**
 * Try to find old_string in content using progressively looser matching.
 * Returns the actual substring in content that matched, or null.
 *
 * Exported so body/fs.py's edit/patch callbacks can reuse the same fuzzy
 * matching the EditTool uses. Do not duplicate this logic — if we change
 * the strategy list here, fs.edit gets the improvement for free.
 */
export function fuzzyFind(content: string, oldString: string): { match: string; strategy: string } | null {
  for (const strategy of STRATEGIES) {
    const transformedContent = strategy.transform(content);
    const transformedOld = strategy.transform(oldString);

    if (transformedContent.includes(transformedOld)) {
      // Find the actual position in the transformed content
      const idx = transformedContent.indexOf(transformedOld);

      if (strategy.name === 'exact') {
        return { match: oldString, strategy: strategy.name };
      }

      // For non-exact strategies, we need to find the corresponding
      // substring in the ORIGINAL content. Use line-based mapping.
      const origMatch = findOriginalMatch(content, oldString, strategy);
      if (origMatch) {
        return { match: origMatch, strategy: strategy.name };
      }
    }
  }

  // Last resort: context-aware matching (50% line similarity)
  const contextMatch = contextAwareMatch(content, oldString);
  if (contextMatch) {
    return { match: contextMatch, strategy: 'context-aware' };
  }

  return null;
}

/**
 * For a non-exact strategy, find the original substring that corresponds
 * to the fuzzy match by comparing line-by-line.
 */
function findOriginalMatch(content: string, oldString: string, strategy: MatchStrategy): string | null {
  const oldLines = oldString.split('\n');
  const contentLines = content.split('\n');

  if (oldLines.length === 0) return null;

  // Find the first line match
  const transformedFirstLine = strategy.transform(oldLines[0]);

  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    const transformedContentLine = strategy.transform(contentLines[i]);

    if (transformedContentLine.includes(transformedFirstLine) || transformedFirstLine.includes(transformedContentLine)) {
      // Check if subsequent lines match too
      let allMatch = true;
      for (let j = 1; j < oldLines.length; j++) {
        if (i + j >= contentLines.length) { allMatch = false; break; }
        const tOld = strategy.transform(oldLines[j]);
        const tContent = strategy.transform(contentLines[i + j]);
        if (tContent !== tOld && !tContent.includes(tOld) && !tOld.includes(tContent)) {
          allMatch = false;
          break;
        }
      }

      if (allMatch) {
        // Return the original lines from content
        return contentLines.slice(i, i + oldLines.length).join('\n');
      }
    }
  }

  return null;
}

/**
 * Context-aware matching: if at least 50% of the middle lines match exactly,
 * and the first and last lines are similar, consider it a match.
 */
function contextAwareMatch(content: string, oldString: string): string | null {
  const oldLines = oldString.split('\n');
  if (oldLines.length < 3) return null; // need at least 3 lines for context matching

  const contentLines = content.split('\n');
  const middleOldLines = oldLines.slice(1, -1);
  const threshold = Math.ceil(middleOldLines.length * 0.5);

  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    const candidateMiddle = contentLines.slice(i + 1, i + oldLines.length - 1);

    // Count how many middle lines match
    let matches = 0;
    for (let j = 0; j < middleOldLines.length; j++) {
      if (j < candidateMiddle.length && candidateMiddle[j].trim() === middleOldLines[j].trim()) {
        matches++;
      }
    }

    if (matches >= threshold) {
      return contentLines.slice(i, i + oldLines.length).join('\n');
    }
  }

  return null;
}

/**
 * Generate a simple unified diff between old and new text.
 * Shows 2 lines of context around changes.
 *
 * Exported so fs.edit/fs.patch can return the same diff format the EditTool
 * surfaces — the model sees identical output whether the edit came from the
 * top-level Edit tool or from fs.edit inside the Repl.
 */
export function generateDiff(oldText: string, newText: string, filePath: string): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: string[] = [`--- ${filePath}`, `+++ ${filePath}`];

  // Find first differing line
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }

  // Find last differing line (from the end)
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  // Context: 2 lines before and after
  const ctxStart = Math.max(0, start - 2);
  const ctxOldEnd = Math.min(oldLines.length - 1, oldEnd + 2);
  const ctxNewEnd = Math.min(newLines.length - 1, newEnd + 2);

  result.push(`@@ -${ctxStart + 1},${ctxOldEnd - ctxStart + 1} +${ctxStart + 1},${ctxNewEnd - ctxStart + 1} @@`);

  // Context before
  for (let i = ctxStart; i < start; i++) {
    result.push(` ${oldLines[i]}`);
  }

  // Removed lines
  for (let i = start; i <= oldEnd; i++) {
    result.push(`-${oldLines[i]}`);
  }

  // Added lines
  for (let i = start; i <= newEnd; i++) {
    result.push(`+${newLines[i]}`);
  }

  // Context after
  for (let i = oldEnd + 1; i <= ctxOldEnd; i++) {
    if (i < oldLines.length) result.push(` ${oldLines[i]}`);
  }

  return result.join('\n');
}


// -- Near-miss diagnostics ----------------------------------------------------
// When fuzzyFind returns null, this function finds the closest regions in
// the file to what the model sent. Returns top 3 candidates with inline
// diffs showing exactly where they diverge. Added 2026-05-01 alongside
// the prompt streamline -- richer error messages replace heavy prompt rails.

/** Simple string similarity (0-1). LCS-based ratio. */
function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const lcs = lcsLen(a, b);
  return (2 * lcs) / (a.length + b.length);
}

/** LCS length. For large strings, uses line-level approximation. */
function lcsLen(a: string, b: string): number {
  if (a.length > 2000 || b.length > 2000) {
    const aL = a.split('\n');
    const bL = b.split('\n');
    return lcsLenArr(aL, bL) * 40;
  }
  const m = a.length;
  const n = b.length;
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1] + 1
        : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev.fill(0)];
  }
  return prev[n];
}

function lcsLenArr(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1] + 1
        : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev.fill(0)];
  }
  return prev[n];
}

/** Compact diff: show only diverging lines with +/- markers. */
function compactDiff(expected: string, actual: string): string {
  const expLines = expected.split('\n');
  const actLines = actual.split('\n');
  const result: string[] = [];
  const maxLines = Math.max(expLines.length, actLines.length);

  for (let i = 0; i < maxLines; i++) {
    const exp = i < expLines.length ? expLines[i] : undefined;
    const act = i < actLines.length ? actLines[i] : undefined;
    if (exp === act) {
      if (result.length > 0 || i < 2) result.push(`  ${act}`);
    } else {
      if (exp !== undefined) result.push(`- ${exp}`);
      if (act !== undefined) result.push(`+ ${act}`);
    }
    if (result.length > 20) {
      result.push('  ... (truncated)');
      break;
    }
  }
  return result.join('\n');
}

/**
 * Find near-miss candidates when fuzzyFind returns null.
 * Uses first-line anchoring + LCS-based scoring.
 * Returns up to 3 candidates with similarity scores and compact diffs.
 */
export function nearMissFind(
  content: string,
  oldString: string,
  maxResults: number = 3,
): Array<{ region: string; similarity: number; diff: string }> {
  const oldLines = oldString.split('\n');
  const contentLines = content.split('\n');
  if (oldLines.length === 0 || contentLines.length === 0) return [];

  const anchor = oldLines.find(l => l.trim().length > 0) || oldLines[0];
  const anchorTrimmed = anchor.trim().toLowerCase();
  const anchorTokens = new Set(anchorTrimmed.split(/\s+/));

  const candidates: Array<{ start: number; score: number }> = [];

  for (let i = 0; i <= contentLines.length - 1; i++) {
    const lineTrimmed = contentLines[i].trim().toLowerCase();
    const lineTokens = lineTrimmed.split(/\s+/);
    const overlap = lineTokens.filter(t => anchorTokens.has(t)).length;
    if (anchorTokens.size > 0 && overlap / anchorTokens.size < 0.3) continue;

    const regionEnd = Math.min(i + oldLines.length, contentLines.length);
    const region = contentLines.slice(i, regionEnd).join('\n');
    const score = stringSimilarity(oldString, region);
    if (score > 0.3) {
      candidates.push({ start: i, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, maxResults).map(c => {
    const regionEnd = Math.min(c.start + oldLines.length, contentLines.length);
    const region = contentLines.slice(c.start, regionEnd).join('\n');
    return {
      region,
      similarity: Math.round(c.score * 100) / 100,
      diff: compactDiff(oldString, region),
    };
  });
}

// ── Edit Tool ───────────────────────────────────────────────────────────────

export class EditTool implements Tool {
  readonly name = 'Edit';
  readonly description = 'Perform string replacement in a file. Uses fuzzy matching — handles minor whitespace, indentation, and escape differences. The old_string should be unique in the file unless replace_all is true.';
  readonly readOnly = false;

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute or relative path to the file to edit.',
          },
          old_string: {
            type: 'string',
            description: 'The string to replace. Must be unique in the file unless replace_all is true.',
          },
          new_string: {
            type: 'string',
            description: 'The replacement string.',
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace all occurrences (default: false).',
          },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    };
  }

  async execute(input: Record<string, unknown>, ctx: { cwd: string }): Promise<ToolResult> {
    const filePath = resolve(ctx.cwd, input.file_path as string);
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    const replaceAll = (input.replace_all as boolean) || false;

    try {
      const content = readFileSync(filePath, 'utf-8');

      // Try fuzzy matching
      const found = fuzzyFind(content, oldString);

      if (!found) {
        const nearMisses = nearMissFind(content, oldString, 3);
        let diagnostic = `Error: old_string not found in ${filePath} (tried all fuzzy strategies).`;
        if (nearMisses.length > 0) {
          diagnostic += `
Nearest matches (- is what you sent, + is what's in the file):`;
          for (const nm of nearMisses) {
            diagnostic += `

[${Math.round(nm.similarity * 100)}% similar]:
${nm.diff}`;
          }
        }
        return {
          id: '',
          name: this.name,
          output: diagnostic,
          isError: true,
        };
      }

      const actualMatch = found.match;

      if (!replaceAll) {
        const firstIndex = content.indexOf(actualMatch);
        const lastIndex = content.lastIndexOf(actualMatch);
        if (firstIndex !== lastIndex) {
          const count = content.split(actualMatch).length - 1;
          return {
            id: '',
            name: this.name,
            output: `Error: matched string appears ${count} times in ${filePath}. Use replace_all=true or provide more context.`,
            isError: true,
          };
        }
      }

      const updated = replaceAll
        ? content.split(actualMatch).join(newString)
        : content.replace(actualMatch, newString);

      captureSnapshot(filePath, 'Edit');
      writeFileSync(filePath, updated, 'utf-8');

      const strategyNote = found.strategy !== 'exact' ? ` (matched via ${found.strategy})` : '';
      const diff = generateDiff(actualMatch, newString, filePath);
      return {
        id: '',
        name: this.name,
        output: `Applied edit to ${filePath}${strategyNote}\n${diff}`,
        isError: false,
      };
    } catch (err) {
      return {
        id: '',
        name: this.name,
        output: `Error editing file: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}

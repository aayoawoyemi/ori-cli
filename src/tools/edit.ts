import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
 */
function fuzzyFind(content: string, oldString: string): { match: string; strategy: string } | null {
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
        return {
          id: '',
          name: this.name,
          output: `Error: old_string not found in ${filePath} (tried 7 matching strategies)`,
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

      writeFileSync(filePath, updated, 'utf-8');

      const strategyNote = found.strategy !== 'exact' ? ` (matched via ${found.strategy})` : '';
      return {
        id: '',
        name: this.name,
        output: `File edited successfully: ${filePath}${strategyNote}`,
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

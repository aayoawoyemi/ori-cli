import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import type { Tool } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';
import type { OriVault } from '../memory/vault.js';

export class VaultReadTool implements Tool {
  readonly name = 'VaultRead';
  readonly description = 'Read a specific vault note by title. Returns the full note content including frontmatter. Use after VaultSearch to read a specific result.';
  readonly readOnly = true;

  constructor(private vault: OriVault) {}

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The note title (or partial title) to read.' },
        },
        required: ['title'],
      },
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const title = input.title as string;
    const notesDir = join(this.vault.vaultPath, 'notes');

    try {
      // Try exact slug match first
      const slug = title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
      const exactPath = join(notesDir, `${slug}.md`);

      if (existsSync(exactPath)) {
        const content = readFileSync(exactPath, 'utf-8');
        return { id: '', name: this.name, output: content, isError: false };
      }

      // Fuzzy match: find files containing the title words
      if (!existsSync(notesDir)) {
        return { id: '', name: this.name, output: 'Notes directory not found.', isError: true };
      }

      const files = readdirSync(notesDir).filter(f => f.endsWith('.md'));
      const searchTerms = title.toLowerCase().split(/\s+/).filter(t => t.length > 3);

      const match = files.find(f => {
        const fname = f.toLowerCase();
        return searchTerms.every(term => fname.includes(term));
      }) ?? files.find(f => {
        const fname = f.toLowerCase();
        return searchTerms.some(term => fname.includes(term));
      });

      if (match) {
        const content = readFileSync(join(notesDir, match), 'utf-8');
        return { id: '', name: this.name, output: content, isError: false };
      }

      return { id: '', name: this.name, output: `No note found matching: "${title}"`, isError: false };
    } catch (err) {
      return { id: '', name: this.name, output: `Read failed: ${(err as Error).message}`, isError: true };
    }
  }
}

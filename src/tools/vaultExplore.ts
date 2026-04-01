import type { Tool } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';
import type { OriVault } from '../memory/vault.js';

export class VaultExploreTool implements Tool {
  readonly name = 'VaultExplore';
  readonly description = 'Deep graph-traversal search over the vault. Walks wiki-links N hops from seed results. Finds notes that flat retrieval misses — connections between ideas across projects.';
  readonly readOnly = true;

  constructor(private vault: OriVault) {}

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language query to explore.' },
          depth: { type: 'number', description: 'Traversal depth: 1=shallow, 2=standard, 3=deep (default: 2).' },
          limit: { type: 'number', description: 'Max results (default: 15).' },
        },
        required: ['query'],
      },
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const query = input.query as string;
    const depth = (input.depth as number) || 2;
    const limit = (input.limit as number) || 15;

    try {
      const results = await this.vault.explore(query, limit, depth);
      if (results.length === 0) {
        return { id: '', name: this.name, output: 'No notes found via graph exploration.', isError: false };
      }
      const output = results
        .map(r => `- "${r.title}" (score: ${r.score?.toFixed(3) ?? 'N/A'})`)
        .join('\n');
      return { id: '', name: this.name, output: `Explored ${results.length} notes (depth ${depth}):\n${output}`, isError: false };
    } catch (err) {
      return { id: '', name: this.name, output: `Explore failed: ${(err as Error).message}`, isError: true };
    }
  }
}

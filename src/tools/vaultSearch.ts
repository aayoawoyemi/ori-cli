import type { Tool, ToolContext } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';
import type { OriVault } from '../memory/vault.js';

export class VaultSearchTool implements Tool {
  readonly name = 'VaultSearch';
  readonly description = 'Search the Ori vault with ranked retrieval (semantic + keyword + graph). Returns the most relevant notes across all projects. Use for explicit deep dives when preflight context is not enough.';
  readonly readOnly = true;

  constructor(private vault: OriVault) {}

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language search query.' },
          limit: { type: 'number', description: 'Max results (default: 10).' },
        },
        required: ['query'],
      },
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const query = input.query as string;
    const limit = (input.limit as number) || 10;

    try {
      const results = await this.vault.queryRanked(query, limit);
      if (results.length === 0) {
        return { id: '', name: this.name, output: 'No vault notes found matching query.', isError: false };
      }
      const output = results
        .map(r => `- "${r.title}" (score: ${r.score?.toFixed(3) ?? 'N/A'})`)
        .join('\n');
      return { id: '', name: this.name, output: `Found ${results.length} notes:\n${output}`, isError: false };
    } catch (err) {
      return { id: '', name: this.name, output: `Vault search failed: ${(err as Error).message}`, isError: true };
    }
  }
}

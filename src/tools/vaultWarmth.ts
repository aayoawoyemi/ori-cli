import type { Tool } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';
import type { OriVault } from '../memory/vault.js';

export class VaultWarmthTool implements Tool {
  readonly name = 'VaultWarmth';
  readonly description = 'Get associatively activated notes — what is resonating in memory right now based on recent context. Different from search: warmth surfaces notes related to the conversation FLOW, not just the last query.';
  readonly readOnly = true;

  constructor(private vault: OriVault) {}

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          context: { type: 'string', description: 'Current conversation context or topic to check warmth for.' },
          limit: { type: 'number', description: 'Max results (default: 10).' },
        },
        required: ['context'],
      },
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const context = input.context as string;
    const limit = (input.limit as number) || 10;

    try {
      const results = await this.vault.queryWarmth(context, limit);
      if (results.length === 0) {
        return { id: '', name: this.name, output: 'No warm notes found for this context.', isError: false };
      }
      const output = results
        .map(r => `- "${r.title}" (warmth: ${r.score?.toFixed(3) ?? 'N/A'})`)
        .join('\n');
      return { id: '', name: this.name, output: `${results.length} warm notes:\n${output}`, isError: false };
    } catch (err) {
      return { id: '', name: this.name, output: `Warmth query failed: ${(err as Error).message}`, isError: true };
    }
  }
}

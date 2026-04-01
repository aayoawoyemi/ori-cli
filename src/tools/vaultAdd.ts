import type { Tool } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';
import type { OriVault } from '../memory/vault.js';

export class VaultAddTool implements Tool {
  readonly name = 'VaultAdd';
  readonly description = 'Add a note to the Ori vault inbox. Use to persist durable insights, decisions, learnings, or ideas that should be remembered across sessions and projects.';
  readonly readOnly = false;

  constructor(private vault: OriVault) {}

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Prose-as-title claim (e.g., "SSE APIs send full accumulated text not deltas"). Must be a complete thought.',
          },
          content: {
            type: 'string',
            description: 'The note body — explanation, evidence, context.',
          },
          type: {
            type: 'string',
            enum: ['idea', 'decision', 'learning', 'insight', 'blocker', 'opportunity'],
            description: 'Note type (default: insight).',
          },
        },
        required: ['title', 'content'],
      },
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const title = input.title as string;
    const content = input.content as string;
    const type = (input.type as string) || 'insight';

    try {
      const success = await this.vault.add(title, content, type);
      if (success) {
        return { id: '', name: this.name, output: `Note added to vault: "${title}"`, isError: false };
      }
      return { id: '', name: this.name, output: 'Failed to add note to vault.', isError: true };
    } catch (err) {
      return { id: '', name: this.name, output: `Vault add failed: ${(err as Error).message}`, isError: true };
    }
  }
}

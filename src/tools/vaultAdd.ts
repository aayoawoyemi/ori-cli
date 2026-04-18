import type { Tool } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';
import type { OriVault } from '../memory/vault.js';

// ── Vault Tier Classification ────────────────────────────────────────────────
// The vault is permanent, cross-project, civilizational memory. Ephemeral or
// project-specific notes don't belong there. This classifier runs before every
// write and rejects obvious garbage, forcing the model to use ProjectSave instead.
//
// Start conservative (only reject the clear cases). Tighten over time.

const EPHEMERAL_PATTERNS = [
  /doesn'?t work on (windows|mac|linux|win32|darwin)/i,
  /bash (fails?|doesn'?t work|not available)/i,
  /command not found/i,
  /install (error|fail)/i,
  /path (not found|missing)/i,
  /shell (fails?|error)/i,
  /(ls|cat|grep|find) (fails?|not (found|available)|doesn'?t work)/i,
  /\bwin32\b.*(fail|error|break|broken)/i,
];

function classifyVaultNote(title: string, content: string): 'vault' | 'reject' {
  const text = `${title} ${content}`;
  for (const pattern of EPHEMERAL_PATTERNS) {
    if (pattern.test(text)) {
      return 'reject';
    }
  }
  return 'vault';
}

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

    // Tier check: reject ephemeral/project-specific notes
    const tier = classifyVaultNote(title, content);
    if (tier === 'reject') {
      return {
        id: '',
        name: this.name,
        output: `Vault rejected: this note is environment-specific or ephemeral. Use ProjectSave for working notes scoped to this project. The vault is for cross-project, durable insights that compound over months and across all projects.`,
        isError: true,
      };
    }

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

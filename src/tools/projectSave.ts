import type { Tool } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';
import type { ProjectBrain } from '../memory/projectBrain.js';

export class ProjectSaveTool implements Tool {
  readonly name = 'ProjectSave';
  readonly description = 'Save a note to the project brain (.aries/memory/). Use for codebase-specific knowledge: conventions, architecture decisions, test commands, load-bearing patterns. Scoped to this project only.';
  readonly readOnly = false;

  constructor(private projectBrain: ProjectBrain) {}

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Prose-as-title claim specific to this codebase (e.g., "ToolRegistry uses PascalCase names not lowercase").',
          },
          content: {
            type: 'string',
            description: 'The note body — explanation, evidence, context.',
          },
          type: {
            type: 'string',
            enum: ['decision', 'learning', 'insight', 'convention', 'blocker'],
            description: 'Note type (default: learning).',
          },
        },
        required: ['title', 'content'],
      },
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const title = input.title as string;
    const content = input.content as string;
    const type = (input.type as string) || 'learning';

    try {
      this.projectBrain.save(title, content, type);
      return { id: '', name: this.name, output: `Note saved to project brain: "${title}"`, isError: false };
    } catch (err) {
      return { id: '', name: this.name, output: `ProjectSave failed: ${(err as Error).message}`, isError: true };
    }
  }
}

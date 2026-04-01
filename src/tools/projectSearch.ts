import type { Tool } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';
import type { ProjectBrain } from '../memory/projectBrain.js';

export class ProjectSearchTool implements Tool {
  readonly name = 'ProjectSearch';
  readonly description = 'Search the project brain (.aries/memory/) for project-specific knowledge. Contains learnings auto-extracted from past sessions in THIS codebase — test commands, conventions, architecture decisions, etc.';
  readonly readOnly = true;

  constructor(private brain: ProjectBrain) {}

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          limit: { type: 'number', description: 'Max results (default: 10).' },
        },
        required: ['query'],
      },
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const query = input.query as string;
    const limit = (input.limit as number) || 10;

    const results = this.brain.search(query, limit);
    if (results.length === 0) {
      return { id: '', name: this.name, output: 'No project memories found.', isError: false };
    }
    const output = results
      .map(r => `- "${r.title}" [${r.type}] (${r.created})`)
      .join('\n');
    return { id: '', name: this.name, output: `${results.length} project memories:\n${output}`, isError: false };
  }
}

import { readFileSync } from 'node:fs';
import type { Tool, ToolContext } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';
import type { PlanContext, PlanApprovalResult } from './planTypes.js';

export class ExitPlanModeTool implements Tool {
  readonly name = 'ExitPlanMode';
  readonly description = 'Present your plan for user approval. Reads the plan from the plan file you wrote. Only call this when your plan is complete.';
  readonly readOnly = false; // triggers approval flow

  constructor(
    private planContext: PlanContext,
    private onExit: (filePath: string, content: string) => Promise<PlanApprovalResult>,
  ) {}

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {},
      },
    };
  }

  async execute(_input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    if (!this.planContext.filePath) {
      return {
        id: '', name: this.name,
        output: 'No plan file exists. Call EnterPlanMode first.',
        isError: true,
      };
    }

    let content: string;
    try {
      content = readFileSync(this.planContext.filePath, 'utf-8');
    } catch {
      return {
        id: '', name: this.name,
        output: `Could not read plan file: ${this.planContext.filePath}`,
        isError: true,
      };
    }

    if (!content.trim()) {
      return {
        id: '', name: this.name,
        output: 'Plan file is empty. Write your plan to the plan file before calling ExitPlanMode.',
        isError: true,
      };
    }

    // Block until user responds to approval dialog
    const result = await this.onExit(this.planContext.filePath, content);

    if (result.action === 'accepted') {
      // Clear plan context so a fresh plan can be started later
      const approvedPath = this.planContext.filePath;
      this.planContext.filePath = null;
      return {
        id: '', name: this.name,
        output: `User has approved your plan. You can now start coding.\n\nYour plan has been saved to: ${approvedPath}\nYou can refer back to it if needed during implementation.\n\n## Approved Plan:\n${content}`,
        isError: false,
      };
    } else {
      return {
        id: '', name: this.name,
        output: `Plan needs revision. User feedback:\n\n${result.feedback}\n\nRefine the plan file and call ExitPlanMode again when ready.`,
        isError: false,
      };
    }
  }
}

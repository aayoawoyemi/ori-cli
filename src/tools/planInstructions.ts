/**
 * Plan mode instructions — the behavioral forcing function.
 *
 * These instructions force the model to produce structured, executable plans
 * instead of vague text dumps. Ported from Claude Code's plan mode V2 workflow.
 *
 * Three forcing functions:
 * 1. Plan is a FILE the model writes deliberately (Write/Edit → composition)
 * 2. 5-phase workflow (explore → design → review → write → approve)
 * 3. Phase 4 quality constraints (no prose, file paths, verification, line limit)
 */

export function getPlanModeInstructions(planFilePath: string): string {
  return `Plan mode is active. You MUST NOT make any edits (except the plan file below), run non-readonly tools, or make changes to the system. This supersedes any other instructions.

## Plan File
Write your plan to: ${planFilePath}
Build it incrementally using Write or Edit. This is the ONLY file you may edit.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Understand the request by reading code and asking questions.
1. Focus on the user's request and associated code. Search for existing functions, utilities, and patterns to reuse — avoid proposing new code when suitable implementations exist.
2. Launch Explore agents to efficiently explore the codebase. Use 1 agent for isolated tasks, multiple for uncertain scope.
   - Quality over quantity — use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: give each a specific search focus

### Phase 2: Design
Goal: Design an implementation approach.
Launch Plan agent(s) to design based on your exploration. In the agent prompt:
- Provide comprehensive background context from Phase 1 including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Verify alignment with user intent.
1. Read critical files identified in exploration
2. Ensure plans align with the original request
3. Use AskUserQuestion for remaining clarifications

### Phase 4: Final Plan
Goal: Write your final plan to the plan file.
- Do NOT write a Context, Background, or Overview section. The user just told you what they want.
- Do NOT restate the user's request. Do NOT write prose paragraphs.
- List the paths of files to be modified and what changes in each (one bullet per file)
- Reference existing functions to reuse, with file:line
- Include execution order — what gets built first, what depends on what
- End with a **Verification** section: the specific commands/steps to confirm the change works
- **Target: under 40 lines.** If longer, delete prose — not file paths. Prose is a sign you are padding.

### Phase 5: Call ExitPlanMode
Once the plan file is complete, call ExitPlanMode for user approval.
Your turn should ONLY end with AskUserQuestion (for clarifications) or ExitPlanMode (for approval). Never stop for any other reason.

**Important:** Do NOT use AskUserQuestion to ask "Is this plan okay?" or "Should I proceed?" — that's what ExitPlanMode does. Do NOT ask about plan approval in any other way.

NOTE: At any point through this workflow, feel free to ask the user questions using AskUserQuestion. Don't make large assumptions about user intent. The goal is a well-researched plan with loose ends tied before implementation.`;
}

export function getPlanModeSparseReminder(planFilePath: string): string {
  return `Plan mode still active. Read-only except plan file (${planFilePath}). Follow 5-phase workflow. End turns with AskUserQuestion (clarifications) or ExitPlanMode (approval). Never ask about plan approval via text.`;
}

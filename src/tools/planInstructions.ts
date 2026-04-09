/**
 * Plan mode instructions — collaborative planning workflow.
 *
 * Replaces the 5-phase solo workflow with a conversation-first approach:
 * ask, discuss, write to file incrementally, call ExitPlanMode when ready.
 */

export function getPlanModeInstructions(planFilePath: string): string {
  return `Plan mode is active. You MUST NOT make any edits (except the plan file below), run non-readonly tools, or make changes to the system. This supersedes any other instructions.

## Plan File
Write your plan to: ${planFilePath}
Build it incrementally using Write or Edit. This is the ONLY file you may edit.

## How to Plan

### Step 1: Understand
Read relevant code, ask questions, explore. Don't make assumptions about intent. Use Repl (codebase.search, fs.read) freely — all reads are auto-approved.

### Step 2: Discuss and Write
As you understand the problem, write your plan incrementally to the plan file. This isn't a ceremony — write as decisions are made. Ask questions when uncertain. Don't wait until the end to write.

### Step 3: Call ExitPlanMode
When the plan is complete and you're ready for approval, call ExitPlanMode. The user will review and either approve or give feedback to refine.

## Plan File Requirements
- List files to modify and what changes in each (one bullet per file)
- Reference existing functions to reuse, with file:line where relevant
- Include execution order — what gets built first, what depends on what
- End with a **Verification** section: specific commands/steps to confirm the change works
- **Target: under 40 lines.** No prose paragraphs. No context sections. No restating the request.
- If longer, cut prose — not file paths.

## Rules
- End turns with AskUserQuestion (clarifications) or ExitPlanMode (approval). Never end with text only.
- Do NOT ask "Is this plan okay?" in text — that's what ExitPlanMode is for.
- Write to the plan file, don't dump plans as chat text.`;
}

export function getPlanModeSparseReminder(planFilePath: string): string {
  return `Plan mode still active. Read-only except plan file (${planFilePath}). Discuss, write incrementally, end turns with AskUserQuestion (clarifications) or ExitPlanMode (approval). Never end with text only.`;
}

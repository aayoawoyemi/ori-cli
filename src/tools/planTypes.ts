/**
 * Shared types for plan mode tools.
 */

/** Mutable context shared between EnterPlanMode and ExitPlanMode. */
export interface PlanContext {
  filePath: string | null;
}

/** Result from the plan approval dialog. */
export type PlanApprovalResult =
  | { action: 'accepted'; mode: 'keep_context' | 'clear_context' | 'accept_edits' }
  | { action: 'rejected'; feedback: string };

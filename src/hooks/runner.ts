import { execSync } from 'node:child_process';
import type { HookConfig, HookPoint, HookEnv, HooksConfig } from './types.js';

export interface HookContext {
  cwd: string;
  vaultPath?: string;
}

export interface ToolHookData {
  tool: string;
  input: Record<string, unknown>;
  output?: string;
  isError?: boolean;
}

export interface CodeHookData {
  code: string;
  stdout?: string;
  stderr?: string;
  exception?: string | null;
  rejected?: { reason: string } | null;
}

/**
 * Run all hooks for a given hook point.
 * Returns false if any preToolUse hook blocks (non-zero exit).
 */
export async function runHooks(
  point: HookPoint,
  hooks: HooksConfig | undefined,
  ctx: HookContext,
  toolData?: ToolHookData,
  codeData?: CodeHookData,
): Promise<{ blocked: boolean; blockMessage?: string }> {
  const hookList = hooks?.[point];
  if (!hookList || hookList.length === 0) {
    return { blocked: false };
  }

  // Filter by tool name if applicable
  const applicable = hookList.filter(h => {
    if (!h.tools || h.tools.length === 0) return true;
    if (!toolData?.tool) return true;
    return h.tools.includes(toolData.tool);
  });

  if (applicable.length === 0) return { blocked: false };

  // Build environment variables
  const env: Record<string, string> = {
    ...process.env,
    ARIES_HOOK: point,
    ARIES_CWD: ctx.cwd,
  };

  if (ctx.vaultPath) env.ARIES_VAULT = ctx.vaultPath;

  if (toolData) {
    env.ARIES_TOOL = toolData.tool;
    env.ARIES_TOOL_INPUT = JSON.stringify(toolData.input);
    if (toolData.output !== undefined) env.ARIES_TOOL_OUTPUT = toolData.output.slice(0, 10_000);
    if (toolData.isError) env.ARIES_TOOL_ERROR = 'true';
  }

  if (codeData) {
    env.ARIES_CODE = codeData.code.slice(0, 10_000);
    if (codeData.stdout !== undefined) env.ARIES_CODE_STDOUT = codeData.stdout.slice(0, 10_000);
    if (codeData.stderr !== undefined) env.ARIES_CODE_STDERR = codeData.stderr.slice(0, 4_000);
    if (codeData.exception) env.ARIES_CODE_EXCEPTION = codeData.exception.slice(0, 4_000);
    if (codeData.rejected) env.ARIES_CODE_REJECTED = codeData.rejected.reason;
  }

  for (const hook of applicable) {
    const timeout = hook.timeout ?? 30_000;

    try {
      execSync(hook.command, {
        cwd: ctx.cwd,
        env,
        timeout,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: 'bash' as string,
      });
    } catch (err) {
      // For preToolUse/preCodeExecution: non-zero exit blocks execution
      if (point === 'preToolUse' || point === 'preCodeExecution') {
        const msg = (err as { stderr?: Buffer })?.stderr?.toString().trim()
          || `Hook blocked: ${hook.command}`;
        return { blocked: true, blockMessage: msg };
      }
      // For other hooks: log error but don't block
      // (hooks should never crash the agent)
    }
  }

  return { blocked: false };
}

export type HookPoint = 'sessionStart' | 'preToolUse' | 'postToolUse' | 'stop';

export interface HookConfig {
  command: string;
  tools?: string[];       // only fire for these tools (preToolUse/postToolUse)
  timeout?: number;       // ms, default 30000
}

export interface HookEnv {
  ARIES_HOOK: HookPoint;
  ARIES_CWD: string;
  ARIES_VAULT?: string;
  ARIES_TOOL?: string;
  ARIES_TOOL_INPUT?: string;
  ARIES_TOOL_OUTPUT?: string;
  ARIES_TOOL_ERROR?: string;
}

export interface HooksConfig {
  sessionStart?: HookConfig[];
  preToolUse?: HookConfig[];
  postToolUse?: HookConfig[];
  stop?: HookConfig[];
}

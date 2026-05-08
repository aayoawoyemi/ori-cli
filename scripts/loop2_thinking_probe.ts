import { ModelRouter } from '../src/router/index.js';
import { AnthropicProvider } from '../src/router/providers/anthropic.js';
import type { ModelConfig, RouterConfig } from '../src/config/types.js';

type ProbeCapture = {
  hasToolsField: boolean;
  hasToolChoice: boolean;
  thinkingShape: unknown;
  authMode: 'api_key' | 'oauth';
};

function buildAnthropicConfig(): ModelConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey,
    };
  }

  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    auth: 'oauth',
  };
}

function authMode(): 'api_key' | 'oauth' {
  return process.env.ANTHROPIC_API_KEY ? 'api_key' : 'oauth';
}

function createAnthropicProvider(): AnthropicProvider {
  return new AnthropicProvider(buildAnthropicConfig(), {
    allowExperimentalLocalOAuth: true,
  });
}

async function captureDirectProviderShape(): Promise<ProbeCapture> {
  const provider = createAnthropicProvider();
  let captured: Record<string, unknown> | null = null;

  (provider as unknown as {
    client: { messages: { stream: (params: Record<string, unknown>) => AsyncIterable<unknown> } };
  }).client = {
    messages: {
      stream: (params: Record<string, unknown>) => {
        captured = params;
        throw new Error('__capture__');
      },
    },
  };

  try {
    for await (const _ of provider.stream([{ role: 'user', content: 'probe' }], 'system', [])) {
      // unreachable
    }
  } catch {
    // expected
  }

  if (!captured) throw new Error('failed to capture direct provider params');
  return {
    hasToolsField: Object.prototype.hasOwnProperty.call(captured, 'tools'),
    hasToolChoice: Object.prototype.hasOwnProperty.call(captured, 'tool_choice'),
    thinkingShape: captured.thinking,
    authMode: authMode(),
  };
}

async function captureRouterShape(): Promise<ProbeCapture> {
  const routerConfig: RouterConfig = { primary: buildAnthropicConfig() };
  const router = new ModelRouter(routerConfig, {
    localClaudeSubscription: true,
    localChatGPTSubscription: false,
  });
  const provider = router.current as unknown as {
    client: { messages: { stream: (params: Record<string, unknown>) => AsyncIterable<unknown> } };
  };
  let captured: Record<string, unknown> | null = null;

  provider.client = {
    messages: {
      stream: (params: Record<string, unknown>) => {
        captured = params;
        throw new Error('__capture__');
      },
    },
  };

  try {
    for await (const _ of router.stream([{ role: 'user', content: 'probe' }], 'system', [])) {
      // unreachable
    }
  } catch {
    // expected
  }

  if (!captured) throw new Error('failed to capture router params');
  return {
    hasToolsField: Object.prototype.hasOwnProperty.call(captured, 'tools'),
    hasToolChoice: Object.prototype.hasOwnProperty.call(captured, 'tool_choice'),
    thinkingShape: captured.thinking,
    authMode: authMode(),
  };
}

// Hard enough to engage adaptive thinking on Sonnet 4.6 / Opus 4.7.
// Adaptive treats trivial prompts ("say ok") as 0-budget; we need a real
// reasoning task to know whether thinking is actually emitted.
const HARD_PROMPT =
  'A jar holds 27 cookies. Five children divide them equally; whoever gets a fractional cookie has to share it. How many whole cookies does each child get, how many are left over, and what is one fair way to split the leftovers? Show your reasoning step by step.';

const FAKE_TOOL = {
  name: 'lookup',
  description: 'Look up an arbitrary number in an imaginary registry.',
  input_schema: {
    type: 'object' as const,
    properties: { key: { type: 'string' as const } },
    required: ['key'],
  },
};

async function runLiveProbe(label: string, tools: typeof FAKE_TOOL[] | []): Promise<{
  label: string;
  attempted: boolean;
  blockedReason?: string;
  thinkingEvents?: number;
  thinkingChars?: number;
  textEvents?: number;
  textChars?: number;
}> {
  const provider = createAnthropicProvider();
  let thinkingEvents = 0;
  let thinkingChars = 0;
  let textEvents = 0;
  let textChars = 0;

  try {
    for await (const event of provider.stream(
      [{ role: 'user', content: HARD_PROMPT }],
      'You are a probe. Think step by step.',
      tools,
    )) {
      if (event.type === 'thinking') {
        thinkingEvents += 1;
        thinkingChars += event.content.length;
      }
      if (event.type === 'text') {
        textEvents += 1;
        textChars += event.content.length;
      }
    }
    return { label, attempted: true, thinkingEvents, thinkingChars, textEvents, textChars };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      label,
      attempted: true,
      blockedReason: message,
      thinkingEvents,
      thinkingChars,
      textEvents,
      textChars,
    };
  }
}

async function main(): Promise<void> {
  const direct = await captureDirectProviderShape();
  const viaRouter = await captureRouterShape();
  const liveNoTools = await runLiveProbe('hard_prompt_no_tools', []);
  const liveWithTool = await runLiveProbe('hard_prompt_with_fake_tool', [FAKE_TOOL]);

  console.log(JSON.stringify({
    date: new Date().toISOString(),
    direct,
    viaRouter,
    liveNoTools,
    liveWithTool,
  }, null, 2));
}

await main();

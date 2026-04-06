import assert from 'node:assert/strict';
import { AnthropicProvider } from '../src/router/providers/anthropic.js';

let failures = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}

function makeStream(events: unknown[], usage = { input_tokens: 10, output_tokens: 5 }) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    async finalMessage() {
      return { usage };
    },
  };
}

await test('retries once on 429 before any output and succeeds', async () => {
  let calls = 0;
  let sleeps = 0;

  const provider = new AnthropicProvider(
    {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'test-key',
    },
    {
      maxRateLimitRetries: 1,
      defaultRateLimitBackoffMs: 1,
      sleepImpl: async () => { sleeps += 1; },
    },
  );

  const fakeClient = {
    messages: {
      stream: () => {
        calls += 1;
        if (calls === 1) {
          const err = new Error('rate limited');
          (err as Error & { status?: number }).status = 429;
          throw err;
        }
        return makeStream([
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
          { type: 'message_stop' },
        ]);
      },
    },
  };

  (provider as unknown as { client: unknown }).client = fakeClient;

  const events: Array<{ type: string; content?: string }> = [];
  for await (const event of provider.stream([{ role: 'user', content: 'hi' }], 'sys', [])) {
    events.push(event as { type: string; content?: string });
  }

  assert.equal(calls, 2);
  assert.equal(sleeps, 1);
  assert.ok(events.some(e => e.type === 'text' && e.content === 'hello'));
  assert.ok(events.some(e => e.type === 'done'));
});

await test('does not retry when 429 occurs after partial output', async () => {
  let calls = 0;
  let sleeps = 0;

  const provider = new AnthropicProvider(
    {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'test-key',
    },
    {
      maxRateLimitRetries: 2,
      defaultRateLimitBackoffMs: 1,
      sleepImpl: async () => { sleeps += 1; },
    },
  );

  const fakeClient = {
    messages: {
      stream: () => {
        calls += 1;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } };
            const err = new Error('rate limited mid-stream');
            (err as Error & { status?: number }).status = 429;
            throw err;
          },
          async finalMessage() {
            return { usage: { input_tokens: 1, output_tokens: 1 } };
          },
        };
      },
    },
  };

  (provider as unknown as { client: unknown }).client = fakeClient;

  const seen: string[] = [];
  await assert.rejects(async () => {
    for await (const event of provider.stream([{ role: 'user', content: 'hi' }], 'sys', [])) {
      seen.push((event as { type: string }).type);
    }
  }, /stream execution/i);

  assert.equal(calls, 1);
  assert.equal(sleeps, 0);
  assert.ok(seen.includes('text'));
});

await test('fails clearly after retry limit is exhausted', async () => {
  let calls = 0;
  let sleeps = 0;

  const provider = new AnthropicProvider(
    {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'test-key',
    },
    {
      maxRateLimitRetries: 1,
      defaultRateLimitBackoffMs: 1,
      sleepImpl: async () => { sleeps += 1; },
    },
  );

  const fakeClient = {
    messages: {
      stream: () => {
        calls += 1;
        const err = new Error('rate limit still hot');
        (err as Error & { status?: number }).status = 429;
        throw err;
      },
    },
  };

  (provider as unknown as { client: unknown }).client = fakeClient;

  await assert.rejects(async () => {
    for await (const _event of provider.stream([{ role: 'user', content: 'hi' }], 'sys', [])) {
      // no-op
    }
  }, /persisted after 1 retry attempt/);

  assert.equal(calls, 2);
  assert.equal(sleeps, 1);
});

if (failures > 0) {
  process.exit(1);
}

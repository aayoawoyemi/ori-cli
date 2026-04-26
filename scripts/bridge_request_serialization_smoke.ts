/**
 * Regression smoke for the walkmode 120s bridge-callback timeout.
 *
 * Failure shape: a Repl exec is running and blocks in a callback primitive
 * (`ask`, `vault`, `fs`, etc.). If TS sends a second top-level bridge request
 * while that exec is pending, body/server.py can preserve FIFO by joining the
 * exec thread before handling the second request. That blocks the body main
 * loop, so callback responses sit unread and the exec times out.
 *
 * This test forces the small version of that race:
 *   1. exec calls ask(..., timeout=2), which blocks in Python.
 *   2. UI resolves ask after 100ms via direct callback response.
 *   3. A concurrent ping() is issued while exec is pending.
 *
 * Pass condition: top-level request serialization in ReplBridge keeps ping
 * queued TS-side until exec finishes, so ask receives its response and stdout
 * contains "ANS ok". Pre-fix, ask timed out and exec returned AskError.
 */
import { ReplBridge } from '../src/repl/bridge.js';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const bridge = new ReplBridge({ timeoutMs: 5_000 });
  await bridge.start();
  bridge.setOnAsk((id) => {
    setTimeout(() => bridge.resolveAsk(id, 'ok'), 100);
  });

  try {
    const execPromise = bridge.exec({
      code: "ans = ask('serialization smoke', timeout=2)\nprint('ANS', ans)",
      timeout_ms: 5_000,
    });

    const pingPromise = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        bridge.ping().then(resolve, () => resolve(false));
      }, 25);
    });

    const result = await withTimeout(execPromise, 10_000, 'exec');
    const pingOk = await withTimeout(pingPromise, 10_000, 'ping');

    assert(!result.exception, `exec should not raise; got ${result.exception}`);
    assert(result.stdout.includes('ANS ok'), `stdout should include ask response; got ${JSON.stringify(result.stdout)}`);
    assert(pingOk, 'concurrent ping should complete after exec');

    console.log('OK bridge request serialization');
  } finally {
    await bridge.shutdown();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

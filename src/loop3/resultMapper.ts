import type { ReplResult } from '../repl/types.js';
import type { ExecutionResult } from './types.js';

export function mapReplResultToExecution(result: ReplResult): ExecutionResult {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exception: result.exception,
    rejectedReason: result.rejected?.reason ?? null,
    timedOut: result.timed_out,
    durationMs: result.duration_ms,
    sayTexts: result.say_texts ?? [],
    doneValue: result.done?.value,
    runtime: result.runtime,
  };
}

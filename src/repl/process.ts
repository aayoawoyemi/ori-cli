/**
 * OS-level subprocess manager for the Python REPL body.
 *
 * Responsibilities:
 *   - spawn the Python server process
 *   - read stdout line-by-line (each line is one JSON-RPC response)
 *   - read stderr for startup signal and diagnostics
 *   - handle unexpected exit
 *   - graceful shutdown (shutdown op → wait → SIGKILL)
 */
import { spawn, ChildProcess } from 'node:child_process';
import { createInterface, Interface } from 'node:readline';

export type OnLine = (line: string) => void;
export type OnExit = (code: number | null, signal: NodeJS.Signals | null) => void;
export type OnStderr = (line: string) => void;

export interface ProcessOptions {
  pythonCmd: string;
  serverPath: string;
  onLine: OnLine;
  onExit: OnExit;
  onStderr?: OnStderr;
  /** String to match in stderr to consider the process ready. */
  readySignal?: string;
  /** Max time to wait for ready signal before failing. */
  readyTimeoutMs?: number;
}

export class ReplProcess {
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  private stderrRl: Interface | null = null;
  private exited = false;

  constructor(private opts: ProcessOptions) {}

  async start(): Promise<void> {
    if (this.proc) {
      throw new Error('process already started');
    }

    const readySignal = this.opts.readySignal ?? '[body] ready';
    const readyTimeoutMs = this.opts.readyTimeoutMs ?? 10_000;

    this.exited = false;
    this.proc = spawn(this.opts.pythonCmd, [this.opts.serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.rl = createInterface({
      input: this.proc.stdout!,
      crlfDelay: Infinity,
    });
    this.rl.on('line', this.opts.onLine);

    const readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`python body did not signal ready within ${readyTimeoutMs}ms`));
      }, readyTimeoutMs);

      this.stderrRl = createInterface({
        input: this.proc!.stderr!,
        crlfDelay: Infinity,
      });
      this.stderrRl.on('line', (line) => {
        if (line.includes(readySignal)) {
          clearTimeout(timer);
          resolve();
        }
        this.opts.onStderr?.(line);
      });

      this.proc!.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      this.proc!.on('exit', (code, signal) => {
        this.exited = true;
        clearTimeout(timer);
        this.opts.onExit(code, signal);
        if (!this.proc?.stdout?.readable) {
          // exited before ready
          reject(new Error(`python body exited before ready: code=${code} signal=${signal}`));
        }
      });
    });

    return readyPromise;
  }

  write(line: string): boolean {
    if (!this.proc?.stdin || this.exited) return false;
    return this.proc.stdin.write(line + '\n');
  }

  isAlive(): boolean {
    return this.proc !== null && !this.exited && !this.proc.killed;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.proc?.kill(signal);
  }

  /**
   * Send shutdown op, wait for graceful exit, then SIGKILL if still alive.
   */
  async shutdown(gracefulMs: number = 2000): Promise<void> {
    if (!this.proc || this.exited) return;

    // Request graceful shutdown
    this.write(JSON.stringify({ op: 'shutdown' }));

    // Wait for exit or force-kill
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.isAlive()) this.kill('SIGKILL');
      }, gracefulMs);

      if (this.exited) {
        clearTimeout(timer);
        resolve();
        return;
      }

      this.proc!.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

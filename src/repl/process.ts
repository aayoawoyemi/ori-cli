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
  /**
   * Working directory to spawn the body in. Controls body/fs.py's local
   * read resolution (_local_read uses pathlib.resolve() which is cwd-
   * relative). When omitted, body inherits this Node process's cwd —
   * fragile when the TS side's cwd drifts from the user's "project" root.
   * A10 caught this: body read brain/package.json because the TS parent's
   * cwd was brain while the user expected aries-cli. Always pass this
   * from setupReplBridge so body's cwd matches the harness's intent.
   */
  cwd?: string;
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
    // Batch 3.5 (2026-04-25) — keep stdio unbuffered in the live bridge path.
    // The standalone substrate smoke already launches body/server.py with
    // `-u`; production should not be weaker than the test harness. The main
    // Opus walkmode timeout fix is request serialization in bridge.ts plus
    // rlm_call deadlines in body/rlm.py, but unbuffered stdio removes a second
    // Windows pipe variable from the bridge-callback path.
    this.proc = spawn(this.opts.pythonCmd, ['-u', this.opts.serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: this.opts.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
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

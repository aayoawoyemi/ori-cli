/**
 * Minimal TS ↔ Python bridge for the spike.
 * Spawns body/server.py, sends JSON-RPC over stdin, reads JSON response from stdout.
 */
import { spawn, ChildProcess } from "child_process";
import { createInterface, Interface } from "readline";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ExecResult {
  stdout: string;
  stderr: string;
  exception: string | null;
  duration_ms: number;
  rlm_stats: {
    call_count: number;
    total_tokens: number;
    calls: Array<{ question: string; input_tokens: number; output_tokens: number }>;
  };
}

export class ReplBridge {
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  private ready: Promise<void>;
  private pending: Array<(msg: any) => void> = [];

  constructor(private serverPath: string = resolve(__dirname, "body/server.py")) {
    this.ready = this.start();
  }

  private start(): Promise<void> {
    return new Promise((resolveStart, rejectStart) => {
      const pythonCmd = process.platform === "win32" ? "python" : "python3";
      this.proc = spawn(pythonCmd, [this.serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.proc.stderr?.on("data", (chunk) => {
        const msg = chunk.toString();
        process.stderr.write(`[body:stderr] ${msg}`);
        if (msg.includes("[body] loaded graph")) {
          resolveStart();
        }
      });

      this.proc.on("error", (err) => {
        console.error("[bridge] spawn error:", err);
        rejectStart(err);
      });

      this.proc.on("exit", (code) => {
        console.error(`[bridge] python exited with code ${code}`);
      });

      this.rl = createInterface({
        input: this.proc.stdout!,
        crlfDelay: Infinity,
      });

      this.rl.on("line", (line) => {
        const waiter = this.pending.shift();
        if (waiter) {
          try {
            waiter(JSON.parse(line));
          } catch (e) {
            console.error("[bridge] bad json from body:", line);
          }
        }
      });
    });
  }

  private send(msg: object): Promise<any> {
    return new Promise((resolvePromise) => {
      this.pending.push(resolvePromise);
      this.proc?.stdin?.write(JSON.stringify(msg) + "\n");
    });
  }

  async waitReady(): Promise<void> {
    return this.ready;
  }

  async ping(): Promise<boolean> {
    const r = await this.send({ op: "ping" });
    return r.pong === true;
  }

  async exec(code: string): Promise<ExecResult> {
    return this.send({ op: "exec", code });
  }

  shutdown(): void {
    this.proc?.stdin?.write(JSON.stringify({ op: "shutdown" }) + "\n");
    this.proc?.kill();
  }
}

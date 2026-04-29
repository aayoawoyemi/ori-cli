/**
 * Degradation curve for ori_orient + ori_warmth against ~/brain.
 *
 * Hypothesis-tree we're testing:
 *   H1 (state-accumulation): a single long-running ori subprocess gets
 *       slower per-call as it processes more queries — so the curve rises
 *       monotonically.
 *   H2 (cold-vs-warm): the first call pays a one-time cost (graph build,
 *       embedding pipeline init) and subsequent calls stay flat.
 *   H3 (zombie-WAL-contention): multiple co-existing ori subprocesses pin
 *       different WAL read marks → WAL grows unbounded → per-call cost
 *       drifts up because the WAL grows during the test.
 *
 * What this test does:
 *   - Bypasses the aries bridge/body entirely (talks to ori-memory MCP
 *     directly via OriVault). The bridge isn't suspected; we want to
 *     isolate ori-memory's behavior.
 *   - Spawns ONE fresh ori subprocess connected to ~/brain (the slow vault).
 *   - Issues N pairs of (ori_orient, ori_warmth), measuring each call.
 *   - Samples WAL size and the subprocess RSS at intervals.
 *   - Prints a table + flags any monotonic trend.
 *
 * Run with:   npx tsx bench/recovery/orient-degradation.ts [N]
 *   N defaults to 30. Set RSS_PID externally if you want to track an
 *   already-running subprocess instead of spawning a fresh one.
 */
import { OriVault } from '../../src/memory/vault.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const N = Number(process.argv[2] ?? 30);
const VAULT = join(homedir(), 'brain');
const WAL = join(VAULT, '.ori', 'embeddings.db-wal');
const DB = join(VAULT, '.ori', 'embeddings.db');

interface Sample {
  i: number;
  orientMs: number;
  warmthMs: number;
  walMb: number;
  dbMb: number;
}

function fileMb(p: string): number {
  try { return statSync(p).size / 1024 / 1024; } catch { return -1; }
}

// Get RSS of a PID via PowerShell (Windows-friendly). Returns MB or -1.
function rssMb(pid: number): number {
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`,
    ], { encoding: 'utf-8' });
    const v = parseInt((r.stdout || '').trim(), 10);
    return Number.isFinite(v) ? v / 1024 / 1024 : -1;
  } catch { return -1; }
}

function countOriProcesses(): number {
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'ori-memory|ori\\\\dist|--mcp' }).Count`,
    ], { encoding: 'utf-8' });
    return parseInt((r.stdout || '').trim(), 10) || -1;
  } catch { return -1; }
}

async function timeMs<T>(fn: () => Promise<T>): Promise<{ ms: number; result: T }> {
  const t0 = Date.now();
  const result = await fn();
  return { ms: Date.now() - t0, result };
}

async function main(): Promise<void> {
  console.log(`[degradation] vault=${VAULT}  N=${N}`);
  console.log(`[degradation] db=${fileMb(DB).toFixed(1)}MB  wal=${fileMb(WAL).toFixed(1)}MB  ori-processes-alive=${countOriProcesses()}`);

  // OriVault.connect() spawns ori-memory serve --mcp as a subprocess and
  // does the JSON-RPC handshake. After this returns we have a dedicated
  // subprocess — we need its PID to track RSS, but the McpClient hides
  // it. Workaround: pre-count, post-count, infer.
  const before = countOriProcesses();
  const v = new OriVault(VAULT);
  await v.connect();
  const after = countOriProcesses();
  console.log(`[degradation] spawned 1 subprocess (was ${before}, now ${after})`);

  // Reach into the private McpClient to find OUR subprocess PID.
  // Hack: cast through unknown to get at .client.proc.pid.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const myPid: number | undefined = (v as any).client?.proc?.pid;
  console.log(`[degradation] my pid=${myPid ?? '?'}  rss=${myPid ? rssMb(myPid).toFixed(1) : '?'}MB`);

  const samples: Sample[] = [];

  for (let i = 0; i < N; i++) {
    const orient = await timeMs(() => v.callTool('ori_orient', { brief: true }));
    const warmth = await timeMs(() => v.callTool('ori_warmth', {
      query: 'active projects tasks pending',
      limit: 5,
    }));
    samples.push({
      i,
      orientMs: orient.ms,
      warmthMs: warmth.ms,
      walMb: fileMb(WAL),
      dbMb: fileMb(DB),
    });

    // Print live every call so we can watch the curve build
    const rss = myPid ? rssMb(myPid) : -1;
    console.log(`  [${String(i).padStart(3)}] orient=${String(orient.ms).padStart(6)}ms  warmth=${String(warmth.ms).padStart(6)}ms  wal=${samples[i].walMb.toFixed(1)}MB  rss=${rss.toFixed(0)}MB`);
  }

  // ── Analysis ──
  console.log('\n[degradation] === analysis ===');
  const orients = samples.map(s => s.orientMs);
  const warmths = samples.map(s => s.warmthMs);

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const firstHalfO = mean(orients.slice(0, Math.floor(N / 2)));
  const secondHalfO = mean(orients.slice(Math.ceil(N / 2)));
  const firstHalfW = mean(warmths.slice(0, Math.floor(N / 2)));
  const secondHalfW = mean(warmths.slice(Math.ceil(N / 2)));

  console.log(`  orient: cold=${orients[0]}ms  median=${median(orients)}ms  mean=${mean(orients).toFixed(0)}ms`);
  console.log(`          first-half-mean=${firstHalfO.toFixed(0)}ms  second-half-mean=${secondHalfO.toFixed(0)}ms  drift=${((secondHalfO - firstHalfO) / firstHalfO * 100).toFixed(1)}%`);
  console.log(`  warmth: cold=${warmths[0]}ms  median=${median(warmths)}ms  mean=${mean(warmths).toFixed(0)}ms`);
  console.log(`          first-half-mean=${firstHalfW.toFixed(0)}ms  second-half-mean=${secondHalfW.toFixed(0)}ms  drift=${((secondHalfW - firstHalfW) / firstHalfW * 100).toFixed(1)}%`);
  console.log(`  wal: start=${samples[0].walMb.toFixed(1)}MB  end=${samples[N - 1].walMb.toFixed(1)}MB  delta=${(samples[N - 1].walMb - samples[0].walMb).toFixed(1)}MB`);

  // Heuristic verdict
  const orientDrift = (secondHalfO - firstHalfO) / firstHalfO;
  const warmthDrift = (secondHalfW - firstHalfW) / firstHalfW;
  if (orientDrift > 0.3 || warmthDrift > 0.3) {
    console.log(`\n  VERDICT: monotonic-drift detected (>30%). State accumulation is real.`);
  } else if (Math.max(...orients) > 5 * median(orients) || Math.max(...warmths) > 5 * median(warmths)) {
    console.log(`\n  VERDICT: spiky outliers, no monotonic drift. GC pauses or contention bursts.`);
  } else {
    console.log(`\n  VERDICT: flat curve. Single-subprocess steady-state is fine. Slowness must come from elsewhere (zombies? bridge?).`);
  }

  v.disconnect();
  // Give the disconnect timeout 2s to fire before exiting
  await new Promise(r => setTimeout(r, 2500));
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});

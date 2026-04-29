/**
 * Mixed-workload degradation test. Read-only orient stayed flat at 30ms in
 * orient-degradation.ts — ruling out pure-read state accumulation. But the
 * user's live session is write-heavy: search/warmth queries trigger
 * Q-value updates, co-occurrence pair recording, stage learning, reward
 * accumulator growth. Maybe it's the WRITE path that degrades.
 *
 * This test cycles search → warmth → orient over many iterations and
 * tracks whether orient slows down as accumulated session state grows.
 *
 * Run with:   npx tsx bench/recovery/orient-mixed.ts [N]
 */
import { OriVault } from '../../src/memory/vault.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const N = Number(process.argv[2] ?? 50);
const VAULT = join(homedir(), 'brain');
const WAL = join(VAULT, '.ori', 'embeddings.db-wal');
const DB = join(VAULT, '.ori', 'embeddings.db');

function fileMb(p: string): number {
  try { return statSync(p).size / 1024 / 1024; } catch { return -1; }
}

function rssMb(pid: number): number {
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`,
    ], { encoding: 'utf-8' });
    const v = parseInt((r.stdout || '').trim(), 10);
    return Number.isFinite(v) ? v / 1024 / 1024 : -1;
  } catch { return -1; }
}

async function timeMs<T>(fn: () => Promise<T>): Promise<{ ms: number }> {
  const t0 = Date.now();
  await fn();
  return { ms: Date.now() - t0 };
}

// A handful of varied queries — keeps the workload realistic, exercises
// different code paths in the engine (intent classifier, ranking, etc.)
const QUERIES = [
  'active projects tasks pending',
  'aries cli session degradation',
  'memory recall warm context',
  'recent decisions trade-offs',
  'codemode subagent capture',
  'bridge restart heartbeat protocol',
  'vault scaffold project layer',
  'embedding pipeline initialization',
  'q-value reward shaping',
  'graph community detection',
];

async function main(): Promise<void> {
  console.log(`[mixed] vault=${VAULT}  N=${N}`);
  console.log(`[mixed] db=${fileMb(DB).toFixed(1)}MB  wal=${fileMb(WAL).toFixed(1)}MB`);

  const v = new OriVault(VAULT);
  await v.connect();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const myPid: number | undefined = (v as any).client?.proc?.pid;
  console.log(`[mixed] my pid=${myPid ?? '?'}  rss=${myPid ? rssMb(myPid).toFixed(1) : '?'}MB`);

  const orientLatencies: number[] = [];
  const warmthLatencies: number[] = [];
  const searchLatencies: number[] = [];

  for (let i = 0; i < N; i++) {
    const q = QUERIES[i % QUERIES.length];
    const search = await timeMs(() => v.callTool('ori_query_ranked', { query: q, limit: 5, include_archived: false }));
    const warmth = await timeMs(() => v.callTool('ori_warmth', { query: q, limit: 5 }));
    const orient = await timeMs(() => v.callTool('ori_orient', { brief: true }));

    searchLatencies.push(search.ms);
    warmthLatencies.push(warmth.ms);
    orientLatencies.push(orient.ms);

    if (i % 5 === 0 || i === N - 1) {
      const rss = myPid ? rssMb(myPid) : -1;
      console.log(`  [${String(i).padStart(3)}] search=${String(search.ms).padStart(5)}ms  warmth=${String(warmth.ms).padStart(5)}ms  orient=${String(orient.ms).padStart(5)}ms  wal=${fileMb(WAL).toFixed(1)}MB  rss=${rss.toFixed(0)}MB`);
    }
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  console.log('\n[mixed] === analysis ===');
  for (const [label, xs] of [['orient', orientLatencies], ['warmth', warmthLatencies], ['search', searchLatencies]] as const) {
    const half = Math.floor(N / 2);
    const fh = mean(xs.slice(0, half));
    const sh = mean(xs.slice(N - half));
    const drift = (sh - fh) / fh;
    console.log(`  ${label.padEnd(7)} cold=${xs[0]}ms  median=${median(xs)}ms  first-half=${fh.toFixed(0)}ms  second-half=${sh.toFixed(0)}ms  drift=${(drift * 100).toFixed(0)}%  max=${Math.max(...xs)}ms`);
  }
  console.log(`  wal: start→end ${fileMb(WAL).toFixed(1)}MB  rss=${myPid ? rssMb(myPid).toFixed(0) : '?'}MB`);

  v.disconnect();
  await new Promise(r => setTimeout(r, 2500));
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});

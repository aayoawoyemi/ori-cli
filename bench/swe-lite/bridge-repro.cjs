/**
 * Reproduce the bridge timeout outside the agent loop.
 *
 * Spawns the body server via the SAME setupReplBridge the runner uses,
 * fires the exact shape of exec request that triggered the 120s timeouts
 * during the bench (fs.read large file + done in same batch), and
 * instruments timing on every JSON line crossing the bridge.
 *
 * If the timeout reproduces here, the bug is in the bridge transport (not
 * the agent loop, not the model). If it doesn't reproduce, the bug
 * involves something else the agent does — overlapping requests, a
 * concurrent vault op, etc.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const REPO = path.resolve(__dirname, '..', '..');
const BODY = path.resolve(REPO, 'body', 'server.py');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

// Pick the largest test target we can — the pytest-7220 file at the
// commit pinned in the bench. Falls back to aries' own loop.ts (also
// large) if the workspace isn't there.
let TARGET = path.resolve(REPO, 'src', 'loop.ts');
const wsParent = path.join(__dirname, 'workspaces', 'pytest-dev__pytest-7220');
if (fs.existsSync(wsParent)) {
  const dirs = fs.readdirSync(wsParent).map((n) => path.join(wsParent, n)).filter((p) => fs.statSync(p).isDirectory());
  dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (dirs[0]) {
    const candidate = path.join(dirs[0], 'repo', 'src', '_pytest', '_code', 'code.py');
    if (fs.existsSync(candidate)) TARGET = candidate;
  }
}

console.log('repro target file:', TARGET);
console.log('size:', fs.statSync(TARGET).size, 'bytes');
console.log('body server:', BODY);
console.log();

const t0 = Date.now();
const ts = () => `t+${(Date.now() - t0).toString().padStart(6)}ms`;

const proc = spawn(PYTHON, ['-u', BODY], {
  cwd: path.dirname(TARGET),
  env: { ...process.env, PYTHONUNBUFFERED: '1' },
});

let stdoutBuf = '';
let pending = null;
let bytesIn = 0;
let bytesOut = 0;

proc.stdout.on('data', (chunk) => {
  bytesIn += chunk.length;
  stdoutBuf += chunk.toString('utf8');
  let nl;
  while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, nl);
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      const keys = Object.keys(msg);
      console.log(`${ts()} [stdout ${chunk.length}B → line ${line.length}B] keys=[${keys.join(',')}]`);
      // Resolve pending if it's a normal response (not a callback)
      const callbackKeys = ['vault_request', 'research_request', 'fs_request', 'shell_request', 'web_request', 'say', 'ask_request'];
      // `done` is a callback ONLY when it's standalone — the exec result
      // envelope also has a `done` field. Mirror the fix in bridge.ts.
      const isStandaloneDone = 'done' in msg && msg.stdout === undefined && msg.duration_ms === undefined && msg.exception === undefined;
      if (!callbackKeys.some((k) => k in msg) && !isStandaloneDone) {
        if (pending) {
          const p = pending; pending = null;
          p.resolve(msg);
        }
      } else {
        console.log(`${ts()}   (callback, exec still running)`);
      }
    } catch (err) {
      console.log(`${ts()} [bad json] ${line.slice(0, 80)}`);
    }
  }
});

proc.stderr.on('data', (chunk) => {
  const text = chunk.toString('utf8').trim();
  if (text) console.log(`${ts()} [stderr] ${text}`);
});

proc.on('exit', (code, signal) => {
  console.log(`${ts()} [body exit] code=${code} signal=${signal}`);
});

function send(msg, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(msg) + '\n';
    bytesOut += payload.length;
    console.log(`${ts()} [stdin ${payload.length}B] op=${msg.op || '?'}`);
    pending = { resolve, reject };
    proc.stdin.write(payload);
    setTimeout(() => {
      if (pending && pending.resolve === resolve) {
        pending = null;
        reject(new Error(`bridge timeout after ${timeoutMs}ms (bytesIn=${bytesIn}, bytesOut=${bytesOut})`));
      }
    }, timeoutMs);
  });
}

(async () => {
  // Wait for body ready
  await new Promise((r) => setTimeout(r, 1000));
  console.log(`${ts()} sending configure`);
  await send({ op: 'configure', project: path.dirname(TARGET), vaultGlobal: null, vaultProject: null, mode: 'project+vault', shell: 'cmd.exe' }, 10_000);

  console.log(`${ts()} sending exec (the timeout-prone shape)`);
  const code = `\
content = fs.read(${JSON.stringify(TARGET)})
lines = content.split('\\n')
print('lines:', len(lines))
done({'file': ${JSON.stringify(TARGET)}, 'lines': len(lines)})
`;
  try {
    const r = await send({
      op: 'exec',
      code,
      timeout_ms: 30000,
      plan: 'reproduction harness — fs.read a large file then done()',
      operations: [
        { purpose: 'fs.read big file then commit', code },
      ],
    }, 15_000);
    console.log(`${ts()} EXEC RESULT keys:`, Object.keys(r).join(','));
    console.log('  stdout:', (r.stdout || '').slice(0, 200));
    console.log('  done:', JSON.stringify(r.done).slice(0, 200));
  } catch (err) {
    console.log(`${ts()} ${err.message}`);
  }

  proc.stdin.write(JSON.stringify({ op: 'shutdown' }) + '\n');
  setTimeout(() => proc.kill('SIGKILL'), 2000);
})();

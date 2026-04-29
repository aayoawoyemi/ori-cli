const fs = require('fs');
const path = require('path');

const taskId = process.argv[2];
if (!taskId) { console.error('usage: find-session.cjs <task_id>'); process.exit(1); }

let candidates = [];
const root = 'C:/Users/aayoa/.aries/sessions/';
for (const dir of fs.readdirSync(root)) {
  const fullDir = path.join(root, dir);
  let isDir = false;
  try { isDir = fs.statSync(fullDir).isDirectory(); } catch { continue; }
  if (!isDir) continue;
  for (const f of fs.readdirSync(fullDir)) {
    if (!f.endsWith('.jsonl')) continue;
    const p = path.join(fullDir, f);
    const content = fs.readFileSync(p, 'utf8');
    if (content.includes(taskId)) {
      candidates.push({path: p, mtime: fs.statSync(p).mtimeMs, size: fs.statSync(p).size});
    }
  }
}
candidates.sort((a, b) => b.mtime - a.mtime);
if (candidates.length === 0) { console.log('NONE FOUND for', taskId); process.exit(0); }
const file = candidates[0].path;
console.log('using:', file);
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
let usage = { i: 0, cr: 0, cw: 0, o: 0 };
let calls = 0;
for (const l of lines) {
  if (l.type === 'usage') {
    usage.i += l.inputTokens || 0;
    usage.cr += l.cacheReadTokens || 0;
    usage.cw += l.cacheWriteTokens || 0;
    usage.o += l.outputTokens || 0;
  }
  if (l.type === 'tool_call') calls++;
}
console.log('events:', lines.length);
console.log('input:', usage.i, 'cacheR:', usage.cr, 'cacheW:', usage.cw, 'output:', usage.o);
console.log('total tokens:', usage.i + usage.cr + usage.cw + usage.o, 'tool_calls:', calls);
// Sonnet 4.6 pricing: input $3/MTok, cache_read $0.30/MTok, cache_write $3.75/MTok, output $15/MTok
const cost = (usage.i * 3 + usage.cr * 0.30 + usage.cw * 3.75 + usage.o * 15) / 1_000_000;
console.log('approx cost (Sonnet 4.6): $' + cost.toFixed(4));

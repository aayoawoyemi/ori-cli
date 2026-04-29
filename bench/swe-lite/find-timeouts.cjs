const fs = require('fs');
const sessionPath = process.argv[2];
const lines = fs.readFileSync(sessionPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (l.type !== 'tool_result') continue;
  if (!/bridge request timed out after 120000ms/.test(l.output || '')) continue;
  for (let j = i - 1; j >= 0 && j > i - 12; j--) {
    if (lines[j].type === 'tool_call' && lines[j].id === l.id) {
      const tc = lines[j];
      if (Array.isArray(tc.input?.operations)) {
        console.log('=== TIMEOUT, ops in the call ===');
        for (const op of tc.input.operations) {
          console.log('  PURPOSE:', op.purpose);
          console.log('  CODE   :', (op.code || '').slice(0, 300).replace(/\n/g, ' '));
        }
      }
      break;
    }
  }
}

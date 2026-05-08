import assert from 'node:assert/strict';
import { extractCodeCells } from '../src/loop/codeExtractor.js';

let failures = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

await test('extracts one python fence', () => {
  const result = extractCodeCells('```py\nx = 1\n```');
  assert.equal(result.cells.length, 1);
  assert.equal(result.cells[0].code.trim(), 'x = 1');
  assert.deepEqual(result.notes, []);
});

await test('extracts multiple python fences', () => {
  const result = extractCodeCells('```py\na = 1\n```\n\n```python\nb = 2\n```');
  assert.equal(result.cells.length, 2);
  assert.equal(result.cells[0].index, 1);
  assert.equal(result.cells[1].index, 2);
});

await test('parses id and timeout metadata', () => {
  const result = extractCodeCells('```py id="inspect" t="15s"\nprint("ok")\n```');
  assert.equal(result.cells.length, 1);
  assert.equal(result.cells[0].id, 'inspect');
  assert.equal(result.cells[0].timeoutMs, 15_000);
});

await test('accepts rst=true without parse error', () => {
  const result = extractCodeCells('```py id="reset" rst=true\nx = 1\n```');
  assert.equal(result.cells.length, 1);
  assert.equal(result.cells[0].reset, true);
  assert.deepEqual(result.notes, []);
});

await test('ignores unsupported fences without corrective notes', () => {
  const result = extractCodeCells('```typescript\nconst x = 1;\n```');
  assert.equal(result.cells.length, 0);
  assert.deepEqual(result.notes, []);
  assert.equal(result.hasAnyFence, true);
});

await test('handles unclosed fence', () => {
  const result = extractCodeCells('```py\nx = 1');
  assert.equal(result.cells.length, 0);
  assert.ok(result.notes.some((n) => n.includes('unclosed code fence')));
});

await test('reports no fence for plain assistant text', () => {
  const result = extractCodeCells('All done. Here is the answer.');
  assert.equal(result.cells.length, 0);
  assert.equal(result.hasAnyFence, false);
  assert.deepEqual(result.notes, []);
});

if (failures > 0) {
  process.exit(1);
}

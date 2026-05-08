import assert from 'node:assert/strict';
import { formatExecutionResult } from '../src/loop/resultFormatter.js';

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

const baseCell = {
  index: 1,
  language: 'py' as const,
  code: 'x = 1',
  reset: false,
};

await test('formats say, done, stderr, exception, rejection, timeout and debug stdout', () => {
  const prev = process.env.ARIES_CODE_DEBUG_STDOUT_CHARS;
  process.env.ARIES_CODE_DEBUG_STDOUT_CHARS = '4';
  try {
    const formatted = formatExecutionResult({
      notes: [],
      cells: [
        {
          cell: { ...baseCell, id: 'ok' },
          stdout: 'abcdef',
          stderr: 'warn',
          exception: null,
          rejectedReason: null,
          timedOut: false,
          durationMs: 7,
          sayTexts: ['hello'],
          doneValue: { ok: true },
        },
        {
          cell: { ...baseCell, index: 2, id: 'bad' },
          stdout: '',
          stderr: '',
          exception: 'traceback',
          rejectedReason: 'blocked',
          timedOut: true,
          durationMs: 2,
          sayTexts: [],
        },
      ],
    });

    assert.equal(formatted.status, 'error');
    assert.ok(formatted.xml.includes('<say>hello</say>'));
    assert.ok(formatted.xml.includes('<done>{'));
    assert.ok(formatted.xml.includes('<stderr>warn</stderr>'));
    assert.ok(formatted.xml.includes('<exception>traceback</exception>'));
    assert.ok(formatted.xml.includes('<rejected>blocked</rejected>'));
    assert.ok(formatted.xml.includes('<timeout>true</timeout>'));
    assert.ok(formatted.xml.includes('<stdout_debug>cdef</stdout_debug>'));
  } finally {
    if (prev === undefined) {
      delete process.env.ARIES_CODE_DEBUG_STDOUT_CHARS;
    } else {
      process.env.ARIES_CODE_DEBUG_STDOUT_CHARS = prev;
    }
  }
});

await test('formats parse-note-only result', () => {
  const formatted = formatExecutionResult({
    notes: ['ignored non-Python fence; emit `py`.'],
    cells: [],
  });
  assert.equal(formatted.status, 'note');
  assert.ok(formatted.xml.includes('<note>ignored non-Python fence; emit `py`.</note>'));
});

if (failures > 0) {
  process.exit(1);
}

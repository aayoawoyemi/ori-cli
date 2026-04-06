/**
 * Phase 1 — AST guard tests (body/security.py).
 *
 * Verifies that the AST pre-pass rejects escape routes before exec runs.
 *
 * Run: npx tsx test/repl/security.test.ts
 */
import { ReplBridge } from '../../src/repl/bridge.js';

interface Case {
  name: string;
  code: string;
  expectRejected: boolean;
}

const CASES: Case[] = [
  // --- should be REJECTED ---
  { name: 'import os', code: 'import os', expectRejected: true },
  { name: 'from os import path', code: 'from os import path', expectRejected: true },
  { name: '__class__ attribute', code: "x = ().__class__", expectRejected: true },
  { name: '__subclasses__', code: "x = ().__class__.__bases__[0].__subclasses__()", expectRejected: true },
  { name: '__mro__', code: "x = ().__class__.__mro__", expectRejected: true },
  { name: '__bases__', code: "x = ().__class__.__bases__", expectRejected: true },
  { name: '__builtins__ attribute', code: "x = print.__globals__['__builtins__']", expectRejected: true },
  { name: 'eval', code: "x = eval('1+1')", expectRejected: true },
  { name: 'exec', code: "exec('print(1)')", expectRejected: true },
  { name: 'compile', code: "c = compile('1', '<s>', 'eval')", expectRejected: true },
  { name: 'open', code: "f = open('/etc/passwd')", expectRejected: true },
  { name: '__import__', code: "os = __import__('os')", expectRejected: true },
  { name: 'getattr', code: "x = getattr(1, 'real')", expectRejected: true },
  { name: 'globals', code: "g = globals()", expectRejected: true },

  // --- should be ALLOWED ---
  { name: 'print hello', code: "print('hello')", expectRejected: false },
  { name: 'arithmetic', code: "x = 1 + 2; print(x)", expectRejected: false },
  { name: 'list comp', code: "print([i*i for i in range(5)])", expectRejected: false },
  { name: 'dict ops', code: "d = {'a': 1}; d['b'] = 2; print(sorted(d.items()))", expectRejected: false },
  { name: 'try/except', code: "try:\n  x = 1/0\nexcept ZeroDivisionError:\n  print('caught')", expectRejected: false },
  { name: 'function def', code: "def f(x):\n  return x*2\nprint(f(3))", expectRejected: false },
  { name: 'class def', code: "class Foo:\n  def bar(self):\n    return 42\nprint(Foo().bar())", expectRejected: false },
];

async function main() {
  const bridge = new ReplBridge();
  await bridge.start();

  let passed = 0;
  let failed = 0;

  for (const c of CASES) {
    const result = await bridge.exec({ code: c.code });
    const wasRejected = result.rejected !== null;
    const ok = wasRejected === c.expectRejected;

    const verdict = ok ? 'PASS' : 'FAIL';
    const status = wasRejected ? `rejected: ${result.rejected?.reason}` : (result.exception ? `raised: ${result.exception.split('\n')[0]}` : 'ok');
    console.log(`  ${verdict}  ${c.name.padEnd(28)}  ${status}`);

    if (ok) passed++;
    else failed++;
  }

  await bridge.shutdown();

  console.log('');
  console.log(`${passed}/${CASES.length} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});

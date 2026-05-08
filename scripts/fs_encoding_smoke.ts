import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ReplBridge } from '../src/repl/bridge.js';

const sample = [
  'Encoding smoke',
  'em dash: —',
  'arrow: →',
  'multiply: ×',
  'greek: μνήμος νοῦς',
  'mojibake sentinels: â€” â†’ Ã—',
].join('\n') + '\n';

const path = '.aries/tmp/fs-encoding-smoke.md';

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

async function main() {
  const bridge = new ReplBridge({
    timeoutMs: 30_000,
    onEvent: () => {},
  });

  await bridge.start();
  try {
    const code = `
content = ${JSON.stringify(sample)}
fs.write(${JSON.stringify(path)}, content)
roundtrip = fs.read(${JSON.stringify(path)})
done({"roundtrip": roundtrip, "matches": roundtrip == content})
`;

    const result = await bridge.exec({ code, timeout_ms: 30_000 });
    if (result.rejected) fail(`rejected: ${result.rejected.reason}`);
    if (result.exception) fail(`exception: ${result.exception}`);
    if (result.timed_out) fail('timed out');

    const done = result.done?.value as { roundtrip?: string; matches?: boolean } | undefined;
    if (!done?.matches) {
      fail(`fs.read roundtrip mismatch: ${JSON.stringify(done)}`);
    }

    const abs = join(process.cwd(), path);
    const bytes = readFileSync(abs);
    const expected = Buffer.from(sample, 'utf8');
    if (!bytes.equals(expected)) {
      fail(`disk bytes mismatch\nexpected=${expected.toString('hex')}\nactual=${bytes.toString('hex')}`);
    }

    const text = bytes.toString('utf8');
    if (!text.includes('—') || !text.includes('→') || !text.includes('×') || !text.includes('μνήμος')) {
      fail(`utf8 decoded text missing expected chars: ${JSON.stringify(text)}`);
    }
    if (!text.includes('â€”')) {
      fail('sentinel mojibake text did not round-trip literally');
    }

    console.log('PASS fs.write/fs.read UTF-8 roundtrip');
    console.log(`bytes=${bytes.length}`);
  } finally {
    await bridge.shutdown().catch(() => {});
    rmSync(join(process.cwd(), path), { force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// File: scripts/fs_paths_bridge_smoke.ts
// Purpose: Bridge-side fs path semantics tests. Covers write/edit behavior
//   that can only be tested through the TS bridge: parent directory creation,
//   non-ASCII filenames through the RPC layer, relative path handling in write/edit.
// Hand-runnable: npx tsx scripts/fs_paths_bridge_smoke.ts

import { rmSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReplBridge } from '../src/repl/bridge.js';

const TMP_DIR = '.aries/tmp/fs-paths-bridge';

let pass_count = 0;
let fail_count = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  PASS  ${name}${detail ? ` - ${detail}` : ''}`);
    pass_count++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
    fail_count++;
  }
}

function fail(message: string): never {
  console.error(`FATAL ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const bridge = new ReplBridge({
    timeoutMs: 30_000,
    onEvent: () => {},
  });

  await bridge.start();
  try {
    // -- Test: fs.write creates missing parent directories -----------------
    console.log('\n[fs.write - missing parent dirs]');
    {
      const code = `
path = "${TMP_DIR}/deep/nested/dir/file.txt"
result = fs.write(path, "created through missing parents\\n")
done({"result": result})
`;
      const r = await bridge.exec({ code, timeout_ms: 15_000 });
      if (r.exception) fail(`write missing parents exception: ${r.exception}`);
      const value = r.done?.value as Record<string, unknown> | undefined;
      check('write creates parent dirs', value?.result != null && (value.result as any).ok === true,
        JSON.stringify(value?.result));
      // Verify file exists on disk
      const abs = join(process.cwd(), TMP_DIR, 'deep/nested/dir/file.txt');
      check('file exists after write', existsSync(abs), abs);
      if (existsSync(abs)) {
        const content = readFileSync(abs, 'utf-8');
        check('file content correct', content === 'created through missing parents\n', content);
      }
    }

    // -- Test: fs.write with relative path --------------------------------
    console.log('\n[fs.write - relative path]');
    {
      const code = `
path = "${TMP_DIR}/relative-test.txt"
result = fs.write(path, "relative path write\\n")
readback = fs.read(path)
done({"ok": result.get("ok"), "matches": readback == "relative path write\\n"})
`;
      const r = await bridge.exec({ code, timeout_ms: 15_000 });
      if (r.exception) fail(`write relative exception: ${r.exception}`);
      const value = r.done?.value as Record<string, unknown> | undefined;
      check('write relative path ok', value?.ok === true, JSON.stringify(value));
      check('read back matches', value?.matches === true, JSON.stringify(value));
    }

    // -- Test: fs.write with non-ASCII filename ---------------------------
    console.log('\n[fs.write - non-ASCII filename]');
    {
      const code = `
# Em-dash and Greek characters in filename
path1 = "${TMP_DIR}/em\u2014dash\u2014file.txt"
result1 = fs.write(path1, "em dash content\\n")
read1 = fs.read(path1)

path2 = "${TMP_DIR}/\u03b1\u03b2\u03b3\u03b4.txt"
result2 = fs.write(path2, "greek content\\n")
read2 = fs.read(path2)

done({
    "write1_ok": result1.get("ok"),
    "read1_matches": read1 == "em dash content\\n",
    "write2_ok": result2.get("ok"),
    "read2_matches": read2 == "greek content\\n",
})
`;
      const r = await bridge.exec({ code, timeout_ms: 15_000 });
      if (r.exception) fail(`write non-ascii exception: ${r.exception}`);
      const value = r.done?.value as Record<string, unknown> | undefined;
      check('write em-dash filename ok', value?.write1_ok === true, JSON.stringify(value));
      check('read em-dash filename matches', value?.read1_matches === true, JSON.stringify(value));
      check('write greek filename ok', value?.write2_ok === true, JSON.stringify(value));
      check('read greek filename matches', value?.read2_matches === true, JSON.stringify(value));
    }

    // -- Test: fs.edit with relative path ---------------------------------
    console.log('\n[fs.edit - relative path]');
    {
      const code = `
path = "${TMP_DIR}/edit-test.txt"
fs.write(path, "alpha beta gamma\\n")
result = fs.edit(path, "beta", "BETA")
content = fs.read(path)
done({
    "edit_ok": result.get("ok"),
    "content_correct": content == "alpha BETA gamma\\n",
    "content": content,
})
`;
      const r = await bridge.exec({ code, timeout_ms: 15_000 });
      if (r.exception) fail(`edit relative exception: ${r.exception}`);
      const value = r.done?.value as Record<string, unknown> | undefined;
      check('edit relative path ok', value?.edit_ok === true, JSON.stringify(value));
      check('edit content correct', value?.content_correct === true, JSON.stringify(value));
    }

    // -- Test: fs.edit on non-ASCII filename ------------------------------
    console.log('\n[fs.edit - non-ASCII filename]');
    {
      const code = `
path = "${TMP_DIR}/\u03b1\u03b2\u03b3\u03b4.txt"
result = fs.edit(path, "greek", "GREEK")
content = fs.read(path)
done({
    "edit_ok": result.get("ok"),
    "content_correct": content == "GREEK content\\n",
    "content": content,
})
`;
      const r = await bridge.exec({ code, timeout_ms: 15_000 });
      if (r.exception) fail(`edit non-ascii exception: ${r.exception}`);
      const value = r.done?.value as Record<string, unknown> | undefined;
      check('edit non-ASCII filename ok', value?.edit_ok === true, JSON.stringify(value));
      check('edit non-ASCII content correct', value?.content_correct === true, JSON.stringify(value));
    }

    // -- Test: fs.glob -> fs.read path compatibility via bridge -----------
    console.log('\n[fs.glob -> fs.read - bridge path compat]');
    {
      const code = `
results = fs.glob("*.txt", "${TMP_DIR}")
readable = []
for r in results:
    joined = os.path.join("${TMP_DIR}", r)
    try:
        content = fs.read(joined)
        readable.append({"path": r, "len": len(content)})
    except Exception as e:
        readable.append({"path": r, "error": str(e)})
done({"count": len(results), "readable": readable, "all_ok": all("error" not in x for x in readable)})
`;
      const r = await bridge.exec({ code, timeout_ms: 15_000 });
      if (r.exception) fail(`glob->read bridge exception: ${r.exception}`);
      const value = r.done?.value as Record<string, unknown> | undefined;
      check('glob->read all readable via bridge', value?.all_ok === true,
        `count=${value?.count}, readable=${JSON.stringify(value?.readable)}`);
    }

    // -- Summary ----------------------------------------------------------
    console.log(`\n${  '='.repeat(60)  }`);
    console.log(`  ${pass_count} passed, ${fail_count} failed`);
    if (fail_count > 0) {
      process.exit(1);
    }
    console.log('  All bridge path semantics tests passed.');

  } finally {
    await bridge.shutdown().catch(() => {});
    // Cleanup
    rmSync(join(process.cwd(), TMP_DIR), { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

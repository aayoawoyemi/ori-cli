import { ReplBridge } from '../../src/repl/bridge.js';
import { OriVault } from '../../src/memory/vault.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function timeIt<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const r = await fn();
  console.log(`  ${label.padEnd(40)} ${(Date.now()-t0).toString().padStart(6)}ms`);
  return r;
}

(async () => {
  const v = join(homedir(), 'brain');
  const b = new ReplBridge({});
  await b.start();
  const o = new OriVault(v); await o.connect(); b.setVault(o);
  await b.configure({ vaultGlobal: v, mode: 'project+vault', shell: 'bash' });
  await b.connectVault({ vaultPath: v });
  await timeIt('exec orient(brief=True)', () => b.exec({ code: 'r = vault.orient(brief=True)\nprint(len(str(r)))' }));
  await timeIt('exec orient(brief=False)', () => b.exec({ code: 'r = vault.orient(brief=False)\nprint(len(str(r)))' }));
  await timeIt('exec orient(brief=False) #2', () => b.exec({ code: 'r = vault.orient(brief=False)\nprint(len(str(r)))' }));
  const r = await timeIt('exec reindex.list()', () => b.exec({ code: 'print(reindex.list())' }));
  console.log('  reindex.list exception:', r.exception?.split('\n').slice(-3).join(' | '));
  await b.shutdown();
})().catch(e => { console.error(e); process.exit(1); });

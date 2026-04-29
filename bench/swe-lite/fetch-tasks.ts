/**
 * Fetch SWE-bench Lite tasks once, dump to bench/swe-lite/tasks.json.
 *
 * The Hugging Face datasets-server returns rows in JSON (no parquet
 * dependency). 300 tasks total in the `test` split — three pages of 100.
 *
 * Run once:
 *   npx tsx bench/swe-lite/fetch-tasks.ts
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'tasks.json');

interface SweTask {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  patch: string;
  test_patch: string;
  FAIL_TO_PASS: string;       // JSON-encoded array
  PASS_TO_PASS: string;       // JSON-encoded array
  version: string;
  environment_setup_commit?: string;
  hints_text?: string;
}

async function fetchPage(offset: number, length: number): Promise<SweTask[]> {
  const url =
    `https://datasets-server.huggingface.co/rows` +
    `?dataset=princeton-nlp%2FSWE-bench_Lite` +
    `&config=default&split=test&offset=${offset}&length=${length}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HF datasets-server ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { rows: Array<{ row: SweTask }> };
  return data.rows.map((r) => r.row);
}

async function main() {
  const all: SweTask[] = [];
  for (let offset = 0; offset < 400; offset += 100) {
    process.stdout.write(`fetching ${offset}..${offset + 100}... `);
    const page = await fetchPage(offset, 100);
    process.stdout.write(`${page.length} rows\n`);
    all.push(...page);
    if (page.length < 100) break;
  }
  writeFileSync(OUT, JSON.stringify(all, null, 2));
  console.log(`\nWrote ${all.length} tasks -> ${OUT}`);

  // Surface a starter shortlist of small-repo tasks so the user can pick
  // one without scrolling through 300 entries. These repos install fast
  // on Windows and have minimal native deps.
  const easyRepos = new Set([
    'marshmallow-code/marshmallow',
    'pytest-dev/pytest',
    'pylint-dev/pylint',
    'psf/requests',
    'pallets/flask',
    'pallets/click',
  ]);
  const easy = all.filter((t) => easyRepos.has(t.repo));
  console.log(`\nLightweight-repo candidates (${easy.length}):`);
  for (const t of easy.slice(0, 15)) {
    const ftp: string[] = JSON.parse(t.FAIL_TO_PASS);
    console.log(`  ${t.instance_id}  (${ftp.length} FAIL_TO_PASS test(s))`);
  }
  if (easy.length > 15) console.log(`  ... +${easy.length - 15} more`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

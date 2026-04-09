import fs from 'fs';

const files = [
  'src/tools/webFetch.ts',
  'src/tools/webSearch.ts',
  'src/tools/registry.ts',
  'src/tools/toolSets.ts',
];

for (const f of files) {
  console.log(`\n=== ${f} ===`);
  console.log(fs.readFileSync('C:/Users/aayoa/Desktop/aries-cli/' + f, 'utf8'));
}

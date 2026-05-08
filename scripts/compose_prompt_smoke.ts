import assert from 'node:assert/strict';
import {
  CACHE_PREFIX_BREAK,
  buildComposeRequestSystemPrompt,
  renderSystemPrompt,
  splitSystemPromptInput,
} from '../src/prompt.js';

const splitLegacy = splitSystemPromptInput(`stable rules\n${CACHE_PREFIX_BREAK}\nvolatile facts`);
assert.deepEqual(splitLegacy, { stable: 'stable rules', volatile: 'volatile facts' });

const splitNoMarker = splitSystemPromptInput('flat legacy prompt');
assert.deepEqual(splitNoMarker, { stable: '', volatile: 'flat legacy prompt' });
assert.equal(renderSystemPrompt({ stable: 'stable', volatile: 'volatile' }), 'stable\n\nvolatile');

const composeCached = buildComposeRequestSystemPrompt(
  { stable: 'stable substrate', volatile: 'session facts' },
  {
    mode: 'compose',
    requestId: 'req_prompt01',
    scratchContent: '# Request Scratch\n\n## Findings\n- ok',
  },
);
assert.match(composeCached.stable, /Compose Loop Protocol/);
assert.match(composeCached.stable, /<compose_preflight>/);
assert.match(composeCached.volatile, /session facts/);
assert.match(composeCached.volatile, /# Request Scratch/);
assert.match(composeCached.volatile, /req_prompt01/);
assert.doesNotMatch(composeCached.volatile, /Final Answer Readiness Audit/);

const composeAfterVerification = buildComposeRequestSystemPrompt(
  { stable: 'stable substrate', volatile: 'session facts' },
  {
    mode: 'compose',
    requestId: 'req_prompt03',
    scratchContent: '# Request Scratch\n\n## Verification\n- tests passed',
    verificationFilled: true,
  },
);
assert.match(composeAfterVerification.volatile, /Final Answer Readiness Audit/);
assert.match(composeAfterVerification.volatile, /Before calling `done\(value\)`/);

const composeNoCache = buildComposeRequestSystemPrompt(
  'flat legacy prompt',
  {
    mode: 'goal',
    requestId: 'req_prompt02',
    scratchContent: 'goal scratch',
  },
);
assert.equal(composeNoCache.stable, '');
assert.match(composeNoCache.volatile, /flat legacy prompt/);
assert.match(composeNoCache.volatile, /Compose Loop Protocol/);
assert.match(composeNoCache.volatile, /goal scratch/);

console.log('compose prompt smoke ok');

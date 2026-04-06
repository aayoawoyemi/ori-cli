/**
 * Orientation stack tests — Fix 2, Fix 4 (idempotence) + Fix 1, Fix 3 (current state).
 *
 * Core bug being verified fixed: synthetic content accumulation across turns.
 * Before fix: each turn's preflight/proprio wrappings stacked on user messages.
 * After fix: strip-before-inject keeps user messages clean.
 *
 * Run: npx tsx test/memory/orientation.test.ts
 */
import {
  wrapSynthetic,
  stripSynthetic,
  stripSyntheticFromMessages,
  injectTurnSynthetics,
} from '../../src/memory/syntheticMarkers.js';
import type { Message } from '../../src/router/types.js';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
    pass++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

function run() {
  // ---- wrapSynthetic / stripSynthetic round-trip ----
  const original = 'User wants to fix the permission bug';
  const wrapped = `${wrapSynthetic('preflight-before', 'memory notes...')}\n\n${original}\n\n${wrapSynthetic('proprio', 'context: 20%')}`;
  const stripped = stripSynthetic(wrapped);
  check('wrap+strip returns to original text', stripped === original,
    `got: "${stripped.slice(0, 80)}"`);

  // ---- strip is idempotent (runs safe multiple times) ----
  const once = stripSynthetic(wrapped);
  const twice = stripSynthetic(once);
  check('strip is idempotent', once === twice);

  // ---- strip handles empty content ----
  check('strip of empty returns empty', stripSynthetic('') === '');

  // ---- strip only specified kind ----
  const bothKinds = `${wrapSynthetic('preflight-before', 'A')}\n\n${original}\n\n${wrapSynthetic('proprio', 'B')}`;
  const stripPreflight = stripSynthetic(bothKinds, 'preflight-before');
  check('strip kind preflight-before',
    !stripPreflight.includes('ORI_SYNTH-START:preflight-before') &&
    stripPreflight.includes('ORI_SYNTH-START:proprio'));

  // ---- stripSyntheticFromMessages cleans user messages ----
  const messages: Message[] = [
    { role: 'user', content: wrapSynthetic('proprio', 'x') + '\n\nhello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'just a normal message' },
    { role: 'user', content: wrapSynthetic('preflight-before', 'notes') + '\n\nsecond msg\n\n' + wrapSynthetic('proprio', 'p') },
  ];
  stripSyntheticFromMessages(messages);
  check('first user message cleaned', messages[0].content === 'hello');
  check('normal message unchanged', messages[2].content === 'just a normal message');
  check('both-wrapped cleaned to inner', messages[3].content === 'second msg');
  check('assistant message untouched', messages[1].content === 'hi');

  // ---- injectTurnSynthetics wraps + places correctly ----
  const freshMessages: Message[] = [{ role: 'user', content: 'tell me about the permission system' }];
  injectTurnSynthetics(freshMessages, {
    preflightBefore: '## Vault Knowledge\n- note A\n- note B',
    currentState: '# Current State\nGoal: fix orientation stack',
    proprio: '<context-status>\nContext: 5%\n</context-status>',
  });
  const injected = freshMessages[0].content as string;
  check('has preflight-before marker', injected.includes('ORI_SYNTH-START:preflight-before'));
  check('has current-state marker', injected.includes('ORI_SYNTH-START:current-state'));
  check('has proprio marker', injected.includes('ORI_SYNTH-START:proprio'));
  check('user text preserved', injected.includes('tell me about the permission system'));

  // ---- current-state appears AFTER preflight-before (closer to user text) ----
  const currentIdx = injected.indexOf('ORI_SYNTH-START:current-state');
  const preflightIdx = injected.indexOf('ORI_SYNTH-START:preflight-before');
  const userTextIdx = injected.indexOf('tell me about the permission system');
  check('preflight < current-state < user (closeness order)',
    preflightIdx < currentIdx && currentIdx < userTextIdx,
    `preflight=${preflightIdx}, current=${currentIdx}, user=${userTextIdx}`);

  // ---- CORE BUG: multi-turn accumulation is prevented ----
  // Simulate 5 turns: each turn runs strip-then-inject. Verify message size stays bounded.
  const stackMsgs: Message[] = [{ role: 'user', content: 'original question' }];
  const baselineSize = (stackMsgs[0].content as string).length;

  for (let turn = 1; turn <= 5; turn++) {
    stripSyntheticFromMessages(stackMsgs);
    injectTurnSynthetics(stackMsgs, {
      preflightBefore: `turn ${turn} memory notes`,
      currentState: `turn ${turn} current state`,
      proprio: `turn ${turn} proprio`,
    });
  }

  // After 5 turns, the user message should have exactly 1 set of wrappings (not 5)
  const finalContent = stackMsgs[0].content as string;
  const startMarkerCount = (finalContent.match(/ORI_SYNTH-START/g) || []).length;
  check('no stacking — exactly 3 synthetic blocks after 5 turns',
    startMarkerCount === 3,
    `got ${startMarkerCount} markers`);

  // Strip again — should return to ~original
  stripSyntheticFromMessages(stackMsgs);
  const finalClean = stackMsgs[0].content as string;
  check('final strip returns to baseline', finalClean === 'original question');

  // Size should be stable, NOT growing
  check('final cleaned size matches baseline',
    finalClean.length === baselineSize);

  console.log('');
  console.log(`${pass}/${pass + fail} passed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();

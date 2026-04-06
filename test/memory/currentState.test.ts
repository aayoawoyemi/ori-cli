/**
 * Current State tests — Fix 1 + Fix 3.
 *
 * Proves: assembleCurrentState reflects fresh vault content on every call.
 * This is the core of the orientation fix. If this fails, agent WILL act
 * on stale state.
 *
 * Run: npx tsx test/memory/currentState.test.ts
 */
import { assembleCurrentState } from '../../src/memory/currentState.js';
import { injectTurnSynthetics, stripSyntheticFromMessages } from '../../src/memory/syntheticMarkers.js';
import type { Message } from '../../src/router/types.js';

// Minimal shape of OriVault that assembleCurrentState actually touches
interface FakeVault {
  connected: boolean;
  orient: () => Promise<unknown>;
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); fail++; }
}

function makeVault(state: { identity?: string; goals?: string; daily?: string }): FakeVault {
  return {
    connected: true,
    orient: async () => state,
  };
}

async function run() {
  // ---- 1. Empty vault returns empty string ----
  const emptyBlock = await assembleCurrentState(makeVault({}) as never);
  check('empty vault → empty block', emptyBlock === '', `got: "${emptyBlock.slice(0, 60)}"`);

  // ---- 2. Disconnected vault returns empty ----
  const disconnectedBlock = await assembleCurrentState(
    { connected: false, orient: async () => ({ goals: '# Active\n- x' }) } as never,
  );
  check('disconnected vault → empty block', disconnectedBlock === '');

  // ---- 3. Null vault returns empty ----
  const nullBlock = await assembleCurrentState(null);
  check('null vault → empty block', nullBlock === '');

  // ---- 4. vault.orient() throwing returns empty, does not crash ----
  const throwingVault: FakeVault = {
    connected: true,
    orient: async () => { throw new Error('mcp dead'); },
  };
  const throwBlock = await assembleCurrentState(throwingVault as never);
  check('orient() throws → empty block (graceful)', throwBlock === '');

  // ---- 5. Realistic vault builds proper block ----
  const vaultA = makeVault({
    identity: `---
name: Aries
---

# Black philosopher on a Roman coin.

Secondary line.`,
    goals: `# Goals

## Active threads
- Ship ori CLI v1.0 with REPL-mandatory loop
- Fix orientation stack — current_state injection
- [x] Done thing that should be filtered
- Draft Substack article on persistence`,
    daily: `# Daily 2026-04-05

## Pending Today
- [ ] Orient
- [ ] Inbox processed
- [x] Twitter session
- [ ] Finish handoff doc`,
  });

  const blockA = await assembleCurrentState(vaultA as never);
  check('non-empty vault produces block', blockA.length > 0);
  check('block has Current State header', blockA.includes('# Current State'));
  check('block has today\'s date', blockA.includes(new Date().toISOString().split('T')[0]));
  check('block includes identity line', blockA.includes('Black philosopher'));
  check('block includes active goal',
    blockA.includes('Ship ori CLI v1.0 with REPL-mandatory loop'));
  check('block includes orientation goal',
    blockA.includes('Fix orientation stack'));
  check('block includes pending item', blockA.includes('Orient'));
  check('block includes another pending item', blockA.includes('Finish handoff doc'));
  check('block filters completed goals (no [x])',
    !blockA.includes('Done thing that should be filtered'));
  check('block filters completed daily (no Twitter)',
    !blockA.includes('Twitter session'));

  // ---- 6. CORE BUG: vault content change is reflected on next call ----
  // This is the whole point. Stale state = bug. Fresh state = fix.
  let currentGoals = `# Goals
## Active
- old goal`;
  const mutableVault: FakeVault = {
    connected: true,
    orient: async () => ({ goals: currentGoals }),
  };

  const before = await assembleCurrentState(mutableVault as never);
  check('first call sees old goal', before.includes('old goal'));

  // Simulate user editing goals.md mid-session
  currentGoals = `# Goals
## Active
- new goal after user update`;

  const after = await assembleCurrentState(mutableVault as never);
  check('second call sees new goal', after.includes('new goal after user update'));
  check('second call does NOT see old goal', !after.includes('old goal'));

  // ---- 7. Truncation caps oversized state ----
  const huge = 'X'.repeat(5000);
  const hugeVault = makeVault({
    goals: `# Active\n- ${huge}`,
  });
  const hugeBlock = await assembleCurrentState(hugeVault as never);
  check('huge vault content is truncated', hugeBlock.length < 2000,
    `block length: ${hugeBlock.length}`);

  // ---- 8. End-to-end: current_state + strip/inject round-trip ----
  // Simulates what loop.ts actually does per turn.
  const messages: Message[] = [{ role: 'user', content: 'what should I work on?' }];

  // Turn 1
  const turn1State = await assembleCurrentState(mutableVault as never);
  stripSyntheticFromMessages(messages);
  injectTurnSynthetics(messages, {
    currentState: turn1State,
    preflightBefore: 'historical notes turn 1',
    proprio: 'context: 10%',
  });
  const turn1Content = messages[0].content as string;
  check('turn 1: message has new goal', turn1Content.includes('new goal after user update'));
  check('turn 1: message has user text', turn1Content.includes('what should I work on?'));

  // User edits vault again
  currentGoals = `# Goals
## Active
- goal after second edit`;

  // Turn 2 — the strip-then-inject pattern
  const turn2State = await assembleCurrentState(mutableVault as never);
  stripSyntheticFromMessages(messages);
  injectTurnSynthetics(messages, {
    currentState: turn2State,
    preflightBefore: 'historical notes turn 2',
    proprio: 'context: 15%',
  });
  const turn2Content = messages[0].content as string;
  check('turn 2: message has updated goal',
    turn2Content.includes('goal after second edit'));
  check('turn 2: message does NOT have turn 1 goal',
    !turn2Content.includes('new goal after user update'));
  check('turn 2: still exactly 3 synthetic blocks (no stacking)',
    (turn2Content.match(/ORI_SYNTH-START/g) || []).length === 3);

  console.log('');
  console.log(`${pass}/${pass + fail} passed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();

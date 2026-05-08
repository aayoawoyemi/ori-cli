/**
 * Compose router unit smoke. Pure-function classification cases.
 */
import assert from 'node:assert/strict';
import { classifyRequestMode, newRequestId } from '../src/compose/router.js';

interface Case {
  input: string;
  mode: 'quick' | 'compose' | 'goal';
  reason?: string;
  cleanedText?: string;
}

const cases: Case[] = [
  // Slash markers — highest precedence
  { input: '#compose look at the wall code',           mode: 'compose', reason: 'slash', cleanedText: 'look at the wall code' },
  { input: '#quick what is 9+10',                      mode: 'quick',   reason: 'slash', cleanedText: 'what is 9+10' },
  { input: '#goal optimize the bench loop over time',  mode: 'goal',    reason: 'slash', cleanedText: 'optimize the bench loop over time' },
  { input: '#COMPOSE  uppercase marker test',          mode: 'compose', reason: 'slash', cleanedText: 'uppercase marker test' },

  // Verb match — compose
  { input: 'build a feature for X',                    mode: 'compose', reason: 'verb_match' },
  { input: 'please fix the bench parser',              mode: 'compose', reason: 'verb_match' },
  { input: 'can you investigate why the wall is silent', mode: 'compose', reason: 'verb_match' },
  { input: 'lets refactor the bridge',                 mode: 'compose', reason: 'verb_match' },
  { input: 'look deeply at the loop3 architecture',    mode: 'compose', reason: 'verb_match' },
  { input: 'audit the current goal mode',              mode: 'compose', reason: 'verb_match' },
  { input: 'walk through the dispatch path',           mode: 'compose', reason: 'verb_match' },

  // Phrase match — compose
  { input: 'show me the function across the codebase', mode: 'compose', reason: 'phrase_match' },
  { input: 'I want to read each file in body/',        mode: 'compose', reason: 'phrase_match' },
  { input: 'go section by section through this',       mode: 'compose', reason: 'phrase_match' },

  // Short question — quick
  { input: 'what is 9+10',                             mode: 'quick',   reason: 'short_question' },
  { input: 'where is RUNNING.md?',                     mode: 'quick',   reason: 'short_question' },
  { input: 'how does the wall work?',                  mode: 'quick',   reason: 'short_question' },

  // Default fallback — compose
  { input: 'the cells per request metric is interesting and we should track it', mode: 'compose', reason: 'default' },
  { input: 'thinking about whether goal mode is the right primitive here', mode: 'compose', reason: 'default' },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const r = classifyRequestMode(c.input);
  const modeOk = r.mode === c.mode;
  const reasonOk = c.reason ? r.reason === c.reason : true;
  const cleanedOk = c.cleanedText !== undefined ? r.cleanedText === c.cleanedText : true;
  if (modeOk && reasonOk && cleanedOk) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`FAIL  ${JSON.stringify(c.input)}`);
    console.error(`      expected mode=${c.mode} reason=${c.reason ?? '*'}${c.cleanedText !== undefined ? ` cleanedText=${JSON.stringify(c.cleanedText)}` : ''}`);
    console.error(`      got      mode=${r.mode} reason=${r.reason} cleanedText=${JSON.stringify(r.cleanedText)} matchedTrigger=${r.matchedTrigger ?? ''}`);
  }
}

// Newrequest id shape
const id = newRequestId();
assert.match(id, /^req_[0-9a-f]{8}$/, `newRequestId returned malformed id: ${id}`);

if (fail === 0) {
  console.log(`PASS compose router smoke (${pass}/${pass} cases)`);
  process.exit(0);
} else {
  console.error(`FAIL compose router smoke (${fail}/${pass + fail} cases failed)`);
  process.exit(1);
}

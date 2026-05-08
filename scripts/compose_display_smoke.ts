import assert from 'node:assert/strict';
import { ComposeDisplayFilter, renderComposeBlocksForDisplay } from '../src/compose/display.js';

const preflight = `<compose_preflight>
purpose: read candidate files
primitives: fs.read, vault.top, state.put
cell_kind: composed
</compose_preflight>`;

const renderedPreflight = renderComposeBlocksForDisplay(`Before\n${preflight}\nAfter`);
assert.match(renderedPreflight, /Before/);
assert.match(renderedPreflight, /Next: read candidate files/);
assert.match(renderedPreflight, /kind=composed/);
assert.match(renderedPreflight, /primitives=fs\.read,vault\.top,state\.put/);
assert.match(renderedPreflight, /After/);
assert.doesNotMatch(renderedPreflight, /compose_preflight/);

const update = `<compose_update>
findings: found three relevant notes
next_move: verify rank order
</compose_update>`;
const renderedUpdate = renderComposeBlocksForDisplay(update);
assert.equal(renderedUpdate.trim(), 'Found: found three relevant notes; next=verify rank order');
assert.doesNotMatch(renderedUpdate, /compose_update/);

const filter = new ComposeDisplayFilter();
assert.equal(filter.push('Alpha <compose_pre'), 'Alpha ');
assert.equal(filter.push('flight>\npurpose: streamed block\n'), '');
const streamedTail = filter.push('cell_kind: scout\n</compose_preflight> Omega');
assert.match(streamedTail, /Next: streamed block/);
assert.match(streamedTail, /Omega/);
assert.doesNotMatch(streamedTail, /compose_preflight/);

console.log('compose display smoke ok');

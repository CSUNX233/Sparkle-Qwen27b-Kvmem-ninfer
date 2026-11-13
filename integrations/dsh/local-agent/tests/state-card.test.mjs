import test from 'node:test';
import assert from 'node:assert/strict';
import {
  digestCode, digestError, summarizeArgs, buildStateCard, shouldEmit, collectText, hasImageBlock, apply,
} from '../state-card.mjs';

const sample = `import os
MAX_RETRIES = 7
LEASE_TTL = 5417
class LeaseCoordinator:
    def acquire(self, name):
        return name

async def run_loop(value):
    return value
`;

test('digestCode keeps signatures, constants and tail', () => {
  const d = digestCode(sample, 'lease/coordinator.py');
  assert.equal(d.path, 'lease/coordinator.py');
  assert.ok(d.chars > 0);
  assert.ok(d.signatures.some(x => x.includes('class LeaseCoordinator')));
  assert.ok(d.signatures.some(x => x.includes('def acquire')));
  assert.ok(d.signatures.some(x => x.includes('async def run_loop')));
  assert.ok(d.constants.some(x => x.includes('MAX_RETRIES')));
  assert.ok(d.constants.some(x => x.includes('LEASE_TTL')));
  assert.ok(d.tail.length > 0);
  assert.match(d.sha, /^[0-9a-f]{12}$/);
});

test('digestError prefers traceback and exception lines', () => {
  const text = `stdout noise\nTraceback (most recent call last):\n  File "x.py", line 1\nValueError: bad value\n`;
  const d = digestError(text);
  assert.ok(d.some(x => x.includes('Traceback')));
  assert.ok(d.some(x => x.includes('ValueError')));
});

test('hasImageBlock detects nested tool-result images', () => {
  assert.equal(hasImageBlock([{ type: 'tool-result', content: [{ type: 'image' }] }]), true);
  assert.equal(hasImageBlock([{ type: 'tool-result', content: [{ type: 'text', text: 'x' }] }]), false);
});

test('collectText expands nested tool-result content', () => {
  const content = [{ type: 'tool-result', content: [{ type: 'text', text: 'Traceback: boom' }, { type: 'image' }] }];
  assert.equal(collectText(content), 'Traceback: boom');
});

test('digestError ignores successful output', () => {
  assert.deepEqual(digestError('Created file\nUpdated file'), []);
});

test('summarizeArgs is bounded and tool aware', () => {
  assert.equal(summarizeArgs('write', { file_path: 'a.py', content: 'x' }), 'a.py');
  assert.match(summarizeArgs('pwsh', { command: 'python a.py' }), /python a\.py/);
  assert.ok(summarizeArgs('other', { a: 1 }).length < 200);
});

test('buildStateCard is bounded and contains state', () => {
  const state = {
    goal: 'solve the desert puzzle',
    files: [{ path: 'a.py', chars: 12, signatures: ['def main()'], constants: [], tail: ['return 0'] }],
    attempts: [{ tool: 'pwsh', summary: 'python a.py', ok: false, err: ['ValueError: bad'] }],
    lastOk: 'python a.py -> ok',
    lastErr: ['ValueError: bad'],
  };
  const card = buildStateCard(state);
  assert.ok(card.length <= 1900);
  assert.match(card, /solve the desert puzzle/);
  assert.match(card, /a\.py/);
  assert.match(card, /ValueError/);
  assert.match(card, /Do not repeat a failed command/);
});

test('shouldEmit reacts to errors, writes and periodic shell calls', () => {
  const state = { attempts: [{}, {}, {}], shellCalls: 3 };
  assert.equal(shouldEmit('pwsh', state, { error: true }), true);
  assert.equal(shouldEmit('write', state, { error: false }), true);
  assert.equal(shouldEmit('pwsh', state, { error: false }), true);
  assert.equal(shouldEmit('pwsh', { attempts: [{}], shellCalls: 1 }, { error: false }), false);
  assert.equal(shouldEmit('read', { attempts: [{}], shellCalls: 1 }, { error: false }), false);
});

test('shell trigger survives the capped attempts list', () => {
  const capped = { attempts: Array.from({ length: 8 }, () => ({})), shellCalls: 9 };
  assert.equal(shouldEmit('pwsh', capped, { error: false }), true);
  assert.equal(shouldEmit('pwsh', { ...capped, shellCalls: 10 }, { error: false }), false);
  assert.equal(shouldEmit('pwsh', { ...capped, shellCalls: 12 }, { error: false }), true);
  assert.equal(shouldEmit('bash', { ...capped, shellCalls: 15 }, { error: false }), true);
});

test('apply keeps emitting shell cards after attempts fills', async () => {
  delete process.env.LOCAL_STATE_CARD;
  const hooks = new Map();
  apply({ on: (name, handler) => hooks.set(name, handler), get: () => null });
  const hook = hooks.get('tools/post-execute');
  assert.ok(hook);
  const agent = {
    session: { header: { agentPreset: 'ninfer-local' }, snapshotEvents: () => [] },
    options: { provider: 'ninfer-local' },
  };
  const next = async () => ({ content: [{ type: 'text', text: 'ok' }] });
  let cards = 0;
  for (let i = 1; i <= 9; i += 1) {
    const exec = {
      name: 'pwsh',
      arguments: JSON.stringify({ command: `echo ${i}` }),
      agent,
      signal: { aborted: false },
    };
    const result = { content: [{ type: 'text', text: 'ok' }], isError: false };
    const downstream = await hook(exec, result, next);
    cards += (downstream.additionalContexts ?? []).length;
  }
  // Calls 3, 6 and 9 must each add a card; call 9 is after attempts has
  // already been capped at 8 entries.
  assert.equal(cards, 3);
});

test('malformed parser markers are not recorded as tool attempts', async () => {
  const hooks = new Map();
  apply({ on: (name, handler) => hooks.set(name, handler), get: () => null });
  const hook = hooks.get('tools/post-execute');
  const agent = { session: { header: { agentPreset: 'ninfer-local' }, snapshotEvents: () => [] }, options: { provider: 'ninfer-local' } };
  const next = async () => ({ kind: 'accept', content: [{ type: 'text', text: 'ok' }] });
  const marker = await hook({ name: 'malformed_tool_call', arguments: {}, agent, signal: { aborted: false } },
    { content: [{ type: 'text', text: 'format error' }], isError: true }, next);
  assert.equal(marker.additionalContexts, undefined);
  let out;
  for (let i = 0; i < 3; i++) out = await hook({ name: 'pwsh', arguments: { command: `echo ${i}` }, agent, signal: { aborted: false } },
    { content: [{ type: 'text', text: 'ok' }], isError: false }, next);
  assert.equal(out.additionalContexts.length, 1);
  assert.doesNotMatch(JSON.stringify(out.additionalContexts), /malformed_tool_call/);
});

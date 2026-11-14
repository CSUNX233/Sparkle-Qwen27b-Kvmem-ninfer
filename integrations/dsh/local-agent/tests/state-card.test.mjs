import test from 'node:test';
import assert from 'node:assert/strict';
import {
  digestCode, digestError, summarizeArgs, buildStateCard, collectText, hasImageBlock, apply,
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

function harness({ media = false, plan = false } = {}) {
  const hooks = new Map();
  apply({ on: (name, handler) => hooks.set(name, handler), get: () => ({ stateOf: () => ({ active: plan }) }) });
  const events = media ? [{ type: 'user/message', data: { content: [{ type: 'image' }] } }] : [];
  const agent = { session: { header: { agentPreset: 'ninfer-local' }, snapshotEvents: () => events }, options: { provider: 'ninfer-local' } };
  return {
    agent,
    tool: (name, args = {}, error = false, output = 'ok', downstream = { kind: 'accept' }) => hooks.get('tools/post-execute')(
      { name, arguments: args, agent }, { isError: error, content: [{ type: 'text', text: output }] }, async () => downstream),
    step: (messages = [], decision = { kind: 'enter', messages }, aborted = false) => hooks.get('agent/pre-step')(
      { agent, messages, step: 2, signal: { aborted } }, async () => decision),
  };
}

test('eight different one-line edits in one tool batch produce only one checkpoint', async () => {
  const h = harness();
  for (let i = 0; i < 8; i++) {
    const out = await h.tool('edit', { file_path: `f${i}.js`, new_string: `const x${i}=1` });
    assert.equal(out.additionalContexts, undefined);
  }
  const out = await h.step();
  assert.equal(out.messages.length, 1);
  const card = out.messages[0];
  assert.equal(card.source.kind, 'plugin');
  assert.equal(card.source.form, 'notice');
  const payload = JSON.parse(card.content[0].text.split('\n').slice(1).join('\n'));
  assert.equal(payload.files.length, 8);
  assert.match(payload.files[0].scope, /not verified/);
  assert.equal(payload.files[0].chars, undefined);
  assert.equal((await h.step()).messages.length, 0);
});

test('separate one-line edit steps do not generate eight separate cards', async () => {
  const h = harness();
  let cards = 0;
  for (let i = 0; i < 8; i++) {
    await h.tool('edit', { file_path: `${i}.js`, new_string: 'x' });
    cards += (await h.step()).messages.length;
  }
  assert.equal(cards, 1);
});

test('successful shell/read calls do not periodically inject cards', async () => {
  const h = harness();
  for (let i = 0; i < 12; i++) {
    await h.tool('pwsh', { command: `echo ${i}` });
    await h.tool('read', { file_path: 'source.js' }, false, 'throw new TypeError(); // Traceback');
    assert.equal((await h.step()).messages.length, 0);
  }
});

test('a later batch on the same file remains distinguishable from an old checkpoint', async () => {
  const h = harness();
  const revisions = [];
  for (let i = 0; i < 16; i++) {
    await h.tool('edit', { file_path: 'same.js', new_string: `x=${i}` });
    const out = await h.step();
    if (out.messages.length) revisions.push(JSON.parse(out.messages[0].content[0].text.split('\n').slice(1).join('\n')).successful_mutations);
  }
  assert.deepEqual(revisions, [8, 16]);
});

test('failed read emits once; identical failure does not keep injecting', async () => {
  const h = harness();
  await h.tool('read', { file_path: 'missing' }, true, 'File not found');
  assert.equal((await h.step()).messages.length, 1);
  await h.tool('read', { file_path: 'missing' }, true, 'File not found');
  assert.equal((await h.step()).messages.length, 0);
  await h.tool('read', { file_path: 'different' }, true, 'Permission denied');
  assert.equal((await h.step()).messages.length, 1);
});

test('multiple errors in one batch coalesce into a single message', async () => {
  const h = harness();
  for (let i = 0; i < 8; i++) await h.tool('edit', { file_path: `${i}.js` }, true, 'old_string was not found');
  assert.equal((await h.step()).messages.length, 1);
});

test('new user instruction refreshes goal and clears previous pending failures', async () => {
  const h = harness();
  await h.tool('read', {}, true, 'old failure');
  const user = { source: { kind: 'user' }, content: [{ type: 'text', text: 'new goal' }] };
  assert.deepEqual((await h.step([user])).messages, [user]);
  for (let i = 0; i < 8; i++) await h.tool('edit', { file_path: `${i}.js` });
  const text = (await h.step()).messages[0].content[0].text;
  assert.match(text, /new goal/);
  assert.doesNotMatch(text, /old failure/);
});

test('media, plan, cancelled and rejected steps do not inject', async () => {
  for (const options of [{ media: true }, { plan: true }]) {
    const h = harness(options);
    await h.tool('edit', {}, true, 'failure');
    assert.equal((await h.step()).messages.length, 0);
  }
  const h = harness();
  await h.tool('read', {}, true, 'failure');
  assert.equal((await h.step([], { kind: 'enter', messages: [] }, true)).messages.length, 0);
  assert.deepEqual(await h.step([], { kind: 'reject' }), { kind: 'reject' });
  assert.equal((await h.step()).messages.length, 1);
});

test('downstream-dropped messages are not resurrected with a card', async () => {
  const h = harness();
  await h.tool('read', {}, true, 'failure');
  const plugin = { source: { kind: 'plugin' }, content: [] };
  assert.equal((await h.step([plugin], { kind: 'enter', messages: [] })).messages.length, 0);
});

test('parser markers and blocked results do not generate state cards', async () => {
  const h = harness();
  await h.tool('malformed_tool_call', {}, true, 'format error');
  await h.tool('edit', {}, true, 'failure', { kind: 'block' });
  assert.equal((await h.step()).messages.length, 0);
});

test('maximum sized checkpoint remains bounded valid JSON', () => {
  const card = buildStateCard({ goal: '中'.repeat(600), files: Array.from({ length: 8 }, () => ({ path: '长'.repeat(300) })),
    attempts: Array.from({ length: 8 }, () => ({ tool: 'read', summary: '字'.repeat(200), ok: false, err: ['坏'.repeat(180)] })),
    lastOk: '好'.repeat(300), lastErr: Array.from({ length: 4 }, () => '错'.repeat(180)) });
  assert.ok(card.length <= 1900);
  assert.doesNotThrow(() => JSON.parse(card.slice(card.indexOf('\n') + 1)));
});

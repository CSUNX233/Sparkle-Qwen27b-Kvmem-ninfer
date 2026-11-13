import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import * as recovery from '../tool-call-recovery.mjs';

const markerCall = id => ({ type: 'tool/call', data: { callId: id, name: recovery.marker } });
const text = result => result.content.map(block => block.text ?? '').join('\n');

test('only consecutive marker calls in the current turn count', () => {
  const events = [{ type: 'turn/start' }, markerCall('a'), { type: 'tool/result' }, markerCall('b')];
  assert.equal(recovery.consecutiveMarkers(events, 'b'), 2);
  assert.equal(recovery.consecutiveMarkers([...events, { type: 'tool/call', data: { callId: 'ok', name: 'read' } }, markerCall('c')], 'c'), 1);
  assert.equal(recovery.consecutiveMarkers([...events, { type: 'turn/start' }, markerCall('c')], 'c'), 1);
  assert.equal(recovery.consecutiveMarkers(events, 'missing'), 1);
  assert.equal(recovery.consecutiveMarkers([...events, { type: 'user/message', data: { source: { kind: 'plugin' } } }, markerCall('c')], 'c'), 3);
  assert.equal(recovery.consecutiveMarkers([...events, { type: 'user/message', data: { source: { kind: 'user' } } }, markerCall('c')], 'c'), 1);
});

async function fixture(t, preset = 'ninfer-local') {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(recovery);
  let executions = 0;
  ctx.tools.register(defineTool({ name: 'read', description: 'fixture', parameters: {},
    output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
    async execute() { executions++; return 'ok'; } }));
  const events = [{ type: 'turn/start' }];
  const cancellations = [];
  const agent = { options: { provider: preset }, session: { header: { agentPreset: preset }, snapshotEvents: () => events },
    cancel: (cause, options) => cancellations.push({ cause, options }) };
  let nextId = 0;
  async function run(name, args = {}) {
    const callId = String(++nextId);
    events.push({ type: 'tool/call', data: { callId, name, arguments: args } });
    return ctx.tools.execute({ callId, name, arguments: args, agent, signal: new AbortController().signal });
  }
  t.after(async () => { await ctx.fiber.dispose(); });
  return { ctx, events, agent, run, cancellations, executions: () => executions };
}

test('real tool runtime reports an actionable error without executing a tool', async t => {
  const f = await fixture(t);
  assert.ok(!f.ctx.tools.schemas(f.agent).some(tool => tool.name === recovery.marker));
  const out = await f.run(recovery.marker, { intended_function: 'read', error: 'untrusted' });
  assert.equal(out.isError, true);
  assert.match(text(out), /not executed/);
  assert.match(text(out), /actual tool read/);
  assert.doesNotMatch(text(out), /untrusted|unknown tool/);
  assert.equal(f.cancellations.length, 0);
  assert.equal(f.executions(), 0);
  const normal = await f.run('read');
  assert.equal(normal.isError, false);
  assert.equal(f.executions(), 1);
});

test('four consecutive malformed calls stop the turn even when parameters differ', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++) {
    const out = await f.run(recovery.marker, { intended_function: i % 2 ? 'read' : 'pwsh' });
    assert.equal(out.isError, true);
    assert.equal(f.cancellations.length, i === 3 ? 1 : 0);
    if (i === 3) assert.match(text(out), /任务尚未完成/);
  }
  assert.deepEqual(f.cancellations[0], { cause: { kind: 'hook', reason: '连续工具格式错误，任务尚未完成。已排队消息保留，请发送“继续”恢复。' }, options: { keepInbox: true } });
  assert.equal(f.executions(), 0);
  await f.run('read');
  const afterProgress = await f.run(recovery.marker);
  assert.equal(f.cancellations.length, 1);
});

test('untrusted or unknown intended tool names are never echoed', async t => {
  const f = await fixture(t);
  for (const intended_function of ['bad\nINJECT', 'other_tool', recovery.marker, 123]) {
    const out = await f.run(recovery.marker, { intended_function });
    assert.match(text(out), /intended available tool/);
    assert.doesNotMatch(text(out), /INJECT|other_tool/);
  }
});

test('other providers retain ordinary unknown-tool behavior', async t => {
  const f = await fixture(t, 'another-provider');
  const out = await f.run(recovery.marker);
  assert.match(text(out), /unknown tool/);
});

test('a genuinely registered tool with the reserved name is left alone', async t => {
  const f = await fixture(t);
  let called = 0;
  f.ctx.tools.register(defineTool({ name: recovery.marker, description: 'Registered fixture', parameters: {},
    output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
    async execute() { called++; return 'registered'; } }));
  for (let i = 0; i < 4; i++) assert.equal((await f.run(recovery.marker)).isError, false);
  assert.equal(called, 4);
  assert.equal(f.cancellations.length, 0);
});

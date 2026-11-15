// SPDX-License-Identifier: Apache-2.0
// Real Cordis tool/prompt pipeline; no model request or player files.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as plugin from '../dsh/local-agent/tool-grounded-execution.mjs';

const require = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dsh/package.json'));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
const { SystemPrompt, renderPrompt } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-system-prompt')).href);
const { ToolRuntime } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href);
const { createUserMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);

test('real pipeline preserves results and errors without injecting user reminders', async t => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {}); await ctx.plugin(ToolRuntime, {});
  let fork = await ctx.plugin(plugin);
  t.after(() => ctx.fiber.dispose());
  const agent = { options: { provider: 'ninfer-local' }, session: { header: { agentPreset: 'ninfer-local' } } };
  const screenshot = { path: 'D:\\example\\capture.png', url: 'file:///D:/example/scene.html' };
  const content = [{ type: 'text', text: JSON.stringify(screenshot) }];
  for (const name of ['write', 'edit', 'mcp__browser__browser_screenshot', 'failure']) {
    ctx.tools.register({ name, description: 'Fixture',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: { schema: { type: 'object', properties: { path: { type: 'string' }, url: { type: 'string' } }, required: ['path', 'url'], additionalProperties: false }, render: () => structuredClone(content) },
      async execute() { if (name === 'failure') throw new Error('fixture failed'); return structuredClone(screenshot); },
    });
  }
  const prompt = caller => ctx.systemPrompt.assemble({ agent: caller }).then(renderPrompt);
  const before = await prompt(agent);
  assert.equal(before.split(plugin.policy).length - 1, 1);
  let calls = 0;
  const execute = name => ctx.tools.execute({ callId: 'fixture-' + calls++, name, arguments: {}, agent, signal: new AbortController().signal });
  // Reproduce the old state-card batch threshold and repeated screenshots.
  for (const name of [...Array(8).fill('edit'), 'write', ...Array(3).fill('mcp__browser__browser_screenshot')]) {
    const result = await execute(name);
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.deepEqual(result.value, screenshot); assert.deepEqual(result.content, content);
    assert.equal(result.additionalContexts, undefined);
    assert.equal(await prompt(agent), before);
  }
  const failed = await execute('failure');
  assert.equal(failed.isError, true); assert.equal(failed.additionalContexts, undefined);
  assert.match(JSON.stringify(failed.content), /fixture failed/);
  const other = { session: { header: { agentPreset: 'other' } } };
  assert.ok(!(await prompt(other)).includes(plugin.policy));
  // A downstream plugin's real data is preserved, never replaced or duplicated.
  const message = createUserMessage({ content: [{ type: 'text', text: 'fixture context' }], source: { kind: 'plugin', plugin: 'unrelated' } });
  const dispose = ctx.on('tools/post-execute', async (_exec, _result, next) => ({ ...await next(), additionalContexts: [message] }));
  assert.deepEqual((await execute('write')).additionalContexts, [message]); dispose();
  await fork.dispose(); assert.ok(!(await prompt(agent)).includes(plugin.policy));
  fork = await ctx.plugin(plugin);
  assert.equal(await prompt(agent), before);
  assert.equal((await execute('mcp__browser__browser_screenshot')).additionalContexts, undefined);
});

test('installed pi-ai serializer exposes plugin notices as ordinary user messages', async () => {
  const source = require.resolve('@deepseek-ai/dsh-llm-pi-ai');
  const temporary = path.join(path.dirname(source), `__notice-test-${process.pid}.mjs`);
  fs.writeFileSync(temporary, fs.readFileSync(source, 'utf8') + '\nexport { textOnlyContext as testContext };\n', { flag: 'wx' });
  try {
    const { testContext } = await import(pathToFileURL(temporary).href);
    const notice = createUserMessage({ content: [{ type: 'text', text: '[state-card] goal: repeat original task' }], source: { kind: 'plugin', plugin: 'local-state-card' } });
    const original = createUserMessage({ content: [{ type: 'text', text: 'original task' }], source: { kind: 'user' } });
    const converted = testContext({ messages: [original, notice] });
    assert.deepEqual(converted.messages.map(x => x.role), ['user', 'user']);
    assert.equal(converted.messages[1].content, notice.content[0].text);
    assert.equal(converted.messages[1].source, undefined);
  } finally { fs.unlinkSync(temporary); }
});

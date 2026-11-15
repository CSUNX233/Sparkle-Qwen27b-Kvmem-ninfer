// SPDX-License-Identifier: Apache-2.0
// Real web composition, preset, Agent loop and pi-ai HTTP serializer; no GPU.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const dsh = fileURLToPath(new URL('../dsh/', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(dsh, 'package.json'));
const yaml = require('js-yaml');

test('native web keeps the real task last, persists that order and preserves the next request prefix', { timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(dsh, '.test-context-order-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(dsh));
    assert.ok(path.basename(resolved).startsWith('.test-context-order-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const home = path.join(root, 'home'); const workspace = path.join(root, 'workspace');
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  put(path.join(workspace, 'AGENTS.md'), 'Work only inside this directory. Do not load skills or delegate.\n');
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash';
  const command = shell === 'pwsh' ? 'Write-Output READY' : 'printf READY';
  const task = `Run ${shell} once to execute ${command}, then reply READY. Do not modify files.`;
  const requests = []; const main = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    if (body.tools?.length) main.push(body);
    const call = body.tools?.length && main.length === 1;
    const delta = call ? { role: 'assistant', content: '', tool_calls: [{ index: 0, id: 'fixture-call', type: 'function', function: { name: shell, arguments: JSON.stringify({ command, description: 'Print fixture readiness' }) } }] }
      : { role: 'assistant', content: 'READY' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }]) {
      res.write('data: ' + JSON.stringify({ id: 'fixture-' + requests.length, object: 'chat.completion.chunk', model: 'probe', choices: [{ index: 0, ...choice }] }) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  put(path.join(home, 'settings.yaml'), yaml.dump({
    'llm-pi-ai': { providers: { 'ninfer-local': { api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'NINFER_LOCAL_KEY',
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: 'max_tokens', requiresReasoningContentOnAssistantMessages: true },
      models: [{ id: 'probe', name: 'probe', contextWindow: 262144, maxTokens: 73728, input: ['text'], reasoningEfforts: { xhigh: 'xhigh' } }] } } },
    'agent-default-model': { provider: 'ninfer-local', model: 'probe', reasoningEffort: 'xhigh' },
    'agent-presets': { default: 'ninfer-local' },
  }));
  for (const file of ['agent.cordis.yml', 'preset.yml']) put(path.join(home, '.agent-presets/ninfer-local', file), fs.readFileSync(path.join(repo, 'templates/dsh-preset', file), 'utf8'));
  put(path.join(home, 'profiles/web/package.json'), JSON.stringify({ name: 'context-order-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'startup' } } }));
  put(path.join(home, 'profiles/web/cordis.yml'), '[]\n');
  put(path.join(home, 'profiles/web/cordis.patch.yml'), yaml.dump([{ insert: [
    { id: 'initial-context-order', name: pathToFileURL(path.join(dsh, 'local-agent/initial-context-order.mjs')).href },
    { id: 'context-order-test-runner', name: new URL('./fixtures/initial-context-order-runner.mjs', import.meta.url).href },
  ] }]));
  let child; let stdout = ''; let stderr = '';
  const eventsFile = path.join(root, 'events.json');
  t.after(() => { if (child && child.exitCode === null) child.kill(); });
  child = spawn(process.execPath, [path.join(dsh, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--no-open', '--port', '0'], {
    cwd: workspace, env: { ...process.env, DSH_HOME: home, NINFER_LOCAL_KEY: 'fixture', DSH_PERMISSION_MODE: 'danger-full-access',
      NINFER_CONTEXT_TEST_TASK: task, NINFER_CONTEXT_TEST_EVENTS: eventsFile }, windowsHide: true,
  });
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, stderr.replace(/https?:\/\/127\.0\.0\.1:[^\s]+/g, '[local test URL]').slice(-1500));
  assert.equal(main.length, 2);
  for (const request of main) assert.equal(request.messages.filter(message => message.role === 'user').at(-1).content, task);
  assert.ok(JSON.stringify(main[0].messages) === JSON.stringify(main[1].messages.slice(0, main[0].messages.length)), 'a later tool step changed the initial request prefix');
  const events = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
  const users = events.filter(event => event.type === 'user/message');
  assert.equal(users.at(-1).data.source.kind, 'user');
  assert.equal(users.filter(event => event.data.source.kind === 'user').length, 1);
  assert.equal(events.filter(event => event.type === 'tool/call').length, 1);
  const results = events.filter(event => event.type === 'tool/result').flatMap(event => event.data.message.content);
  assert.ok(results.every(block => !block.isError), 'fixture shell command was rejected: ' + JSON.stringify(results.filter(block => block.isError)).slice(0, 800));
  assert.ok(results.some(block => block.content?.some(part => part.type === 'text' && /\bREADY\b/.test(part.text))), 'fixture shell command did not produce READY');
  assert.equal(events.filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'completed');
  const titles = requests.filter(request => !request.tools?.length);
  assert.ok(titles.length > 0 && titles.every(request => JSON.stringify(request.messages).includes(command)), 'title generation lost the real task');
  assert.ok(stdout.length > 0);
});

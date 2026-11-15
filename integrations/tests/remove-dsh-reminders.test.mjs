// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { migrateProfile, removeInjectedReminders } from '../../scripts/remove-dsh-reminders.mjs';

const dsh = fileURLToPath(new URL('../dsh/', import.meta.url));
const yaml = createRequire(path.join(dsh, 'package.json'))('js-yaml');
const url = 'file:///D:/example/tool-grounded-execution.mjs?v=clean';
const fixture = [
  { id: 'custom-route', config: { provider: 'custom', model: 'unchanged', reasoningEffort: 'xhigh' } },
  { id: 'repeat-tool-reminder', disabled: false, config: { thresholds: [2, 4] } },
  { insert: [
    ...['state-card', 'todo-completion', 'task-ledger', 'early-stop-recovery'].map(id => ({ id, name: 'file:///old/' + id + '.mjs' })),
    { id: 'tool-grounded-execution', name: 'file:///old/guidance.mjs', disabled: false, config: { unrelated: true } },
    { id: 'edit-guard', name: 'file:///old/edit-guard.mjs' },
    { id: 'tool-call-recovery', name: 'file:///old/recovery.mjs' },
    { id: 'browser', config: { command: 'node', args: ['browser.mjs'], env: { USER_SETTING: 'preserved' } } },
    { insert: [{ id: 'local-state-card' }, { id: 'custom' }] },
  ] },
];

test('migration removes reminders and replaces screenshot hook while preserving unrelated settings', () => {
  const before = structuredClone(fixture);
  const next = removeInjectedReminders(fixture, url);
  assert.deepEqual(fixture, before);
  assert.deepEqual(next[0], fixture[0]);
  assert.deepEqual(next.at(-1), { id: 'repeat-tool-reminder', disabled: true });
  assert.deepEqual(next[1].insert, [
    { ...fixture[2].insert[4], name: url },
    ...fixture[2].insert.slice(5, 8),
    { insert: [{ id: 'custom' }] },
  ]);
  assert.deepEqual(removeInjectedReminders(next, url), next);
});

test('migration rejects invalid YAML structures before any write', () => {
  for (const value of [null, {}, ['invalid'], [{ insert: {} }]]) {
    assert.throws(() => removeInjectedReminders(value, url));
  }
  assert.throws(() => removeInjectedReminders([], undefined));
});

test('query-origin installation is explicit, unique and repeatable', () => {
  const origin = 'file:///D:/example/initial-context-order.mjs?v=clean';
  const previous = [...fixture, { insert: [{ id: 'initial-context-order', name: 'file:///old/order.mjs', disabled: true }] }];
  const next = removeInjectedReminders(previous, url, origin);
  const rows = next.flatMap(row => row.insert ?? [row]).filter(row => row.id === 'initial-context-order');
  assert.deepEqual(rows, [{ id: 'initial-context-order', name: origin }]);
  assert.deepEqual(removeInjectedReminders(next, url, origin), next);
  // Reminder-only migration must preserve an explicitly disabled origin hook.
  assert.ok(removeInjectedReminders(previous, url).at(-2).insert[0].disabled);
  assert.throws(() => removeInjectedReminders(previous, url, 'https://invalid'));
});

test('actual profile update backs up exact bytes, is repeatable and leaves sessions/config untouched', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-reminder-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'profiles/web'), { recursive: true });
  const file = path.join(home, 'profiles/web/cordis.patch.yml');
  const before = '# user comment\n' + yaml.dump(fixture);
  fs.writeFileSync(file, before);
  const untouched = { 'settings.yaml': 'model: custom\nvision: gpu\n', 'session.jsonl': '{"private":"history retained"}\n', 'local.json': '{"VisionGPU":true,"HostKVMiB":7168}' };
  for (const [name, value] of Object.entries(untouched)) fs.writeFileSync(path.join(home, name), value);
  const options = { home, dependencyRoot: dsh };
  const result = migrateProfile(options);
  assert.equal(result.changed, true);
  assert.equal(fs.readFileSync(result.backup, 'utf8'), before);
  const parsed = yaml.load(fs.readFileSync(file, 'utf8'));
  assert.match(parsed[1].insert[0].name, /tool-grounded-execution\.mjs\?v=[a-f0-9]{12}$/);
  assert.equal(migrateProfile(options).changed, false);
  assert.equal(fs.readdirSync(path.dirname(file)).length, 2);
  for (const [name, value] of Object.entries(untouched)) assert.equal(fs.readFileSync(path.join(home, name), 'utf8'), value);
});

test('missing or malformed existing profile fails without fabricating an installation', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-missing-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.throws(() => migrateProfile({ home, dependencyRoot: dsh }), /ENOENT/);
  assert.deepEqual(fs.readdirSync(home), []);
  fs.mkdirSync(path.join(home, 'profiles/web'), { recursive: true });
  const file = path.join(home, 'profiles/web/cordis.patch.yml');
  fs.writeFileSync(file, 'invalid: shape\n');
  assert.throws(() => migrateProfile({ home, dependencyRoot: dsh }), /patch array/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'invalid: shape\n');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['cordis.patch.yml']);
});

test('real configuration generator removes obsolete entries even when old options remain true', t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-generator-test-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const put = (relative, text) => {
    const file = path.join(sandbox, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  };
  for (const file of ['scripts/configure-dsh.mjs', 'scripts/remove-dsh-reminders.mjs',
    'integrations/dsh/local-agent/tool-grounded-execution.mjs', 'integrations/dsh/local-agent/initial-context-order.mjs', 'integrations/dsh/local-agent/tool-call-recovery.mjs',
    'integrations/dsh/local-agent/edit-guard.mjs', 'integrations/dsh/local-web/web-provider.mjs']) {
    put(file, fs.readFileSync(path.join(repo, file), 'utf8'));
  }
  const require = createRequire(path.join(dsh, 'package.json'));
  put('integrations/dsh/package.json', '{}');
  // Only the YAML dependency is delegated; writable patch targets are isolated.
  put('integrations/dsh/node_modules/js-yaml/index.js', 'module.exports = require(' + JSON.stringify(require.resolve('js-yaml')) + ');');
  for (const name of ['cordis-plugin-loader', 'dsh-app-boot', 'dsh-agent-presets', 'dsh-typert-loader', 'dsh-compaction-basic', 'dsh-compaction-tool-result-pruner']) {
    put(`integrations/dsh/node_modules/@deepseek-ai/${name}/package.json`, JSON.stringify({ version: name === 'cordis-plugin-loader' ? '1.0.3' : '0.1.5-rc.3' }));
  }
  const cfg = { ModelId: 'custom-model', GuardPort: 1236, MaxContext: 262144, ReasoningEffort: 'xhigh', VisionGPU: true, StateCard: true, TaskLedger: true };
  put('config/local.json', JSON.stringify(cfg));
  put('templates/dsh-preset/agent.cordis.yml', '[]\n'); put('templates/dsh-preset/preset.yml', '{}\n');
  put('runtime/dsh-home/profiles/web/cordis.patch.yml', yaml.dump(fixture));
  const run = () => {
    const result = spawnSync(process.execPath, [path.join(sandbox, 'scripts/configure-dsh.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(path.join(sandbox, 'runtime/dsh-home/profiles/web/cordis.patch.yml'), 'utf8');
  };
  const first = run(); assert.equal(run(), first);
  const parsed = yaml.load(first);
  assert.deepEqual(parsed[0], fixture[0]);
  assert.deepEqual(parsed.find(x => x.id === 'repeat-tool-reminder'), { id: 'repeat-tool-reminder', disabled: true });
  for (const id of ['state-card', 'task-ledger', 'todo-completion', 'early-stop-recovery']) assert.ok(!first.includes('id: ' + id));
  assert.equal(fs.readFileSync(path.join(sandbox, 'config/local.json'), 'utf8'), JSON.stringify(cfg));
  const order = patch => yaml.load(patch).flatMap(row => row.insert ?? []).find(row => row.id === 'initial-context-order');
  assert.equal(order(first).disabled, true);
  cfg.InitialContextOrder = true;
  put('config/local.json', JSON.stringify(cfg));
  assert.equal(order(run()).disabled, false);
  assert.equal(fs.readFileSync(path.join(sandbox, 'config/local.json'), 'utf8'), JSON.stringify(cfg));
});

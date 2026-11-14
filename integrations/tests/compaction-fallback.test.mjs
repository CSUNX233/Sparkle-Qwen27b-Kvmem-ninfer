import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../dsh/patches/dsh-compaction-basic.js', import.meta.url));
const root = process.env.NINFER_DSH_TEST_ROOT ?? fileURLToPath(new URL('../dsh/', import.meta.url));
const temporary = path.join(root, 'patches', `__compaction-test-${process.pid}.mjs`);
fs.writeFileSync(temporary, fs.readFileSync(source, 'utf8') + '\nexport { summarizeWithLlm as testSummarize };\n', { flag: 'wx' });
after(() => fs.unlinkSync(temporary));
const { testSummarize, BasicCompactionEngine } = await import(pathToFileURL(temporary).href);
const input = { messages: [], tools: [] };
const config = { summarizationProvider: '', summarizationModel: '', maxTokens: 8192 };
const agent = provider => ({ session: { id: 'test', requestHeader: () => ({ config: { provider, model: 'model' } }) }, options: {} });

function service(outcomes) {
  const calls = [];
  return {
    calls,
    ctx: { llm: { async *stream(options) {
      calls.push(options);
      const result = outcomes[calls.length - 1];
      if (result.throw) throw new Error(result.throw);
      if (result.text) yield { type: 'text-delta', index: 0, text: result.text };
      yield { type: 'finish', reason: { kind: result.finish } };
    } } },
  };
}

test('local truncated summary retries once with low effort and discards partial output', async () => {
  const checkpoint = ['Primary Request and Intent', 'Key Technical Concepts', 'Files and Code', 'Errors and Fixes', 'Pending Jobs', 'Current Work', 'Next Step', 'Critical Context'].map(x => `## ${x}\n- retained`).join('\n');
  const s = service([{ finish: 'max-tokens', text: 'partial' }, { finish: 'stop', text: checkpoint }]);
  const result = await testSummarize(s.ctx, config, input, agent('ninfer-local'));
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[0].reasoningEffort, undefined);
  assert.equal(s.calls[1].reasoningEffort, 'low');
  assert.equal(result.summary[0].text, checkpoint);
  assert.equal(s.calls[1].maxTokens, 8192);
});

test('successful first attempt leaves normal reasoning untouched', async () => {
  const s = service([{ finish: 'stop', text: 'checkpoint' }]);
  await testSummarize(s.ctx, config, input, agent('ninfer-local'));
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].reasoningEffort, undefined);
});

test('other providers, retry truncation and transport errors fail closed', async () => {
  for (const [provider, outcomes, expectedCalls, expectedCode] of [
    ['remote', [{ finish: 'max-tokens' }], 1, 'MAX_TOKENS'],
    ['ninfer-local', [{ finish: 'max-tokens' }, { finish: 'max-tokens' }], 2, 'COMPACTION_INCOMPLETE'],
    ['ninfer-local', [{ finish: 'max-tokens' }, { finish: 'stop', text: 'incomplete summary' }], 2, 'COMPACTION_INCOMPLETE'],
    ['ninfer-local', [{ finish: 'max-tokens' }, { finish: 'stop' }], 2, 'COMPACTION_INCOMPLETE'],
    ['ninfer-local', [{ throw: 'transport failed' }], 1, undefined],
  ]) {
    const s = service(outcomes);
    await assert.rejects(testSummarize(s.ctx, config, input, agent(provider)), error => error.code === expectedCode);
    assert.equal(s.calls.length, expectedCalls);
  }
});

test('an incomplete local fallback stops the turn instead of starting another step', async () => {
  const handlers = new Map();
  const ctx = { on: (name, handler) => handlers.set(name, handler), logger: { warn() {}, info() {} } };
  const error = Object.assign(new Error('incomplete checkpoint'), { code: 'COMPACTION_INCOMPLETE' });
  const engine = { ctx, compactIfNeeded: async () => { throw error; }, warnedPressureConfigTargets: new Set() };
  BasicCompactionEngine.prototype._registerAutomaticCompaction.call(engine);
  let nextCalls = 0;
  await assert.rejects(handlers.get('agent/pre-step')({ agent: {}, signal: new AbortController().signal }, async () => { nextCalls++; }), /incomplete checkpoint/);
  assert.equal(nextCalls, 0);
});

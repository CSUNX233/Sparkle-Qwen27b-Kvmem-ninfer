// SPDX-License-Identifier: Apache-2.0
// Native web/preset fixture. Its HTTP provider is owned by the parent test.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(new URL('../../dsh/package.json', import.meta.url));
const { installModelSelection } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-agent')).href);
const { createUserMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);

export const name = 'initial-context-order-test-runner';
export const inject = ['agents', 'agentDefaultModel', 'agentPresets', 'sessions'];

export function apply(ctx) {
  const exit = ctx.get('appExit');
  async function run() {
    await ctx.get('loader')?.await();
    const selection = ctx.agentDefaultModel.currentSelection();
    const { agent } = await ctx.agents.create({
      sessionId: 'session-context-order-test',
      meta: { cwd: process.cwd(), agentPreset: 'ninfer-local' },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async agentCtx => {
        await ctx.agentPresets.mount(agentCtx, 'ninfer-local');
        installModelSelection(agentCtx, { current: selection, assembled: undefined });
      },
    });
    await agent.whenIdle();
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: process.env.NINFER_CONTEXT_TEST_TASK }],
      source: { kind: 'user' },
    }));
    await agent.whenIdle();
    await ctx.sessions.flush(agent.session);
    fs.writeFileSync(process.env.NINFER_CONTEXT_TEST_EVENTS, JSON.stringify(agent.session.snapshotEvents()));
    exit(0);
  }
  run().catch(error => { console.error(error); exit(1); });
}

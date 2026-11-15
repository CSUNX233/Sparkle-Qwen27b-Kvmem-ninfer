// SPDX-License-Identifier: Apache-2.0
// Order the first admission before persistence; never rewrite existing events.
// pi-ai sends native background notices as user messages. Keep the actual task
// last so NInfer's last-user retrieval query cannot become a skill catalog.
export const name = 'local-initial-context-order';
export const inject = ['sessionProjections'];

const knownNotice = message => message.source?.kind === 'agent-instructions' ||
  message.source?.kind === 'skill-catalog' ||
  (message.source?.kind === 'plugin' && message.source.plugin === '@deepseek-ai/dsh-system-prompt');

export function orderInitialContext(messages) {
  if (!Array.isArray(messages) || messages.some(message => message.role !== 'user' ||
      !Array.isArray(message.content) || message.content.some(block => block.type !== 'text'))) return messages;
  if (!messages.some(message => message.source?.kind === 'user') ||
      messages.some(message => message.source?.kind !== 'user' && !knownNotice(message))) return messages;
  const ordered = [...messages.filter(knownNotice), ...messages.filter(message => message.source?.kind === 'user')];
  return ordered.every((message, index) => message === messages[index]) ? messages : ordered;
}

export function apply(ctx) {
  ctx.on('agent/pre-step', async (input, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || input.signal?.aborted || !input.agent ||
        input.agent.options?.provider !== 'ninfer-local' || input.agent.session.requestHeader() ||
        input.agent.session.header?.agentPreset !== 'ninfer-local') return decision;
    const plan = ctx.sessionProjections.stateOf(input.agent.session, 'plan');
    if (plan?.active || plan?.wanted === true) return decision;
    const messages = orderInitialContext(decision.messages);
    ctx.logger?.debug?.('initial-context-order: %s (%d admitted messages)', messages === decision.messages ? 'unchanged' : 'ordered', messages?.length ?? 0);
    return messages === decision.messages ? decision : { ...decision, messages };
  });
}

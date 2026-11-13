// SPDX-License-Identifier: Apache-2.0
// Handle the engine's reserved, non-executable malformed-call marker without
// registering it as a model-facing tool or guessing any missing arguments.
import { isLocalAgent } from './tool-grounded-execution.mjs';

export const name = 'local-tool-call-recovery';
export const inject = ['tools'];
export const marker = 'malformed_tool_call';
export const maxConsecutiveFailures = 4;

// The current tool/call event is appended by the loop before pre-execute.
// Count only consecutive markers in the current turn; any other tool call or
// new user turn breaks the streak. No per-session state or private log is kept.
export function consecutiveMarkers(events, currentCallId) {
  let count = 0;
  let sawCurrent = false;
  for (let i = events.length - 1, scanned = 0; i >= 0 && scanned < 512; i--, scanned++) {
    const event = events[i];
    if (event?.type === 'turn/start' || event?.type === 'turn/end' ||
        (event?.type === 'user/message' && event.data?.source?.kind === 'user')) break;
    if (event?.type !== 'tool/call') continue;
    if (!sawCurrent) {
      if (event.data?.callId !== currentCallId) continue;
      sawCurrent = true;
    }
    if (event.data?.name !== marker) break;
    count++;
  }
  return sawCurrent ? count : 1;
}

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== marker || !isLocalAgent(exec.agent) || exec.signal?.aborted ||
        ctx.tools.get(marker, exec.agent)) return next();
    const decision = await next();
    if (decision.kind !== 'allow' || exec.signal?.aborted) return decision;

    const proposed = exec.arguments?.intended_function;
    const intended = typeof proposed === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(proposed) &&
      proposed !== marker && ctx.tools.get(proposed, exec.agent) ? proposed : null;
    const count = consecutiveMarkers(exec.agent.session?.snapshotEvents?.() ?? [], exec.callId);
    let reason = 'Tool call format error: this call was not executed. malformed_tool_call is an error marker, not a tool. ' +
      (intended ? `Retry the actual tool ${intended}` : 'Retry the intended available tool') +
      ' with complete, separate parameter tags; split a long write or command into smaller calls. Do not guess or execute incomplete arguments.';
    if (count >= maxConsecutiveFailures) {
      reason += ' Repeated format errors: the task is NOT complete. 本轮因工具格式连续出错而停止，任务尚未完成。已排队消息会保留但可能等待唤醒；请发送“继续”从已保存进度恢复。';
    }
    return { kind: 'deny', reason };
  });
  // dsh only honors concludeTurn() for successful registered tools. Use its
  // supported cancellation API after the error is finalized instead, keeping
  // any user messages already queued for a subsequent turn.
  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== marker || !result.isError || !isLocalAgent(exec.agent) ||
        exec.signal?.aborted || ctx.tools.get(marker, exec.agent) ||
        consecutiveMarkers(exec.agent.session?.snapshotEvents?.() ?? [], exec.callId) < maxConsecutiveFailures) return;
    exec.agent.cancel?.({ kind: 'hook', reason: '连续工具格式错误，任务尚未完成。已排队消息保留，请发送“继续”恢复。' }, { keepInbox: true });
  });
}

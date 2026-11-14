// SPDX-License-Identifier: Apache-2.0
// Deterministic state card + code/error digest for long local-agent turns.
// It batches tool evidence into occasional, append-only step checkpoints.
// It never rewrites history, changes tool arguments, or executes tools.
import crypto from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { isLocalAgent } from './tool-grounded-execution.mjs';

export const name = 'local-state-card';
export const inject = ['sessionProjections'];

const MAX_CARD_CHARS = 1900;
const MAX_ATTEMPTS = 8;
const MAX_FILES = 8;
const MUTATIONS_PER_CARD = 8;
const SIGNATURE_RE = /^\s*(?:async\s+)?(?:def|class|function)\s+[A-Za-z_$][\w$]*|^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=|^\s*[A-Z][A-Z0-9_]{2,}\s*=/;
const ERROR_RE = /\b(?:Traceback|SyntaxError|TypeError|ValueError|RuntimeError|NameError|ImportError|Unexpected token|ERROR|FATAL|failed)\b/i;

function textBlocks(content) {
  return (content ?? []).filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n');
}

function clip(value, limit) {
  const text = String(value ?? '');
  return text.length <= limit ? text : text.slice(0, limit) + '…';
}

export function digestCode(text, filePath = '') {
  const source = typeof text === 'string' ? text : '';
  const lines = source.split(/\r?\n/);
  const signatures = [];
  const constants = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 200) continue;
    if (SIGNATURE_RE.test(line)) {
      if (/^(?:[A-Z][A-Z0-9_]{2,})\s*=/.test(trimmed)) {
        if (constants.length < 8) constants.push(clip(trimmed, 120));
      } else if (signatures.length < 12) {
        signatures.push(clip(trimmed, 120));
      }
    }
  }
  const tail = lines.filter(line => line.trim()).slice(-4).map(line => clip(line, 120));
  return {
    path: clip(filePath, 240),
    chars: source.length,
    sha: source ? crypto.createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 12) : null,
    signatures,
    constants,
    tail,
  };
}

export function digestError(text, fallback = false) {
  const source = typeof text === 'string' ? text : '';
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const hits = lines.filter(line => ERROR_RE.test(line));
  if (!hits.length && !fallback) return [];
  const chosen = (hits.length ? hits.slice(-6) : lines.slice(-6));
  return chosen.map(line => clip(line, 180));
}

function parseArgs(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try { return JSON.parse(value); } catch { return {}; }
}

export function summarizeArgs(toolName, args) {
  if (!args || typeof args !== 'object') return '';
  if (toolName === 'write' || toolName === 'edit') {
    return clip(args.file_path ?? args.path ?? '', 240);
  }
  if (toolName === 'pwsh' || toolName === 'bash') {
    return clip(args.command ?? args.cmd ?? '', 220);
  }
  return clip(JSON.stringify(args), 160);
}

function latestUserGoal(agent) {
  const events = agent?.session?.snapshotEvents?.() ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user') continue;
    const text = textBlocks(event.data.content).slice(0, 600);
    if (text) return text;
  }
  return '';
}

function stateFor(agent) {
  let state = states.get(agent);
  if (!state) {
    state = { goal: latestUserGoal(agent), files: [], attempts: [], lastOk: '', lastErr: [], lastCard: '', mutations: 0, revision: 0, dirty: false, urgent: false, seenErrors: new Set() };
    states.set(agent, state);
  }
  return state;
}

const states = new WeakMap();

export function buildStateCard(state) {
  const payload = {
    goal: clip(state.goal, 420),
    successful_mutations: state.revision ?? 0,
    files: state.files.slice(0, MAX_FILES).map(file => ({
      path: clip(file.path, 200),
      scope: clip(file.scope ?? 'recorded fragment; not a full-file snapshot', 80),
    })),
    attempts: state.attempts.slice(-5).map(item => ({
      t: item.tool, a: clip(item.summary, 160), ok: item.ok, err: (item.err ?? []).slice(-2),
    })),
    last_ok: clip(state.lastOk, 260),
    last_err: (state.lastErr ?? []).slice(-4).map(x => clip(x, 180)),
    note: 'Tool checkpoint; not a new user request or proof of completion. Files list successful mutations, not verified contents. Do not repeat a failed command without new evidence.',
  };
  const serialize = () => '[state-card v2]\n' + JSON.stringify(payload);
  // Trim whole fields/items, never cut serialized JSON in the middle.
  while (serialize().length > MAX_CARD_CHARS && payload.attempts.length) payload.attempts.shift();
  while (serialize().length > MAX_CARD_CHARS && payload.files.length > 1) payload.files.pop();
  if (serialize().length > MAX_CARD_CHARS) {
    payload.goal = clip(payload.goal, 160);
    payload.last_ok = clip(payload.last_ok, 100);
    payload.last_err = payload.last_err.slice(-1).map(x => clip(x, 180));
  }
  return serialize();
}

export function collectText(content) {
  let out = '';
  for (const block of content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      out += block.text + '\n';
    } else if (block?.type === 'tool-result' && Array.isArray(block.content)) {
      out += collectText(block.content);
    }
  }
  return out.replace(/\n$/, '');
}

export function hasImageBlock(content) {
  for (const block of content ?? []) {
    if (block?.type === 'image') return true;
    if (block?.type === 'tool-result' && hasImageBlock(block.content)) return true;
  }
  return false;
}

export function sessionHasMedia(agent) {
  const events = agent?.session?.snapshotEvents?.() ?? [];
  for (const event of events) {
    const data = event?.data ?? {};
    if (event?.type === 'user/message' && hasImageBlock(data.content)) return true;
    if (event?.type === 'tool/result' && hasImageBlock(data.message?.content)) return true;
  }
  return false;
}

function resultText(result, downstream) {
  return [collectText(result?.content), collectText(downstream?.content)].filter(Boolean).join('\n');
}

export function apply(ctx) {
  if (process.env.LOCAL_STATE_CARD === '0') return;
  // All tools in one step update one pending checkpoint. A successful edit by
  // itself does not warrant a synthetic user message. Emit only after eight
  // mutations, or a new error, once on the next admitted step.
  ctx.on('agent/pre-step', async ({ agent, signal, messages = [], step }, next) => {
    const downstream = await next();
    if (!agent || signal?.aborted || !isLocalAgent(agent) || downstream.kind === 'reject') return downstream;
    const state = stateFor(agent);
    if (messages.some(message => message.source?.kind === 'user')) {
      state.goal = latestUserGoal(agent);
      const latest = messages.filter(message => message.source?.kind === 'user').at(-1);
      if (latest) state.goal = textBlocks(latest.content).slice(0, 600);
      state.attempts = []; state.lastErr = []; state.seenErrors.clear();
      state.lastCard = '';
      state.dirty = false; state.urgent = false; state.mutations = 0;
      return downstream;
    }
    if (!state.dirty || (!state.urgent && state.mutations < MUTATIONS_PER_CARD)) return downstream;
    const plan = ctx.get('sessionProjections')?.stateOf?.(agent.session, 'plan');
    if (plan?.active || plan?.wanted === true || sessionHasMedia(agent) ||
        (downstream.messages?.length === 0 && (step === 1 || messages.length > 0))) return downstream;
    const card = buildStateCard(state);
    if (card === state.lastCard) return downstream;
    state.lastCard = card; state.dirty = false; state.urgent = false; state.mutations = 0;
    return { ...downstream, messages: [...(downstream.messages ?? []), createUserMessage({
      content: [{ type: 'text', text: card }],
      source: { kind: 'plugin', plugin: name, form: 'notice', summary: '合并工具检查点' },
    })] };
  });
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next();
    const agent = exec.agent;
    if (!agent || exec.signal?.aborted || !isLocalAgent(agent)) return downstream;
    // The parser's error carrier is not an executed tool or a code attempt.
    if (exec.name === 'malformed_tool_call') return downstream;
    const projections = ctx.get('sessionProjections');
    const plan = projections?.stateOf?.(agent.session, 'plan');
    if (plan?.active || plan?.wanted === true) return downstream;
    if (downstream.kind === 'block') return downstream;
    const toolName = String(exec.name ?? '');
    const args = parseArgs(exec.arguments);
    const output = resultText(result, downstream);
    // Reading source code mentioning TypeError/Traceback is not a failed tool.
    const error = !!result.isError || downstream.value?.isError === true;
    const digest = error ? digestError(output, true) : [];
    const state = stateFor(agent);
    const summary = summarizeArgs(toolName, args);
    const entry = {
      tool: toolName,
      summary,
      ok: !error,
      err: error ? digest : [],
    };
    state.attempts.push(entry);
    if (state.attempts.length > MAX_ATTEMPTS) state.attempts.shift();
    if (error) {
      state.lastErr = digest;
      const key = crypto.createHash('sha256').update(JSON.stringify([toolName, args, digest])).digest('hex');
      if (!state.seenErrors.has(key)) { state.urgent = true; state.dirty = true; }
      state.seenErrors.add(key);
      if (state.seenErrors.size > 64) state.seenErrors.delete(state.seenErrors.values().next().value);
    }
    if (!error && (toolName === 'pwsh' || toolName === 'bash')) {
      state.lastOk = clip(`${summary} -> ${clip(output, 150)}`, 260);
    }
    if (!error && (toolName === 'write' || toolName === 'edit')) {
      const filePath = String(args.file_path ?? args.path ?? '');
      const file = { path: filePath, scope: 'successful mutation only; contents not verified' };
      state.files = [file, ...state.files.filter(item => item.path !== file.path)].slice(0, MAX_FILES);
      state.mutations++; state.revision++; state.dirty = true;
    }
    return downstream;
  });
}

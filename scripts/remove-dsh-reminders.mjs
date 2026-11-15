// SPDX-License-Identifier: Apache-2.0
// Narrow migration: no provider, preset, model, sampling or session rewrites.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const retired = new Set(['state-card', 'local-state-card', 'task-ledger', 'local-task-ledger', 'todo-completion', 'local-todo-completion', 'early-stop-recovery', 'local-early-stop-recovery']);

export function removeInjectedReminders(patch, guidanceURL, contextOrderURL) {
  if (!Array.isArray(patch)) throw new TypeError('Expected a DSH patch array');
  if (typeof guidanceURL !== 'string' || !guidanceURL.startsWith('file:')) throw new TypeError('Expected a guidance file URL');
  if (contextOrderURL !== undefined && !contextOrderURL.startsWith('file:')) throw new TypeError('Expected a context-order file URL');
  function clean(entries) {
    return entries.flatMap(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('Invalid DSH patch entry');
      if (retired.has(entry.id) || entry.id === 'repeat-tool-reminder') return [];
      if (contextOrderURL && entry.id === 'initial-context-order') return [];
      const row = { ...entry };
      if (row.id === 'tool-grounded-execution') row.name = guidanceURL;
      if (Object.hasOwn(row, 'insert')) {
        if (!Array.isArray(row.insert)) throw new TypeError('Expected an insert array');
        row.insert = clean(row.insert);
        if (!row.insert.length) {
          delete row.insert;
          if (!Object.keys(row).length) return [];
        }
      }
      return [row];
    });
  }
  return [...clean(patch),
    ...(contextOrderURL ? [{ insert: [{ id: 'initial-context-order', name: contextOrderURL }] }] : []),
    { id: 'repeat-tool-reminder', disabled: true }];
}

export function migrateProfile({ home, dependencyRoot = path.join(root, 'integrations/dsh'), guidanceFile = path.join(root, 'integrations/dsh/local-agent/tool-grounded-execution.mjs'), contextOrderFile }) {
  const require = createRequire(path.join(path.resolve(dependencyRoot), 'package.json'));
  const yaml = require('js-yaml');
  const file = path.join(path.resolve(home), 'profiles/web/cordis.patch.yml');
  const before = fs.readFileSync(file, 'utf8'); // Missing/wrong home must fail.
  guidanceFile = path.resolve(guidanceFile);
  const guidance = fs.readFileSync(guidanceFile);
  const url = pathToFileURL(guidanceFile).href + '?v=' + crypto.createHash('sha256').update(guidance).digest('hex').slice(0, 12);
  const previous = yaml.load(before);
  let contextOrderURL;
  if (contextOrderFile) {
    contextOrderFile = path.resolve(contextOrderFile);
    const bytes = fs.readFileSync(contextOrderFile);
    contextOrderURL = pathToFileURL(contextOrderFile).href + '?v=' + crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  }
  const next = removeInjectedReminders(previous, url, contextOrderURL);
  if (JSON.stringify(previous) === JSON.stringify(next)) return { changed: false, file };
  const output = yaml.dump(next, { lineWidth: 120, noRefs: true });
  const backup = file + '.before-reminder-removal-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  fs.writeFileSync(backup, before, { flag: 'wx' });
  // The web profile may be live-watched: publish the complete YAML atomically.
  const temporary = backup + '.tmp';
  try {
    fs.writeFileSync(temporary, output, { flag: 'wx' });
    if (fs.readFileSync(file, 'utf8') !== before) throw new Error('Profile changed during migration; refusing to overwrite');
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return { changed: true, file, backup };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = { home: path.join(root, 'runtime/dsh-home') };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--fix-query-origin') {
      options.contextOrderFile = path.join(root, 'integrations/dsh/local-agent/initial-context-order.mjs');
      continue;
    }
    const key = { '--home': 'home', '--dsh': 'dependencyRoot' }[args[i]];
    if (!key || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Usage: node scripts/remove-dsh-reminders.mjs [--home DSH_HOME] [--dsh DSH_INSTALL] [--fix-query-origin]');
    options[key] = path.resolve(args[++i]);
  }
  console.log(JSON.stringify(migrateProfile(options), null, 2));
}

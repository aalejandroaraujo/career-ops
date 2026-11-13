/**
 * provider-config.mjs — which AI CLI (and which model) runs batch workers.
 *
 * One reader and one writer for the `provider:` block of config/profile.yml, so
 * the ingest server, the queue health probe and the web UI cannot disagree about
 * what is active. batch/provider.sh and daily-scout.sh read the same block from
 * bash.
 *
 * Precedence, everywhere: CAREEROPS_PROVIDER / CAREEROPS_MODEL env > profile.yml
 * > default. An env override wins over anything saved from the UI, so the
 * payload says when one is in force and the UI can show the choice as locked.
 *
 * The picker existed before this file but never persisted anything: its POST was
 * a no-op, so a reload reverted it and Telegram, Hermes and daily-scout never saw
 * the choice at all (2026-09-15, while Qwen's token plan was exhausted).
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_PROVIDER = 'claude';

/**
 * Models offered per provider. `id: ''` means "let the CLI pick its default".
 * Claude aliases track the newest model of each family, so they do not go stale.
 * The Qwen list mirrors the Bailian token-plan models in ~/.qwen/settings.json;
 * the container has no copy of that file, so it is kept here. Any other id can
 * still be saved as a custom model.
 */
export const CATALOG = {
  claude: {
    label: 'Claude Code',
    models: [
      { id: '', label: 'CLI default' },
      { id: 'opus', label: 'Opus (latest)', hint: 'strongest, slowest, most usage' },
      { id: 'sonnet', label: 'Sonnet (latest)', hint: 'balanced' },
      { id: 'haiku', label: 'Haiku (latest)', hint: 'fastest, least usage' },
    ],
  },
  qwen: {
    label: 'Qwen Code',
    models: [
      { id: '', label: 'CLI default' },
      { id: 'qwen3.8-max', label: 'Qwen 3.8 Max' },
      { id: 'qwen3.7-max', label: 'Qwen 3.7 Max' },
      { id: 'qwen3.7-plus', label: 'Qwen 3.7 Plus' },
      { id: 'qwen3.6-flash', label: 'Qwen 3.6 Flash' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' },
      { id: 'glm-5.2', label: 'GLM 5.2' },
    ],
  },
};

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,79}$/;

/** @param {string} root */
const profilePath = (root) => join(root, 'config', 'profile.yml');

/**
 * Read a scalar from the top-level `provider:` block.
 *
 * @param {string} yml - profile.yml contents.
 * @param {string} key - Key inside the block.
 * @returns {string|null}
 */
function blockValue(yml, key) {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => /^provider:\s*(#.*)?$/.test(l));
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l)) break; // next top-level key ends the block
    const m = l.match(new RegExp(`^\\s+${key}:\\s*"?([^"#]*?)"?\\s*(#.*)?$`));
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Current provider + model, with where each came from.
 *
 * @param {{root?: string, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {{provider: string, model: string, locked: {provider: boolean, model: boolean}, catalog: typeof CATALOG}}
 */
export function readProviderConfig({ root = ROOT, env = process.env } = {}) {
  let yml = '';
  try { yml = readFileSync(profilePath(root), 'utf8'); } catch { /* no profile yet */ }
  const envProvider = (env.CAREEROPS_PROVIDER || '').trim();
  const envModel = (env.CAREEROPS_MODEL || '').trim();
  const provider = envProvider || blockValue(yml, 'name') || DEFAULT_PROVIDER;
  const model = envModel || blockValue(yml, 'model') || '';
  return {
    provider,
    model,
    locked: { provider: Boolean(envProvider), model: Boolean(envModel) },
    catalog: CATALOG,
  };
}

/**
 * Validate a requested provider/model pair.
 *
 * @param {unknown} provider
 * @param {unknown} model
 * @returns {string|null} Error message, or null when valid.
 */
export function validateProviderChoice(provider, model) {
  if (typeof provider !== 'string' || !Object.hasOwn(CATALOG, provider)) {
    return `provider must be one of: ${Object.keys(CATALOG).join(', ')}`;
  }
  if (model !== undefined && model !== null && model !== '' && (typeof model !== 'string' || !MODEL_RE.test(model))) {
    return 'model must be empty (CLI default) or an id like "sonnet" or "qwen3.8-max"';
  }
  return null;
}

/**
 * Rewrite `name:` and `model:` inside the `provider:` block, keeping every other
 * line (comments included) byte-for-byte. Creates the block when missing.
 *
 * @param {string} yml - Current profile.yml contents.
 * @param {string} provider
 * @param {string} model
 * @returns {string} New contents.
 */
export function applyProviderChoice(yml, provider, model) {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => /^provider:\s*(#.*)?$/.test(l));
  const nameLine = `  name: "${provider}"`;
  const modelLine = `  model: "${model}"`;
  if (start === -1) {
    return ['provider:', nameLine, modelLine, '', ...lines].join('\n');
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) { end = i; break; }
  }
  let sawName = false;
  let sawModel = false;
  for (let i = start + 1; i < end; i++) {
    if (/^\s+name:/.test(lines[i])) { lines[i] = nameLine; sawName = true; }
    else if (/^\s+model:/.test(lines[i])) { lines[i] = modelLine; sawModel = true; }
  }
  // Insert missing keys right after the last non-blank line of the block.
  let insertAt = end;
  while (insertAt > start + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  const missing = [];
  if (!sawName) missing.push(nameLine);
  if (!sawModel) missing.push(modelLine);
  lines.splice(insertAt, 0, ...missing);
  return lines.join('\n');
}

/**
 * Persist a provider/model choice to config/profile.yml.
 *
 * @param {{provider: string, model?: string}} choice
 * @param {{root?: string, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {ReturnType<typeof readProviderConfig>}
 */
export function writeProviderConfig({ provider, model = '' }, { root = ROOT, env = process.env } = {}) {
  const err = validateProviderChoice(provider, model);
  if (err) throw new Error(err);
  const file = profilePath(root);
  let yml = '';
  try { yml = readFileSync(file, 'utf8'); } catch { /* created below */ }
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, applyProviderChoice(yml, provider, model || ''));
  renameSync(tmp, file);
  return readProviderConfig({ root, env });
}

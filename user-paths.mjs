#!/usr/bin/env node
// @ts-check
/**
 * user-paths.mjs — the single source of truth for User Layer paths.
 *
 * User Layer = personal career data that lives ONLY on the candidate's machine
 * and must never enter git. See DATA_CONTRACT.md.
 *
 * WHY THIS FILE EXISTS. This list was previously duplicated in four places —
 * .gitignore, update-system.mjs USER_PATHS, .github/workflows/no-user-data.yml,
 * and DATA_CONTRACT.md — and every copy had drifted:
 *
 *   - modes/_custom.md was declared User Layer in DATA_CONTRACT.md but was
 *     missing from BOTH .gitignore and the CI guard.
 *   - data/follow-ups.md was declared User Layer but missing from .gitignore.
 *   - voice-dna.md was in update-system.mjs USER_PATHS ("NEVER touch these")
 *     yet shipped tracked, and the CI guard deliberately exempted it.
 *   - interview-prep/story-bank.md shipped tracked upstream until #944.
 *
 * Four independent guards, four different ideas of what "private" meant. Any
 * new User Layer path is added HERE and every guard picks it up.
 *
 * Consumed by:
 *   - .githooks/pre-commit             (prevents the commit — the only real guard)
 *   - .github/workflows/no-user-data.yml (detects it in a PR, after the push)
 *   - test-all.mjs                     (asserts .gitignore covers every entry)
 */

/**
 * Patterns matching repo-relative paths that must never be committed.
 * Anchored regexes; directory entries match everything beneath them.
 */
export const USER_PATHS = [
  /^cv\.md$/,
  /^article-digest\.md$/,
  /^voice-dna\.md$/,
  /^portals\.yml$/,
  /^config\/profile\.yml$/,
  /^modes\/_profile\.md$/,
  /^modes\/_custom\.md$/,
  /^data\//,
  /^reports\//,
  /^output\//,
  /^jds\//,
  /^interview-prep\//,
  /^writing-samples\//,
  /^assets\//,
  /^LinkedIn Update Pack\.md$/,
];

/**
 * Tracked scaffolding that legitimately lives under those directories:
 * .gitkeep markers, directory READMEs, and the *.template.md seeds that ship
 * populated and are copied to the real (ignored) filename on first run.
 */
export const SCAFFOLD = [
  /(^|\/)\.gitkeep$/,
  /(^|\/)README\.md$/,
  /\.template\.md$/,
  /\.example\.(yml|yaml|json|md)$/,
];

/**
 * Credential shapes that must never appear in a diff. Deliberately narrow —
 * these are provider-issued prefixes, so a match is almost certainly a real key
 * rather than prose. Placeholders in *.example files are filtered by SCAFFOLD.
 */
export const SECRET_PATTERNS = [
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', re: /\bsk-proj-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI legacy key', re: /\bsk-[A-Za-z0-9]{32,}/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'Google API key', re: /\bAIza[A-Za-z0-9_-]{35}/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
];

/**
 * Is this path User Layer data that must never be committed?
 *
 * @param {string} file - Repo-relative path, forward slashes.
 * @returns {boolean} True when the path is private data.
 */
export function isUserData(file) {
  if (SCAFFOLD.some(re => re.test(file))) return false;
  return USER_PATHS.some(re => re.test(file));
}

/**
 * Scan text for credential shapes.
 *
 * @param {string} text - Diff or file content.
 * @returns {string[]} Names of the credential types found.
 */
export function findSecrets(text) {
  return SECRET_PATTERNS.filter(p => p.re.test(text)).map(p => p.name);
}

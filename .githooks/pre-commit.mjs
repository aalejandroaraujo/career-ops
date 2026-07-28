#!/usr/bin/env node
// @ts-check
/**
 * .githooks/pre-commit — refuse to commit personal career data or credentials.
 *
 * This is the only guard that PREVENTS exposure. The CI workflow
 * (.github/workflows/no-user-data.yml) runs on pull_request, which means it
 * fires after the data has already been pushed to GitHub, and never fires at
 * all for a direct push to a branch. By then a public repo has already served
 * the content and GitHub retains the objects.
 *
 * Enabled by `npm run hooks:install` (also run automatically by `npm install`
 * via the prepare script), which sets core.hooksPath to this directory.
 *
 * Bypass with `git commit --no-verify` if you are certain. Consider that a
 * decision, not a formality.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { isUserData, findSecrets } = await import(join(ROOT, 'user-paths.mjs'));

const git = (...args) => execFileSync('git', args, { encoding: 'utf-8', cwd: ROOT });

// --diff-filter=d drops deletions: removing a user-layer file is exactly the
// fix we want people to be able to commit (see the voice-dna.md untracking).
const staged = git('diff', '--cached', '--name-only', '--diff-filter=d')
  .split('\n').map(s => s.trim()).filter(Boolean);

if (!staged.length) process.exit(0);

const problems = [];

const privateFiles = staged.filter(isUserData);
if (privateFiles.length) {
  problems.push({
    title: 'Personal career data (User Layer per DATA_CONTRACT.md)',
    files: privateFiles,
    fix: 'These belong only on this machine. Unstage with:\n    git restore --staged '
      + privateFiles.map(f => JSON.stringify(f)).join(' ')
      + '\n  If a path is legitimately shareable, add it to SCAFFOLD in user-paths.mjs.',
  });
}

for (const file of staged) {
  let diff = '';
  try {
    diff = git('diff', '--cached', '--unified=0', '--', file);
  } catch {
    continue; // binary or unreadable — nothing to scan
  }
  const added = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).join('\n');
  const found = findSecrets(added);
  if (found.length) {
    problems.push({
      title: `Possible credential in ${file}`,
      files: [`${found.join(', ')}`],
      fix: 'Move the value to .env (gitignored) and reference it via process.env.\n'
        + '  If this is a placeholder, rename the file to *.example.* or adjust SECRET_PATTERNS.',
    });
  }
}

if (!problems.length) process.exit(0);

console.error('\n\x1b[31m✖ commit blocked\x1b[0m — this repository is public.\n');
for (const p of problems) {
  console.error(`  \x1b[1m${p.title}\x1b[0m`);
  for (const f of p.files) console.error(`    • ${f}`);
  console.error(`  ${p.fix}\n`);
}
console.error('  Override with --no-verify only if you are certain.\n');
process.exit(1);

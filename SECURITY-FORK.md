# Fork hardening and update policy

This is a hardened fork of `santifer/career-ops`. Changes applied at fork time:

- The built-in updater (`update-system.mjs`, `scaffolder/bin/cli.mjs`) is repointed
  from `santifer/career-ops` to `aalejandroaraujo/career-ops`. `npm run update` / `cops update` can
  only pull code that has already been merged into this fork.
- A kill switch: `export CAREEROPS_NO_SELFUPDATE=1` disables the updater's remote
  fetch entirely.
- `upstream` remote is fetch-only (push disabled). `origin` is the fork.
- Dependencies are pinned: caret ranges removed and `package-lock.json` committed.
  Install with `npm ci` for a clean, lockfile-faithful install.

## Update ritual (do this for every upstream update)

1. `git fetch upstream`
2. Review the diff before merging anything:
   `git diff main upstream/main`
   Pay closest attention to:
   - Agent instruction files: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`,
     `.agents/skills/**`, `modes/**`. A hostile update's most likely vector is
     injected agent instructions your CLI would then obey.
   - Network and provider code: `providers/**`, `*_http*`, anything doing `fetch`,
     and the `postinstall` script in `package.json`.
   - The updater itself: `update-system.mjs` (watch for any re-pointing back to a
     non-fork repo, or expansion of the files it overwrites).
3. Only after review, merge into the fork and re-read the merged result.
4. Then sync the local checkout (`git pull`) or run the repointed updater.

## Runtime hygiene

- Prefer running inside the bundled container (`cops` / docker-compose) so a
  shell-capable agent has a limited filesystem blast radius.
- Restrict container egress to the job-board hosts plus your chosen LLM endpoint.
- Keep this fork private. Personal data (cv.md, config/profile.yml, portals.yml,
  data/**, reports/**) is gitignored, but private is defense in depth.

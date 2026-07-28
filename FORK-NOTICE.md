# Fork Notice and Attribution

This repository is a personal instance of **career-ops**, originally created by
**Santiago Fernández de Valderrama** ([@santifer](https://github.com/santifer)).

- **Upstream project:** https://github.com/santifer/career-ops
- **Author's portfolio:** https://santifer.io
- **Companion repo:** https://github.com/santifer/cv-santiago

## License

career-ops is released under the **MIT License**, © 2026 Santiago Fernández de
Valderrama. The full licence text is preserved verbatim in [`LICENSE`](LICENSE)
and is unmodified from upstream.

The MIT Licence grants permission to *"use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, without
restriction"*, subject to a single condition:

> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.

That condition is met by retaining `LICENSE` unchanged. There is no copyleft, no
share-alike clause, and no obligation to publish modifications — this instance
may be kept public or private, and its changes kept private indefinitely.

## Changes in this instance

This fork diverges from upstream and is **not** intended to be merged back. The
notable additions are:

- **Hermes bridge** (`ingest-server.mjs`, `mcp-server.mjs`, `integrations/hermes/`)
  — submit job URLs and manage the tracker from Telegram via MCP.
- **Tracker identity and history** (`tracker-lock.mjs`, `tracker-store.mjs`,
  `tracker-uid-migrate.mjs`) — stable per-application UIDs, a shared write lock,
  and an append-only note/status ledger.
- **LaTeX / AltaCV CV pipeline** (`generate-latex.mjs`, `build-cv-altacv.mjs`,
  `templates/altacv.cls`).
- **Self-hosted updates** — `update-system.mjs` points at this repository rather
  than upstream (see `CANONICAL_REPO`), so `update-system.mjs` will never pull
  unreviewed upstream code into a repo holding personal career data.

## Privacy

All personal career data is User Layer and git-ignored: CV, profile, tracker,
event ledger, reports, job descriptions, interview prep, writing samples, voice
calibration, and generated output. See `DATA_CONTRACT.md` for the full list and
`.gitignore` for enforcement.

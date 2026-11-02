# Progress

## 2026-11-03

- Imported GO GameClient `main` at `6ff4044` with full history and added the OKJID, Okladnoj, TheSuperHackers and GeneralsX remotes.
- Added the safety layers: `.gitignore` rules, pre-commit hook, `Web safety checks` workflow, and `tools/safety/check.mjs` with tests.
- Added `docs/WEB_CONTRACT.md`, the shared interface for the asset tool, server and web shell.
- Added `.env.example`, `UPSTREAM.md`, `STATUS.md` and `docs/DECISIONS.md`.
- Created the public GitHub repo, pushed `main`, and disabled upstream's workflows there.
- Added `tools/ingest-assets`, which copies the needed game files and writes the manifest. Its 33 tests use synthetic files. A run on the owner's Steam install copied 122 files (2.1 GiB) to a folder outside the repo, and a second run copied nothing.
- Added `docs/NETWORK.md` from GO's client, service and plugin source, and removed the GO account keys from `.env.example`.

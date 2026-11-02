# Progress

## 2026-11-03

- Imported GO GameClient `main` at `6ff4044` with full history and added the OKJID, Okladnoj, TheSuperHackers and GeneralsX remotes.
- Added the safety layers: `.gitignore` rules, pre-commit hook, `Web safety checks` workflow, and `tools/safety/check.mjs` with tests.
- Added `docs/WEB_CONTRACT.md`, the shared interface for the asset tool, server and web shell.
- Added `.env.example`, `UPSTREAM.md`, `STATUS.md` and `docs/DECISIONS.md`.
- Created the public GitHub repo, pushed `main`, and disabled upstream's workflows there.
- Added `tools/ingest-assets`, which copies the needed game files and writes the manifest. Its 33 tests use synthetic files. A run on the owner's Steam install copied 122 files (2.1 GiB) to a folder outside the repo, and a second run copied nothing.
- Added `docs/NETWORK.md` from GO's client, service and plugin source, and removed the GO account keys from `.env.example`.
- Added `docs/DETERMINISM.md`: the client mixes SSE2 and x87, Route B isn't available, and all 15 corpus replays hold CRC data but GO can't pass them. Nothing has been measured on a build yet.
- Recorded the owner's decisions after talking with GO: the web build runs its own version and doesn't play native clients, so Route A is dropped.
- Added `web/`, the shell with the password gate, resumable download, launch page, and error and crash screens. 134 unit tests and one Chrome end-to-end test pass against a mock server. It hasn't run against the real relay, on macOS, or with an engine yet.
- Added `relay/`, the server binary with the password gate, session cookies, asset and engine serving, and crash reports. `/go-api` and `/relay` return 501 for now. It uses only Go's standard library, and `go vet` and `go test` pass.

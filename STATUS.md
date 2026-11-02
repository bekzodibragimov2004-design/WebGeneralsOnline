# Status

**Current phase:** P2 (Headless WASM simulation), with the native build finishing P0 and early P3 pieces running in parallel. P1 is settled by decision: the web build runs its own GO version and doesn't play native Windows clients. See `docs/DECISIONS.md`.

## Works

- Repo imported from GO GameClient with full history and pushed to GitHub; upstream remotes added.
- Upstream's workflows are disabled in this repo, so only `Web safety checks` runs.
- Safety layers: `.gitignore`, pre-commit hook, and CI check (`tools/safety/`). Eight tests pass.
- Toolchain: Git, GitHub CLI, CMake, Ninja, vcpkg, Emscripten, Node, Python, Go and mkcert are installed. Playwright is still to come.

- `tools/ingest-assets`, tested on synthetic files and on one real Steam install (122 files, 2.1 GiB).
- `docs/NETWORK.md`: GO's login, API, realtime traffic and anti-cheat, from source. Not yet confirmed against the live service.
- `docs/DETERMINISM.md`: how the native client does floating point, kept as reference now that Route A is dropped.
- `web/`: password gate, resumable download, launch page, error and crash screens. Tested against a mock server only, with no engine yet.

## In progress

- Native client build.
- `docs/WASM_PORT.md`, the plan for the headless WASM build.
- `relay/`.

## Blocked

- **`SITE_PASSWORD` isn't set yet.** It's needed once the site runs for real.
- **The secret-value check in CI** has nothing to compare until the owner sets the `SAFETY_ENV_VALUES` Actions secret.

## Next

1. Finish the native build, and confirm it runs against the Steam data.
2. Write the plan for the headless WASM build, then build it.
3. Show that web clients match each other: replays recorded in WASM, compared on x64 and ARM64.

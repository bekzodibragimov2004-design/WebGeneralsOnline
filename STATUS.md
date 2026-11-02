# Status

**Current phase:** P0 (Setup), with early P3 pieces running in parallel.

## Works

- Repo imported from GO GameClient with full history and pushed to GitHub; upstream remotes added.
- Upstream's workflows are disabled in this repo, so only `Web safety checks` runs.
- Safety layers: `.gitignore`, pre-commit hook, and CI check (`tools/safety/`). Eight tests pass.
- Toolchain: Git, GitHub CLI, CMake, Ninja, vcpkg, Emscripten, Node, Python, Go and mkcert are installed. Playwright is still to come.

- `tools/ingest-assets`, tested on synthetic files and on one real Steam install (122 files, 2.1 GiB).
- `docs/NETWORK.md`: GO's login, API, realtime traffic and anti-cheat, from source. Not yet confirmed against the live service.
- `docs/DETERMINISM.md`: how the native client does floating point. Route A is feasible but unmeasured, and Route B isn't available.

## In progress

- Native client build.
- `docs/WASM_PORT.md`, the plan for the headless WASM build.
- `web/` and `relay/`.

## Blocked

- **Web against native on live GO.** GO's published server code refuses a lobby join when the declared anti-cheat differs, and a browser can't run anti-cheat. An honest web client also can't pass GO's version check. Only GO can change these, so the owner needs to ask the questions in `docs/NETWORK.md` section 8. Browser against browser looks possible but is unconfirmed.
- **`SITE_PASSWORD` isn't set yet.** It's needed once the site runs for real.
- **The secret-value check in CI** has nothing to compare until the owner sets the `SAFETY_ENV_VALUES` Actions secret.

## Next

1. Build the native GO client.
2. Port the headless simulation to WASM, which Route A's test needs.
3. Record the native replay baseline once the native build finishes, then decide the determinism route (P1).

# Status

**Current phase:** P0 (Setup), with early P3 pieces running in parallel.

## Works

- Repo imported from GO GameClient with full history and pushed to GitHub; upstream remotes added.
- Upstream's workflows are disabled in this repo, so only `Web safety checks` runs.
- Safety layers: `.gitignore`, pre-commit hook, and CI check (`tools/safety/`). Eight tests pass.
- Toolchain: Git, GitHub CLI, CMake, Ninja, vcpkg, Emscripten, Node, Python, Go and mkcert are installed. Playwright is still to come.

## In progress

- Toolchain install: Visual Studio Build Tools.
- `docs/NETWORK.md` and `docs/DETERMINISM.md`, researched from the source.
- `docs/WASM_PORT.md`, the plan for the headless WASM build.
- `web/`, `relay/` and `tools/ingest-assets/`.

## Blocked

- **`.env` is missing.** Without `GAME_DIR` the native client can't be run and the replay baseline can't be recorded. Copy `.env.example` to `.env` and fill it in.
- **The secret-value check in CI** has nothing to compare until the owner sets the `SAFETY_ENV_VALUES` Actions secret.

## Next

1. Build the native GO client.
2. Port the headless simulation to WASM, which Route A's test needs.
3. Record the native replay baseline once `GAME_DIR` exists, then decide the determinism route (P1).

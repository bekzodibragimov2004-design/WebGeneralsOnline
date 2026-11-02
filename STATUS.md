# Status

**Current phase:** P0 (Setup), with early P3 pieces running in parallel.

## Works

- Repo imported from GO GameClient with full history; upstream remotes added.
- Safety layers: `.gitignore`, pre-commit hook, and CI check (`tools/safety/`). Eight tests pass.

## In progress

- Toolchain install: Visual Studio Build Tools, Go and Emscripten.
- `docs/NETWORK.md` and `docs/DETERMINISM.md`, researched from the source.
- `web/`, `relay/` and `tools/ingest-assets/`.

## Blocked

- **The GitHub repo doesn't exist yet.** Creating a public repo needs the owner's approval. Commits are local until then.
- **`.env` is missing.** Without `GAME_DIR` the native client can't be run and the replay baseline can't be recorded. Copy `.env.example` to `.env` and fill it in.
- **The secret-value check in CI** has nothing to compare until the owner sets the `SAFETY_ENV_VALUES` Actions secret.

## Next

1. Build the native GO client.
2. Port the headless simulation to WASM, which Route A's test needs.
3. Record the native replay baseline once `GAME_DIR` exists, then decide the determinism route (P1).

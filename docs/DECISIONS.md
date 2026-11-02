# Decisions

## 2026-11-03: Continue P0 without `.env`

The brief says to stop if `.env` is missing, but the owner told work to proceed. Everything that needs no secrets or game data continues. Running the native client, the replay baseline and GO login wait for `.env`.

## 2026-11-03: Disable upstream workflows through the API

Upstream's `ci.yml` runs long Windows builds on every push to `main`. The workflow files stay unchanged, so upstream merges stay clean, and each is disabled in the repo's Actions settings. Only `Web safety checks` and later web workflows run.

## 2026-11-03: Allowlist upstream files by content hash

Upstream's source tree holds 12 engine and tool files with forbidden extensions (`.tga`, `.w3d`, `.wav`), none of them from game data. `tools/safety/allowlist.txt` lists them by git blob hash plus path, so a changed or swapped file fails the check.

## 2026-11-03: CI secret check depends on an owner-set secret

CI has no `.env`, so comparing against its values needs them stored as the `SAFETY_ENV_VALUES` Actions secret. The owner sets it, since it holds their passwords. Until then, CI still checks file types and sizes and its log says no secret values were compared.

## 2026-11-03: Native builds use `win32-vcpkg`

The brief names the `win32` preset, but upstream's `ci.yml` notes that only the vcpkg presets can build GeneralsMD, and that is what its CI builds.

## 2026-11-03: One shared contract for web pieces

The asset tool, server and web shell are built in parallel, so their shared formats and routes live in `docs/WEB_CONTRACT.md`.

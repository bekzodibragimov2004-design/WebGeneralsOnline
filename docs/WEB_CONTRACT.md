# Web contract

The shared interface between `tools/ingest-assets`, `relay/` and `web/`. Change this file first when any of these change.

## Asset manifest

`tools/ingest-assets` writes `manifest.json` at the root of the asset directory. The asset directory lives outside the repo.

```json
{
  "schema": 1,
  "version": "2026.11.03-1",
  "generatedAt": "2026-11-03T00:00:00Z",
  "totalBytes": 123456,
  "files": [
    { "path": "INIZH.big", "size": 1234, "sha256": "<64 lowercase hex chars>" },
    { "path": "ZH_Generals/INI.big", "size": 1234, "sha256": "<64 lowercase hex chars>" }
  ]
}
```

- `path` is relative, uses forward slashes, keeps the game's original case, and never contains `..`.
- Zero Hour also loads the base Generals archives. A Steam install already holds them under `ZH_Generals/`, and they keep that path. Archives from a separate install (`--generals-dir`) sit under `Generals/`.
- `files` is sorted by `path`, compared byte by byte, so the same input gives the same output.
- `version` changes whenever any file's content changes.

## HTTP routes

All served over HTTPS by the single server binary in `relay/`.

| Route | Cookie required | Purpose |
|---|---|---|
| `GET /`, `GET /shell/*` | No | Web shell: the gate page and its JS and CSS. Holds no game content. |
| `POST /api/login` | No | Body `{"password":"..."}`. `204` with session cookie, `401` wrong password, `429` rate limited (with `Retry-After`). |
| `GET /api/session` | No | `204` if the cookie is valid, otherwise `401`. |
| `POST /api/logout` | Yes | `204` and clears the cookie. |
| `GET /assets/manifest.json` | Yes | The manifest. |
| `GET /assets/files/<path>` | Yes | One game file. Supports HTTP `Range`, `ETag` and `If-Range`. Never content-encoded, so byte ranges stay valid. |
| `GET /engine/*` | Yes | Engine `.wasm` and `.js`. Brotli or gzip when the client accepts them. |
| `POST /api/crash` | Yes | Crash report JSON, stored in a local log directory. Maximum 256 KB. `204` when stored. |
| `/go-api/*` | Yes | Proxy to GO's HTTP API. See `docs/NETWORK.md`. |
| `/relay` | Yes | WebTransport and WebSocket relay. See `docs/NETWORK.md`. |

A request without a valid cookie gets `401` on every route that requires one.

## Response headers

Every response, including errors:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Resource-Policy: same-origin`

## Session cookie

Name `wgo_session`, with `HttpOnly`, `Secure`, `SameSite=Strict` and `Path=/`. The server compares `SITE_PASSWORD` in constant time, and the cookie value never contains the password.

## Crash report

```json
{
  "buildHash": "abc1234",
  "phase": "download|menu|lobby|match|replay",
  "kind": "abort|exception|oom|webgpu",
  "message": "...",
  "stack": "...",
  "log": ["last 200 log lines at most"]
}
```

Reports never contain passwords, tokens or cookies.

## Browser storage

The shell stores game files in OPFS under `/game/<path>` and the installed manifest at `/game/manifest.json`. Files still downloading stay under `/partial/` until they verify. Player data goes under `/player/`, and an update never touches it.

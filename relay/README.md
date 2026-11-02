# relay

The single server binary for WebGeneralsOnline. It serves the web shell, engine and game assets behind a shared password, and will relay game traffic later. The routes, headers and cookie it implements are defined in [`docs/WEB_CONTRACT.md`](../docs/WEB_CONTRACT.md). It uses only the Go standard library.

## Build and run

```sh
cd relay
go build -o relay.exe ./cmd/relay

./relay.exe --listen :8443 \
  --tls-cert cert.pem --tls-key key.pem \
  --asset-dir D:/wgo/assets --web-dir ../web/dist \
  --engine-dir D:/wgo/engine --crash-dir D:/wgo/crash
```

For localhost testing without certificates, replace the two TLS flags with `--insecure-dev`.

## Settings

Flags win over environment variables. The four directories are required and may be outside the repo. The crash directory is created if missing. The others can appear after startup: until then the server warns and their routes answer 404.

| Flag | Environment | Purpose |
|---|---|---|
| `--listen` | `WGO_LISTEN` | Listen address. Default `127.0.0.1:8443`, so exposing the server is a deliberate choice. |
| `--tls-cert`, `--tls-key` | `WGO_TLS_CERT`, `WGO_TLS_KEY` | PEM files, such as mkcert output. Serves HTTPS and HTTP/2. |
| `--asset-dir` | `WGO_ASSET_DIR` | `manifest.json` and game files. |
| `--web-dir` | `WGO_WEB_DIR` | Vite `dist`. |
| `--engine-dir` | `WGO_ENGINE_DIR` | Engine `.wasm` and `.js`, with optional `.br` and `.gz` sidecars. |
| `--crash-dir` | `WGO_CRASH_DIR` | One JSON file per crash report. |
| `--env-file` | `WGO_ENV_FILE` | Overrides where `SITE_PASSWORD` is read from. |
| `--insecure-dev` | none | Plain HTTP and no `Secure` on the cookie. Refused together with TLS flags. |

`SITE_PASSWORD` comes from the environment or, when that is empty, from `.env` in the nearest parent directory holding `.git`, searched from the working directory and then from the binary's directory. The server refuses to start without it, and there is deliberately no flag for it.

## Web build

`web/vite.config.ts` sets `base: '/shell/'`, and `/shell/<rel>` serves `<web-dir>/<rel>`. That base has to stay: with Vite's default, scripts would load from `/assets/...`, which is the cookie-protected asset route, so the gate page could not start.

## Behaviour worth knowing

- **Logs** are JSON on stderr. The access log records a fixed route label, method, status, size, duration and client address. It never records the path, query, headers or body, because any of them could hold a secret.
- **Client address** is the socket address. Forwarding headers are ignored, since trusting them would let anyone choose their own rate limit bucket. Behind a reverse proxy, every client would share one bucket. IPv6 clients are grouped by /64.
- **Login limit:** 5 free attempts per client, then a block of 1s that doubles up to 15 minutes. History clears after a success or 24 quiet hours. The table holds at most 65,536 clients and evicts the least recently seen, so this slows guessing from one address but not a botnet. Use a long password.
- **Sessions** live in memory for 7 days, so a restart signs everyone out.
- **Crash reports:** 256 KB each, and 20 free reports per client before a backoff starting at 1 minute. Storage is capped at 256 MiB in total. Once full, new reports get `507` and old ones are kept. Nothing deletes reports, so clear the directory by hand.
- **Paths:** segments starting with a dot are refused, along with backslashes, colons, trailing dots or spaces, and Windows device names. Symlinks and junctions leaving a root are refused by `os.Root`.
- **Headers on every response:** this covers everything the handler answers. Go's HTTP server answers a few protocol-level failures itself before any handler runs, such as an unparseable request or plain HTTP sent to the TLS port, and those lack the COOP, COEP and CORP headers. No browser page depends on them.

## Plugging in `/go-api` and `/relay`

Both are `501` for now, behind the cookie check. The requirements are in [`docs/NETWORK.md`](../docs/NETWORK.md). Set `server.Options.GoAPI` and `server.Options.Relay` in `cmd/relay/main.go` to real handlers. They receive only requests with a valid session, and they must set their own body limits and deadlines. The server's 60-second read timeout still applies until a handler extends it through `http.ResponseController`, which long uploads need. The `ResponseWriter` they get supports `Hijack`, `Flush` and `http.ResponseController`. Requests still carry the `wgo_session` cookie, so a proxy must strip it before forwarding. WebTransport needs an HTTP/3 listener beside the current one, which is not built yet.

## Test

```sh
go vet ./...
go test ./...
```

Tests use fake passwords and small files created at runtime, and they never read a real `.env`. `-race` needs cgo and a C compiler on Windows. Symlink tests skip on Windows accounts that cannot create symlinks; the junction tests cover the same escapes there.

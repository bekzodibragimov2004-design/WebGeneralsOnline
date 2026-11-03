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

## 2026-11-03: Asset tool also takes the base Generals folder

Zero Hour isn't standalone: `Win32BIGFileSystem.cpp:60-70` loads every `.big` under its own folder and then every `.big` under the Generals install. So the tool takes `--generals-dir` as well as `--game-dir`, and stores base archives under `Generals/` so names can't collide. The engine port must mount that folder.

A Steam install needs no extra flag, because it holds the base archives in `ZH_Generals/` inside the game folder, and they load in the engine's first pass.

## 2026-11-03: Native runs set the per-user `InstallPath`

The engine finds base Generals through the `EA Games\Generals` registry key, checking the current user before the machine. Steam's install script doesn't write that key. Native runs set it under `HKCU`, pointing at `ZH_Generals`, which is what upstream's `check-replays.yml` does too. It needs no admin rights and is easy to undo.

## 2026-11-03: GO accounts are signed in by hand

GO has no username and password login: players sign in on GO's website through Steam, Discord or GameReplays. So `GO_ACCOUNT_*` is gone from `.env.example`, and missing values there are no longer a stop condition. The owner signs in, and tests reuse the saved session where GO's token rules allow it.

## 2026-11-03: Web against native isn't treated as a stop yet

GO's published code answers `417` when anti-cheat values differ, and an honest web client declares none. That blocks browser against native on live GO unless GO changes it. It comes close to stop condition 3, but it's unconfirmed on the live service and browser against browser still looks possible, so work continues while the owner asks GO. The web build sends `client_id` `custom_third_party_client` and `anticheat_id` `-1`, and never claims more than it does.

## 2026-11-03: Automated online tests use a self-hosted GO service

GO publishes its service under AGPL-3.0, and a debug build creates dev accounts. Automated relay and lobby tests run against that, and live GO is kept for short attended runs after the owner has heard from GO. This also respects section 1.7.

## 2026-11-03: One UDP socket per ICE session

The brief asks for one socket per browser client. GameNetworkingSockets opens one per ICE session and a mesh has one session per peer, so sharing a socket would mean changing how it separates traffic. The relay caps each client at about 8 sockets, and each client still appears as its own endpoints.

## 2026-11-03: Enforcement details stay out of public docs

GO's `SECURITY.md` asks for security findings to be reported privately. Public docs say what an honest client faces and leave out details of how checks are enforced. The owner has the full notes outside version control.

## 2026-11-03: Route A's pass test uses replays the reference client can pass

The brief says every GeneralsReplays corpus replay must match, and one mismatch fails Route A. That corpus was recorded by 2005 retail clients at 30 logic frames per second. GO runs at 60 with `RETAIL_COMPATIBLE_CRC` off, so GO's own client can't pass it either. The test becomes: replays recorded by the exact reference client, kept only if that client replays them cleanly, with coverage of every faction and long matches. One mismatch on that set still fails. The retail corpus stays as a parser test and a negative control. The brief's 20 fresh AI replays are part of the new set.

## 2026-11-03: Route B isn't available, and Route A isn't tested first

Deterministic math is in none of GO's public refs or its current release. Route A hasn't failed: it's unmeasured, and `docs/DETERMINISM.md` rates it feasible at medium confidence. Its whole purpose is play against native clients, which GO's anti-cheat rule blocks and which GO's developers reportedly asked another client to turn off. So the math work waits for GO's answer. Headless WASM work continues, since every outcome needs it.

## 2026-11-03: Native crossplay is out of scope for now

After talking with GO, the owner decided the web build runs its own GO version, uses `client_id` `custom_third_party_client`, sends `anticheat_id` `-1`, and stays apart from Windows players through its version mismatch. This replaces the brief's goal of playing native clients, and so its P1 and section 5. Route A is dropped, stop condition 2 no longer applies, and stop condition 3 isn't triggered. It replaces the three entries above about Route A, Route B and treating web against native as a possible stop.

Determinism now means all web clients on one build match each other, on Windows x64 and macOS ARM64. The pass test: a replay recorded by the web client plays back with matching CRCs, and gives identical per-frame CRCs on both CPU types. The retail corpus stays a parser test and a negative control. If GO ever ships deterministic math, that can be merged later.

Also decided: many players behind one relay IP is fine, two test accounts and short automated sessions are fine, GO's `:2087` test environment is open for them, test matches keep `track_stats` off, and a web build isn't an "unauthorized modification". Missing hardware ids will flag accounts with no exemption, and the web build still never invents them.

## 2026-11-03: Native dev runs never use `crashpad_handler.exe`

The native client starts Sentry with GO's DSN on every launch, including `-headless`. With `crashpad_handler.exe` beside the exe, it would contact GO's Sentry on every run and upload any crash, which isn't acceptable for development builds. The build puts that file next to the exe, so native runs use a separate run folder without it, as `docs/NATIVE_BASELINE.md` describes. The web build leaves Sentry out entirely.

## 2026-11-03: One shared contract for web pieces

The asset tool, server and web shell are built in parallel, so their shared formats and routes live in `docs/WEB_CONTRACT.md`.

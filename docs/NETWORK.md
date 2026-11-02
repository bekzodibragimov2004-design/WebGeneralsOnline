# GO network, login and anti-cheat

What the Generals Online (GO) client and services do on the network, and what a browser build honestly identified as a web build would face. Researched on 2026-11-03 from source. No request was sent to GO's API, login or game servers, and the client was not run. Public website pages were read.

## Bottom line

- **Login** is a browser sign-in with a one-time code. The player signs in through Steam, Discord or GameReplays on GO's website while the client polls. There is no username and password login, so the brief's `GO_ACCOUNT_*` values have nowhere to go.
- **Realtime** is a WebSocket to GO's service for lobby, chat and signalling, plus a full peer-to-peer mesh of GameNetworkingSockets (GNS) connections over UDP with ICE, STUN and Cloudflare TURN. Lockstep traffic goes peer to peer. There is no game server.
- **Web against native on live GO is blocked for an honest client.** Published server code answers `417` when a client's declared anti-cheat differs from the lobby's. The honest value for a web build is "none", and the official client never sends it. Only GO can change that.
- **Login itself looks possible.** The published service has a `custom_third_party_client` id that gets full game client access. Browser against browser in a no-anti-cheat lobby looks possible too, once GO says what a web build should do about the version check.
- **No GO rule found forbids automated testing or test accounts.** None permits them either, and the login needs a human. See [Terms](#6-terms).

All of this is unconfirmed against the live service. See [What only a live test or GO can confirm](#8-what-only-a-live-test-or-go-can-confirm).

This document covers what the checks are and what an honest client gets from them. It deliberately does not cover ways around them. Details of how GO enforces its checks are also left out, because GO's `SECURITY.md` asks for such findings to go to GO privately.

## How to read the citations

| Label | Meaning |
|---|---|
| **[client]** | Verified in the GO client source at `6ff4044` (`go/main`). |
| **[svc]** | Verified in GO's published server source. The live service may run something else. |
| **[web]** | Read from GO's public website on 2026-11-03 through a fetch tool that returns summaries, not verbatim text. Check the original before relying on the wording. |
| **[inf]** | My inference. Not stated in any source. |

Path prefixes:

| Prefix | Location | Commit |
|---|---|---|
| `GO/` | `GeneralsMD/Code/GameEngine/Source/GameNetwork/GeneralsOnline/` | `6ff4044` |
| `GOH/` | `GeneralsMD/Code/GameEngine/Include/GameNetwork/GeneralsOnline/` | `6ff4044` |
| `svc/` | [Services](https://github.com/GeneralsOnlineDevelopmentTeam/Services) `GenOnlineService/` (AGPL-3.0) | `85dfbc7`, 2026-09-29 |
| `eac/` | [AntiCheatPlugin_EasyAntiCheat](https://github.com/GeneralsOnlineDevelopmentTeam/AntiCheatPlugin_EasyAntiCheat) (LGPL-2.1) | `d1af82d`, 2026-10-01 |
| `goac/` | [AntiCheatPlugin_GeneralsOnline](https://github.com/GeneralsOnlineDevelopmentTeam/AntiCheatPlugin_GeneralsOnline) (LGPL-2.1) | `29fc7c2`, 2026-05-10 |
| `acif/` | [AntiCheatPlugin_Interfaces](https://github.com/GeneralsOnlineDevelopmentTeam/AntiCheatPlugin_Interfaces) (LGPL-2.1) | `512761d`, 2026-05-10 |
| `launcher/` | [Launcher](https://github.com/GeneralsOnlineDevelopmentTeam/Launcher) (GPL-3.0) | `0be25ee`, 2026-10-02 |
| `gns/` | [tintinhamans/GNS](https://github.com/tintinhamans/GNS), the fork GO's vcpkg registry pins | `d2837fa`, 2026-10-12 |

**The source may lag the live service.** The repo's client version is `100126_QFE2` (`GOH/NextGenMP_defines.h:16`), while GO's homepage offers a `100126_QFE6` installer **[web]**. The published service was last changed before the client's newest commit.

The branches you asked about add nothing to rely on:

- `go/plugins` is fully merged into `main`, so it has no extra content.
- `go/ipc` is an unfinished January 2026 experiment. It puts the GNS code behind `USE_IPC_TRANSPORT_LAYER`, and in its `NextGenTransport.cpp` `doRecv` then just returns false. It contains no replacement transport.

---

## 1. Login

### Mechanism

**This does not match the assumption of test accounts with a username and password.** GO's client and server have no password endpoint. The player signs in on `www.playgenerals.online` with Steam, Discord or GameReplays through OpenID, so GO never sees a password **[web]**. The server's account type enum lists Steam, Discord, Ghost and DevAccount (`svc/Constants.cs:1709-1716`), and user records also carry GameReplays ids (`svc/Database/Database.User.cs:50-52`). The sign-in pages themselves are on the website, whose code is not public.

The flow resembles an OAuth device code, but it is GO's own protocol:

1. The client tries a stored refresh token first: `POST LoginWithToken` with `Authorization: Bearer <refresh>` (`GO/OnlineServices_Auth.cpp:308-329`). A `423` shows the ban dialog (`:334-338`). Any other 4xx or a failed result falls through to the full flow (`:341-342`, `:370-374`).
2. Full flow: `GET LoginCode` returns `{success, login_code}` with no authentication (`GO/OnlineServices_Auth.cpp:396-398`). The code is 32 characters and lives for 5 minutes (`svc/Controllers/LoginCode/LoginCodeController.cs:45`, `:241`).
3. The client opens `https://www.playgenerals.online/login/?gamecode=<code>` in the system browser, with `&env=test` on the test build (`GO/OnlineServices_Auth.cpp:437-439`, `:458`).
4. The website handles sign-in, then tells the service the result with `POST LoginCode` and a server-side `X-Api-Key` (`svc/Controllers/LoginCode/LoginCodeController.cs:154-167`).
5. The client polls `POST CheckLogin` once a second (`GO/OnlineServices_Auth.cpp:504`, `:512`) with `code`, `client_id`, `machine_guid`, `mac_addr`, `vol_serial`, `exe_crc` and `ini_crc` (`:516-522`). Results are `-1` code invalid, `0` waiting, `1` success, `2` failed (`:27-33`). `423` means banned (`:529-534`).
6. Success returns `session_token`, `refresh_token`, `user_id`, `display_name` and `ws_uri` (`GO/OnlineServices_Auth.cpp:43-54`, `svc/Controllers/CheckLogin/CheckLoginController.cs:211-222`).
7. `OnLoginComplete` signs in to the anti-cheat plugin if one is loaded (`GO/OnlineServices_Auth.cpp:590`), starts GNS with the numeric user id as its identity (`GO/NetworkMesh.cpp:611-623`), and connects the WebSocket to `ws_uri` (`GO/OnlineServices_Init.cpp:866-871`).
8. The client fetches `MOTD`. Login is reported as failed if the WebSocket is not connected by then (`GO/OnlineServices_Auth.cpp:84`, `:97-103`).

### Tokens

| Token | Lifetime | Use | Stored |
|---|---|---|---|
| Login code | 5 min, one use | Links browser sign-in to the client | Memory |
| Session JWT (HS256, `svc/Program.cs:972-973`) | 15 min default (`svc/appsettings.json:29`). Client refreshes at 10 min, with 2 attempts 30 s apart (`GOH/OnlineServices_Auth.h:74-80`) | `Authorization: Bearer` on API calls and the WebSocket upgrade | Memory |
| Refresh JWT | 43200 min (30 days) default (`svc/appsettings.json:30`). Live value unknown | `LoginWithToken` and `RefreshToken` only (`svc/Program.cs:809-816`) | `<user data>/GeneralsOnlineData/credentials.json`, encrypted with Windows DPAPI in release builds (`GO/OnlineServices_Auth.cpp:643-654`, `:763-772`) |
| TURN username and token | Per lobby join or create. TTL comes from server config (`svc/Constants.cs:2638`) | P2P relay fallback | Memory |

Details that affect a web build:

- Refresh tokens are single use. Only the newest one is accepted (`svc/Program.cs:875-884`), so two runners cannot share an account's token.
- Connecting a new session of the same type kills the old one (`svc/Constants.cs:433-438`). `LoginWithToken` also tears down lobby and matchmaking state (`svc/Controllers/LoginWithToken/LoginWithTokenController.cs:170-176`).
- Browsers have no DPAPI. A refresh token in OPFS, where the brief puts GO session data, would sit unencrypted at rest **[inf]**.
- The JWT carries the requester's IP as a claim (`svc/Program.cs:982`). A check against it exists but only runs if `enforce_ip_match` is set (`svc/Program.cs:892-901`). It is not in the published `appsettings.json`, and its live value is unknown.

---

## 2. API

### Base URLs

`GetAPIEndpoint` builds `<base>/env/<env>/contract/1/<endpoint>` (`GO/OnlineServices_Init.cpp:180-201`):

| Build | Base |
|---|---|
| Release (prod) | `https://api.playgenerals.online/env/prod/contract/1/` |
| Release with `network.use_alternative_endpoint` in `settings.json` | `https://api-ru.playgenerals.online/env/prod/contract/1/` |
| `USE_TEST_ENV` | `https://api.playgenerals.online:2087/env/test/contract/1/` |
| Debug | `https://localhost:9000/env/dev/contract/1/` |

The environment is fixed at compile time (`GOH/OnlineServices_Init.h:377-391`), and `USE_TEST_ENV` is commented out in `main` (`GOH/NextGenMP_defines.h:32-34`).

### HTTP details

- **Library:** libcurl through a multi handle (`GO/HTTP/HTTPManager.cpp:218`, `:241`).
- **Headers:** `User-Agent: GeneralsOnline Client` (`GO/HTTP/HTTPRequest.cpp:244`) and `Authorization: Bearer <session>` once logged in (`:266-274`). Uploads add `Content-Type` (`GO/OnlineServices_Init.cpp:968`).
- **Signing:** none. There is no request signing or HMAC. Authentication is the bearer JWT alone.
- **Bodies:** JSON, read raw by the server.
- **Timeout:** 5 s by default (`GOH/HTTP/HTTPRequest.h:82`), 10 minutes for uploads (`GOH/NextGenMP_defines.h:36`).
- **TLS:** verified against the OS certificate store in release builds (`GO/HTTP/HTTPRequest.cpp:323-326`).
- **Server user agent:** the published service never reads `User-Agent`. CORS allows no origins by default (`svc/appsettings.json:23`, `svc/Program.cs:1030-1065`). The live setting is unknown, and the relay plan does not depend on it.

### Endpoints the client calls

| Endpoint | Verb | Cited at |
|---|---|---|
| `VersionCheck` | POST | `GO/OnlineServices_Init.cpp:379` |
| `ServiceConfig` | GET, before each lobby join or create | `GO/OnlineServices_Init.cpp:61` |
| `LoginCode` | GET | `GO/OnlineServices_Auth.cpp:396` |
| `CheckLogin` | POST | `GO/OnlineServices_Auth.cpp:512` |
| `LoginWithToken` | POST | `GO/OnlineServices_Auth.cpp:308` |
| `RefreshToken` | POST | `GO/OnlineServices_Auth.cpp:213` |
| `ProvideMWToken` | POST, anti-cheat plugin only | `GO/OnlineServices_Auth.cpp:151` |
| `MOTD` | GET | `GO/OnlineServices_Auth.cpp:84` |
| `User/<id>` | DELETE, logout | `GO/OnlineServices_Auth.cpp:612` |
| `Rooms` | GET | `GO/OnlineServices_RoomsInterface.cpp:1840` |
| `Lobbies` | GET list, PUT create | `GO/OnlineServices_LobbyInterface.cpp:539`, `:1495` |
| `Lobby/<id>` | GET, POST, PUT join, DELETE leave | `GO/OnlineServices_LobbyInterface.cpp:1160`, `:1409` |
| `Lobby/Outcome` | Match result | `GO/OnlineServices_StatsInterface.cpp:606` |
| `Matchmaking`, `/Playlists`, `/Widen` | PUT, DELETE, GET, POST | `GO/OnlineServices_MatchmakingInterface.cpp:13`, `:73`, `:91` |
| `PlayerStats`, `PlayerStats/Batch`, `GlobalStats` | Stats | `GO/OnlineServices_StatsInterface.cpp:54`, `:115`, `:249` |
| `Social/Friends`, `/Friends/Requests`, `/Blocked` | Social | `GO/OnlineServices_SocialInterface.cpp:36`, `:109`, `:154` |
| `ConnectionOutcome` | POST, per peer link | `GO/NetworkMesh.cpp:795`, `:811` |

The client also makes these calls outside the API:

- Presigned S3-style `PUT` uploads for screenshots and replays (`GO/OnlineServices_Init.cpp:969`, `:1026`). The URLs arrive over the WebSocket.
- The patcher download from whatever `patcher_path` the server returns (`GO/OnlineServices_Init.cpp:474`).

### Version sent and enforced

`POST VersionCheck` sends `execrc`, `ver`, `netver` and `servicesver` (`GO/OnlineServices_Init.cpp:400-405`). The last three are all `1` on both sides (`GOH/NextGenMP_defines.h:54-56`, `svc/Constants.cs:40-42`). `execrc` is a CRC of the running exe file (`GO/OnlineServices_Init.cpp:384-398`).

The server returns `OK` only if every version matches and `execrc` equals the CRC of one of two reference exes it holds. Anything else returns `NeedsUpdate` with a patcher (`svc/Controllers/VersionCheck/VersionCheckController.cs:197-202`, `:259`).

On the stock client, `NeedsUpdate` means a mandatory update that downloads an exe and runs it elevated (`Core/GameEngine/Source/GameNetwork/GameSpy/MainMenuUtils.cpp:947-967`, `GO/OnlineServices_Init.cpp:763-799`). A failure means no multiplayer (`MainMenuUtils.cpp:909-923`).

**A WASM build cannot honestly pass this.** No native exe exists to hash, so an honest value matches neither reference and the answer will be `NeedsUpdate`. The web client must never fetch or run that patcher.

This is GO's update and integrity gate, so what a web build does about it is a question for GO.

### Identity fields a web build can honestly fill

| Field | Stock value | Honest web value | What happens |
|---|---|---|---|
| `client_id` in `CheckLogin` | `gen_online_60hz` (`GOH/NextGenMP_defines.h:75-79`, `GO/OnlineServices_Auth.cpp:517`) | `custom_third_party_client` | **[svc]** Known client, session type `GameClient`, full access (`svc/Constants.cs:349-368`, `:1633-1648`). The id goes into the JWT (`svc/Program.cs:984`) and is what operators see. |
| A name GO does not know, such as `web_generals` | n/a | Honest, but useless today | **[svc]** "Limited login": success with null tokens and no `ws_uri` (`svc/Controllers/CheckLogin/CheckLoginController.cs:196-197`, `:229-237`). The client cannot do anything with that. |
| Platform field | None in GO `main` | Can be added as an extra JSON key such as `platform: "web"` | **[svc]** Ignored: the handler reads a dictionary and only looks up its known keys (`svc/Controllers/CheckLogin/CheckLoginController.cs:94`). Harmless, and invisible to GO unless they log it. **[inf]** |
| `User-Agent` | `GeneralsOnline Client` | Set by the relay to name the web build | Not read by the published service. Visible in GO's front-end logs at most. **[inf]** |

**Do not send `gen_online_60hz` or `gen_online_30hz`.** Those name GO's own client, and the brief requires the web build to identify itself. `LICENSE.md:617-618` also says modified versions must be marked as such and not identified as the original.

There is no free-text client field, and no id says "web". `custom_third_party_client` is the closest honest value. GO could add a dedicated id with a one-line change (`svc/Constants.cs:349-368`).

Other published precedent: `genhub` and `superhackers_community_patch_client` are also known ids, and GO's 2026-09-28 patch notes fix a bug for the GenHub launcher **[web]**. GO clearly expects some outside clients.

---

## 3. Realtime

### Channels

| Channel | Transport | Endpoint | Purpose |
|---|---|---|---|
| Service WebSocket | TLS WebSocket | `ws_uri` from login, which is `/env/<env>/contract/1/ws` on the API host (`svc/Program.cs:1133-1159`). With the alternative endpoint, `wss://api-ru.playgenerals.online/ws` (`GO/OnlineServices_Init.cpp:869`) | Chat, lobby events, signalling, probes |
| Peer mesh | GNS over UDP with ICE | Each peer in the lobby | **All lockstep game traffic** |
| STUN | UDP | `stun.playgenerals.online:53`, `:3478`, `stun.l.google.com:19302` (`GO/NetworkMesh.cpp:633`) | Finding the public address |
| TURN | UDP | `turn.playgenerals.online:53`, `:3478` (`GO/NetworkMesh.cpp:711`) | Fallback relay. Credentials come from Cloudflare's API (`svc/Constants.cs:2687`) |
| EOS P2P | Epic's SDK | Epic's network | Only when the EAC plugin is loaded **and** the service sets `use_new_networking`, default false (`GO/PluginInterfaces.cpp:506-541`, `GOH/OnlineServices_Init.h:348`, `eac/plugin_eac.cpp:1150-1161`) |
| HTTPS uploads | HTTPS | Presigned URLs | Screenshots and replays |

Not used for networking:

- **Steam:** `steam_api.dll` is loaded if present and only `SteamAPI_InitSafe` is called (`GO/OnlineServices_Init.cpp:203-236`, `GeneralsMD/Code/Main/WinMain.cpp:987`).
- **Valve SDR:** no reference in GO's code. GNS is the open-source library with custom signalling.
- **Discord:** Rich Presence only, through a local DLL.
- **GO's own relays:** none. The FAQ says GO uses a Cloudflare-based backend and takes no community relays **[web]**.
- **Port forwarding, UPnP, NAT-PMP:** vendored source exists but nothing compiles or calls it.

### Service WebSocket

- **Upgrade headers:** `Authorization: Bearer <session>` and `is-reconnect: true|false` (`GO/OnlineServices_RoomsInterface.cpp:223-228`). Browser WebSocket APIs cannot set these headers, so the relay has to.
- **Framing:** one JSON object per message with a numeric `msg_id` (`GOH/OnlineServices_Init.h:48-99`). The client sends JSON in **binary** frames (`GO/OnlineServices_RoomsInterface.cpp:880`) and only parses inbound **text** frames (`:919`).
- **Keepalive:** a WebSocket ping and a JSON `PING` every second (`GO/OnlineServices_RoomsInterface.cpp:139-152`, `:778-782`), and a 20 s timeout on silence (`GOH/OnlineServices_Init.h:255-256`). The server pings after 15 s of silence and aborts after 45 s (`svc/Constants.cs:1487`, `:1491`).
- **Reconnect:** backoff 2 to 10 s, and a 30 s window outside a match (`GOH/OnlineServices_Init.h:233-237`). HTTP `205` on the upgrade means the session is gone, so the client reconnects fresh (`GO/OnlineServices_RoomsInterface.cpp:812-820`, `svc/Controllers/WebSocket/WebSocketController.cs:254-258`).
- **Region:** the server geolocates the connection's IP to set the player's continent and country (`svc/Controllers/WebSocket/WebSocketController.cs:187-211`). Lobby names and regions come from that (`svc/LobbyManager.cs:829-830`).

### Peer mesh and NAT traversal

1. On lobby join or create, the server returns TURN credentials (`svc/Controllers/Lobby/LobbyController.cs:930-935`, `GO/OnlineServices_LobbyInterface.cpp:1256-1257`).
2. For each pair of members, the server sends `NETWORK_CONNECTION_START_SIGNALLING` (`svc/LobbyManager.cs:1240-1246`, `GO/OnlineServices_RoomsInterface.cpp:1292-1333`).
3. The client opens a symmetric-mode GNS P2P connection with custom signalling (`GO/NetworkMesh.cpp:949-979`, `:1002`). Identity is the user id as a string, and incoming connections are accepted only from current lobby members (`GO/NetworkMesh.cpp:257-273`).
4. GNS signalling blobs go over the WebSocket as `NETWORK_SIGNAL`, with the payload as a JSON byte array and the server forwarding it to the target (`GO/OnlineServices_Init.cpp:1287-1296`, `svc/Controllers/WebSocket/WebSocketController.cs:1114-1146`).
5. ICE then runs over UDP. Candidate types come from `relay_all_traffic`: all types normally, TURN only if set (`GO/NetworkMesh.cpp:719-721`). The ICE implementation comes from the service's `ice_implementation`: 2 WebRTC by default, or 1 native (`GO/NetworkMesh.cpp:724`, `GOH/OnlineServices_Init.h:346`). GO's patch notes confirm the service picks it **[web]**, and the two interoperate (`gns/README_P2P.md:25-26`).
6. Before a match starts, the host asks for a full mesh check. Every member reports who it is connected to, and the service decides (`GO/OnlineServices_Init.cpp:1343-1354`, `GO/OnlineServices_RoomsInterface.cpp:1169-1226`). Published defaults: an 8 s window and 2 attempts (`svc/appsettings.json:38-41`).

### Packet format

From the outside in, on a peer link:

1. UDP datagram: ICE or STUN traffic, or TURN framing around GNS data.
2. GNS data packet header: flags, connection id, sequence number (`gns/src/steamnetworkingsockets/clientlib/steamnetworkingsockets_udp.h:28-40`), then AES-GCM encrypted payload.
3. GNS message, sent reliably (`GO/NetworkMesh.cpp:1336-1343`).
4. One channel byte: `0` game, `1` anti-cheat (`GOH/NGMP_include.h:10-14`, `GO/NetworkMesh.cpp:1330-1334`).
5. `TransportMessageHeader`: `u32 crc`, `u16 magic = 0xF00D` (`Core/GameEngine/Include/GameNetwork/NetworkDefs.h:60-66`, `:210`, `GO/NextGenTransport.cpp:772-792`).
6. Game payload, at most 1098 bytes (`Core/GameEngine/Include/GameNetwork/NetworkDefs.h:73`).

GNS sizes that matter: 1300 bytes is the default and maximum UDP message size (`gns/src/steamnetworkingsockets/clientlib/csteamnetworkingsockets.cpp:87`, `gns/src/steamnetworkingsockets/steamnetworkingsockets_internal.h:266`). The connection timeout is 10 s (`gns/src/steamnetworkingsockets/clientlib/csteamnetworkingsockets.cpp:76-77`).

### Encryption and keys

- GNS encrypts peer traffic with AES-256-GCM by default (`gns/src/steamnetworkingsockets/clientlib/csteamnetworkingsockets.cpp:97`, `gns/src/steamnetworkingsockets/clientlib/steamnetworkingsockets_connections.cpp:1243`). GO never changes `Unencrypted`.
- Keys come from a per-connection key exchange inside the GNS handshake (`gns/src/steamnetworkingsockets/clientlib/steamnetworkingsockets_connections.cpp:1280-1281`). The handshake travels through GO's signalling.
- The legacy XOR in `Core/GameEngine/Source/GameNetwork/Transport.cpp:39` is not used by `NextGenTransport`.
- The relay and TURN only ever see ciphertext on peer links. The relay **does** see JWTs, TURN credentials, chat, lobby data and RNG seeds, because it proxies the API and WebSocket in the clear. GO's client redacts tokens and RNG seeds from its own release logs (`GO/HTTP/HTTPRequest.cpp:207-225`), so the relay should treat them as sensitive too.

### Where lockstep goes, and who sees whose IP

Lockstep goes directly between peers, or through TURN when no direct path works. It does not go through GO's service.

- **Normal mode:** ICE exchanges host and server-reflexive candidates through signalling, so peers can learn each other's public IP, and private addresses too (`GO/NetworkMesh.cpp:719-721`, `gns/include/steam/steamnetworkingtypes.h:1732-1737`).
- **`relay_all_traffic` true:** only TURN candidates are shared.
- **Lobby JSON:** the published lobby data carries region and latency, not IPs (`GO/OnlineServices_LobbyInterface.cpp:627-632`).
- **Through the planned relay:** peers would see the relay's IP and the player's IP would stay hidden from them. GO's service and peers would attribute every web player to the relay's location **[inf]**.

---

## 4. Anti-cheat

### Summary

GO has two layers. Plugins are open source, but the real one needs a closed Epic SDK and runs only on Windows. The other layer is GO's own "integrated" checks inside the client, reported to the service.

This project declares what is true.

### Plugins

The client loads `plugins/<name>/<name>.dll` as named in `settings.json` (`GO/OnlineServices_Init.cpp:905-912`, `GO/GeneralsOnline_Settings.cpp:312-315`), through `LoadLibraryA` and about 30 exports (`GOH/PluginInterfaces.h:151-187`). Plugins must be x86 Windows DLLs (`acif/README.md:10`).

| Plugin | `anticheat_id` | Source | What it does |
|---|---|---|---|
| `easyanticheat` | `9481` (`eac/plugin_eac.cpp:1142-1145`) | Wrapper is LGPL-2.1. It needs Epic's closed EOS SDK and GO's private EOS credentials, set at build time (`eac/README.md:6-25`) | Signs in to EOS with GO's session token (`eac/plugin_eac.cpp:2765-2766`) and starts an EAC session in **peer-to-peer mode** (`eac/plugin_eac.cpp:2444`). Registers each remote player as a protected Windows client (`eac/plugin_eac.cpp:2565-2574`). Reports integrity violations (`eac/plugin_eac.cpp:2090`) and kick requests (`eac/plugin_eac.cpp:2215-2247`). |
| `goanticheat` | `0` (`goac/plugin_goac.cpp:107-110`) | LGPL-2.1 | In the public source, every function is a stub that reports success (`goac/plugin_goac.cpp:86-110`). That source lacks exports the current client requires, such as `StartSignalling` (`GO/PluginInterfaces.cpp:345`), so the shipped DLL must differ from it **[inf]**. |
| None | `0` (`GO/PluginInterfaces.cpp:59-67`) | n/a | The client carries on when no plugin is configured (`Core/GameEngine/Source/GameNetwork/GameSpy/MainMenuUtils.cpp:871-896`). |

What happens around EAC:

- After plugin sign-in, the client posts an Epic token to `ProvideMWToken` (`GO/OnlineServices_Auth.cpp:149-172`), and the server validates it against Epic's keys (`svc/Controllers/OID/OIDController.cs:158-237`). That sets the player's middleware id, which is sent to other players (`svc/LobbyManager.cs:1250-1253`). A rejected token tears down the whole session (`GO/OnlineServices_Auth.cpp:162-165`).
- A local integrity violation, or a kick request naming the local player, makes the client leave the lobby. A kick request naming someone else disconnects that peer (`GO/PluginInterfaces.cpp:226-282`, `GeneralsMD/Code/GameEngine/Source/GameClient/GUI/GUICallbacks/Menus/WOLGameSetupMenu.cpp:2498-2505`).
- Kick reasons include AC not running, heartbeat timeout, client violation, and temp or permanent bans (`GOH/PluginInterfaces.h:39-52`).
- Patch notes dated 2026-04-28 say EasyAntiCheat is active, without saying whether it is mandatory or where it applies **[web]**.
- The launcher's live path starts `GeneralsOnlineZH_60.exe`. `EAC_LaunchGeneralsOnline.exe` is reachable only when the test-environment selector is showing (`launcher/Launcher/Pages/LauncherPage.xaml.cs:94-95`, `:338-343`). So what share of live players run EAC is unknown.

A kernel component is not visible in any of these sources. EAC is generally known to use one on Windows **[inf]**, and it would live in Epic's closed parts.

### GO's integrated checks

| Check | What the client reports | Where | What the published server does |
|---|---|---|---|
| Hardware ids | Registry `MachineGuid`, first MAC address, C: volume serial | `GO/NGMP_Helpers.cpp:351-407`, sent at `GO/OnlineServices_Auth.cpp:518-520` and `:318-320` | Stores them. A missing field gets flagged for review (`svc/Controllers/CheckLogin/CheckLoginController.cs:202-205`) |
| Code hash | SHA-256 of the exe's `.text` section, as `exe_crc` at login | `GO/NGMP_Helpers.cpp:278-319` | Keeps it for comparison later (`svc/Constants.cs:1258-1263`, `:1350-1366`) |
| Module list | Full path and size of every loaded module, on `WS_KEEPALIVE` | `GO/OnlineServices_RoomsInterface.cpp:61-108`, `:1686-1706` | Flags modules outside a private allow-list (`svc/Controllers/WebSocket/WebSocketController.cs:1227-1315`) |
| Screenshots | JPEG to a presigned URL on `PROBE`, if `do_probes` | `GO/OnlineServices_RoomsInterface.cpp:1531-1549`, `GO/OnlineServices_Init.cpp:102-152` | Requested by the service during matches. GO's patch notes state the anti-cheat purpose (`PatchNotes/092625.md:61`) |
| Match media | Load and score screen shots, replay upload | `GO/OnlineServices_Init.cpp:238-274`, `:1003-1040` | Stored per match |
| Declared anti-cheat | `anticheat_id` on join, create and quick match | `GO/OnlineServices_LobbyInterface.cpp:1172`, `:1529`, `GO/OnlineServices_MatchmakingInterface.cpp:87` | **Enforced**: see below |
| Lobby CRCs | `exe_crc` and `ini_crc` on create and quick match. The exe value is a CRC of the exe file, the version and game scripts (`GeneralsMD/Code/GameEngine/Source/Common/GlobalData.cpp:1368-1425`) | `GO/OnlineServices_LobbyInterface.cpp:1526-1527`, `GO/OnlineServices_MatchmakingInterface.cpp:85-86` | Quick match requires an exact match (`svc/MatchmakingManager.cs:743`). Custom lobbies need matching values too (`GeneralsMD/Code/GameEngine/Source/GameClient/GUI/GUICallbacks/Menus/WOLLobbyMenu.cpp:2473-2488`) |

Flags go to review tables, and a person can ban an account over them. GO's site has a public bans page **[web]**.

### What a web client faces

| Step | Honest web client | Published server result | Can it be honestly passed? |
|---|---|---|---|
| Version check | Reports a real value that matches no native exe | `NeedsUpdate` | **No.** Needs a decision from GO. |
| Login | `client_id: custom_third_party_client`, no hardware ids | Tokens issued. Review flags on every login | Yes, with flags. All web accounts would also share one device hash, the hash of `NONE` **[inf]** |
| Browse lobbies, chat, friends | Normal | Allowed | Yes |
| `WS_KEEPALIVE` | `resp: []`, because a browser has no loaded modules to report | To confirm with GO | Yes, but GO should know its scan sees nothing |
| `PROBE` | Real canvas screenshot and `PROBE_RESP` | Same as other clients | Yes, once WebGPU readback exists |
| `anticheat_id` | `-1` (`NONE`, `svc/LobbyManager.cs:1833-1838`) | See below | Yes, but it limits who it can play |
| Join an official client's lobby | Sends `-1` | **`417 Expectation Failed`** (`svc/Controllers/Lobby/LobbyController.cs:901-907`), shown as a different anti-cheat from the host (`GeneralsMD/Code/GameEngine/Source/GameClient/GUI/GUICallbacks/Menus/WOLLobbyMenu.cpp:1231-1232`) | **No.** Only GO can change this. |
| Quick match | Sends `-1` and its own `exe_crc` | Buckets only with identical values (`svc/MatchmakingManager.cs:743`, `:749`) | Only against other web clients |
| Host a lobby | Sends `-1` | Created, marked with the no-anti-cheat symbol in its name (`svc/LobbyManager.cs:814-829`) | Yes, but official clients cannot join it: they never send `-1`, and their CRC check fails too |
| Join an EAC lobby | n/a | `417` first. EAC itself treats every peer as a protected Windows client | **No.** EAC cannot run in a browser. |

**Could a client that cannot run the component join at all?** By the published code: it can log in and it can play others declaring the same "none". It cannot join anyone running an anti-cheat.

Evidence from the live site on 2026-11-03: of about 354 lobbies read out of 358 listed, every one showed "Anticheat Secured" **[web]**. So no honest-`-1` opponents are visible today. Lobby counts came through a summarizing tool and may be off by a few. How the site derives that label is not public.

The macOS fork in the repo's `okjid` remote isn't a template for identity or anti-cheat handling, because this project's rule is stricter. It does add a `platform` key to its login body, which is the same idea as the optional field in section 2.

### Porting rule

The engine's default code paths don't produce an honest value for a web build, so the port must set these explicitly:

- Send `anticheat_id` `-1`, unless GO says otherwise in writing.
- Send nothing for the hardware id fields and the code hash, rather than invented values.

---

## 5. Binary dependencies

### Prebuilt or closed

| Item | Where | Used by online code? | Source | For WASM |
|---|---|---|---|---|
| `discord-rpc.dll` | `GO/Vendor/DiscordRPC/`, MIT | Optional, loaded at runtime (`GO/DiscordRichPresence.cpp:120`) | Open upstream | Drop. No equivalent needed. |
| `libsodium.lib` | `GO/Vendor/libsodium/` | **No.** Nothing in source or CMake refers to it | Open upstream | Ignore. |
| `easyanticheat.dll` | Not in repo. `plugins/easyanticheat/` at install time | Yes, when selected | Wrapper LGPL-2.1, depends on the closed parts below | **Cannot be ported or replaced.** No honest substitute exists. |
| EOS SDK, EAC runtime, `EAC_LaunchGeneralsOnline.exe` | Not in repo | Through the plugin | **Closed**, Epic | **Cannot be ported.** |
| `goanticheat.dll` | Not in repo | When selected | LGPL-2.1, though public source looks older than what ships | Not applicable: x86 Windows DLL, and claiming it would be untrue. |
| `steam_api.dll` | Not in repo, loaded if present | Init only, optional (`GO/OnlineServices_Init.cpp:209-214`) | **Closed**, Valve | Drop. |
| `crashpad_handler.exe` | vcpkg output (`GeneralsMD/Code/Main/CMakeLists.txt:123-129`) | Crash reports only | Open | Drop. Do not send web crashes to GO's Sentry project. |
| Patcher exe | Downloaded from `patcher_path` | Update flow | **Closed**, GO's installer | **Never fetch or run.** |
| `BrowserEngine.dll`, `wolapi.dll`, `woldbg.dll` | `GeneralsMD/Run/`, `Core/Tools/wolSetup/` | No references in GO's code | Legacy retail | Ignore. |

### Built from source through vcpkg

| Item | Where | For WASM |
|---|---|---|
| libcurl with OpenSSL and WebSockets (`vcpkg.json:20-22`) | HTTP and WebSocket | Replace with browser `fetch` and a relay channel. No plain port is needed. |
| GameNetworkingSockets 1.6.1 fork, BSD-3 (`vcpkg.json:25-28`) | Peer mesh | **Needs a real port.** Open source, but no Emscripten support in the tree (no matches in its `CMakeLists.txt`, `cmake/` or `src/`). Sockets and interface discovery must be shimmed to the relay. It also runs a socket service thread (`gns/src/steamnetworkingsockets/clientlib/steamnetworkingsockets_socketthread.cpp`), which needs WASM threads. The brief's COOP and COEP headers allow those. **[inf]** |
| OpenSSL | GNS crypto. GO's vcpkg port builds with `-DUSE_CRYPTO=OpenSSL` | Needs a WASM build, or use GNS's libsodium backend (`gns/src/common/crypto_libsodium.cpp`) |
| Protobuf | GNS | Needs a WASM build. |
| WebRTC ICE (`webrtc` feature), abseil | GNS ICE client 2 | **Avoid.** Use native ICE, which is built in and interoperates (`gns/README_P2P.md:15-26`). |
| sentry-native | Crash reports | Drop. |
| ffmpeg, zlib, stb | Video, compression, images | Not networking. Out of scope here. |

**ICE trap:** if the service sends `ice_implementation: 2` and WebRTC is not compiled in, the connection fails with "not compiled" (`gns/src/steamnetworkingsockets/clientlib/steamnetworkingsockets_p2p_ice.cpp:359-362`). A web build without WebRTC must force 1 locally, overriding `GO/NetworkMesh.cpp:724`. That is safe on the wire, since the two interoperate.

### Windows code to replace

`GO/` also calls Windows directly and needs a web implementation or removal:

- DPAPI (`GO/OnlineServices_Auth.cpp:650`)
- `ShellExecuteA` (`GO/OnlineServices_Auth.cpp:458`)
- `GetSystemInfo` ARM refusal (`Core/GameEngine/Source/GameNetwork/GameSpy/MainMenuUtils.cpp:851-862`). A commit message there calls it temporary until the service handles ARM. The reason is not stated, and floating-point determinism across CPUs is a guess **[inf]**.
- D3D8 screenshot capture (`GO/OnlineServices_Init.cpp:581-610`)
- Registry, adapter, volume and PE reads (`GO/NGMP_Helpers.cpp:278-407`)
- `EnumProcessModulesEx` (`GO/OnlineServices_RoomsInterface.cpp:69`)
- WinHTTP proxy lookup (`GO/HTTP/HTTPManager.cpp:165-166`)

---

## 6. Terms

### In the repo

| File | Relevant content |
|---|---|
| `README.md` at `6ff4044` | Upstream project text. Nothing on GO's servers, third-party clients, automation or test accounts. |
| `SECURITY.md:5` | Report vulnerabilities privately, not in public channels. `svc/../SECURITY.md:5-7` says the same for GO's services. Applies to anything found while testing. |
| `CONTRIBUTING.md:11-17` | Rules for LLM-written pull requests. Nothing on clients or accounts. |
| `TESTING.md:1-14` | Replay compatibility tests only. No accounts or servers. |
| `LICENSE.md:603-618` | GPL-3.0 with EA's extra terms: no trademark rights, no claimed EA affiliation, and modified versions must be marked as modified and not identified as the original. This backs honest identification, and matters for naming the project. |
| `PatchNotes/092625.md:61`, `:69` | Match history includes screenshots for anti-cheat purposes. Deletion requests go to a privacy address and are checked for cheating first. |

Licenses of the other repos: Services is AGPL-3.0, so a modified self-hosted copy has source obligations. Launcher is GPL-3.0. Plugins are LGPL-2.1.

### On GO's website **[web]**

The site has no terms of service page in its navigation. It has a Code of Conduct and a Privacy Policy.

**Code of Conduct (`/codeofconduct`), paraphrased:**

- Connecting to or using the service means agreeing to the rules, which can change at any time, with updates announced in the Message of the Day.
- Cheating and unauthorized modifications are prohibited, including hacks, exploits and tools giving an unfair advantage.
- Sharing accounts or impersonating others brings penalties.
- Attacking or exploiting the service or its infrastructure means a permanent ban.
- Repeatedly joining and leaving without good reason may bring timeouts or bans.
- **It says nothing about** third-party clients by name, bots, automation, scripts, multiple accounts, test accounts, reverse engineering, relays, VPNs or proxies. It gives no contact method beyond "proper channels".

**Privacy Policy (`/privacypolicy`), paraphrased:** IP addresses are kept for connectivity and ban enforcement. It does not mention hardware ids, module lists, screenshots, replays or anti-cheat.

**Development page and FAQ, paraphrased:** contributions are welcome through Discord. Nothing on third-party clients, APIs, test environments or test accounts.

**Not read:** GO's Discord rules, which may say more, and the `/login` page, skipped as a login server.

### What this means

- **Nothing found forbids automated testing or test accounts, and nothing found permits them.**
- **"Unauthorized modifications" is the closest rule and it is ambiguous.** A web build could count as one. It is meant for cheating, but it does not say so.
- **The login is not built for automation.** Each sign-in needs a real Steam, Discord or GameReplays identity at the provider's page. The two test accounts therefore have to be such identities, and the owner signs in by hand. A username and password cannot be sent to any GO endpoint, and entering a provider password stays with the owner.
- **The brief's limits still stand:** no load testing, no rapid-fire automated logins, at most two accounts, and short test matches (brief 1.7).

### Testing without touching live GO

Services is public and can be self-hosted. A debug build accepts any login code, creates `DEV_ACCOUNT_n` users (`svc/Controllers/CheckLogin/CheckLoginController.cs:121-155`), returns fake TURN credentials (`svc/Constants.cs:2623-2627`), and skips the CRC checks (`svc/Controllers/VersionCheck/VersionCheckController.cs:185-193`). It needs MariaDB and .NET 10. That is our own server, so it raises none of the concerns above, and it can carry all automated relay tests. Reserve live GO for short attended runs after the owner has heard from GO.

---

## 7. What the relay must do

These requirements fit the routes in `docs/WEB_CONTRACT.md`, `/go-api/*` and `/relay`. Items marked **[inf]** are design conclusions from the facts above.

### `/go-api/*`: HTTP proxy

- Forward to `https://api.playgenerals.online/env/prod/contract/1/*` only by default. Keep `api-ru` and the `:2087` test host behind configuration, and the test host off until GO agrees. Never accept a target from the client: this guards against SSRF.
- Support GET, POST, PUT and DELETE. Pass bodies through unchanged and pass status codes through exactly. The client depends on `200`, `201`, `205`, `401`, `404`, `406`, `417` and `423`.
- Send `Host` for the real API host, because `ws_uri` is built from it (`svc/Program.cs:1154-1158`). Do not rewrite `ws_uri` in the body. Have the web client route it to `/relay`.
- Send an honest `User-Agent` naming the web build, and no client-supplied forwarding headers.
- Keep added latency low. The client's default timeout is 5 s.
- Do not answer `NeedsUpdate` by downloading anything.
- Handle uploads: presigned `PUT` targets arrive over the WebSocket. Allow only hosts seen in practice, once a live test shows what they are, up to the 10 minute upload timeout.
- Expect all web users to share one IP. Login polling is one request per second per client, and the published rate limiter is 50 burst, 10 per 5 s, keyed by user or IP if enabled (`svc/Program.cs:1249-1273`). Do not retry aggressively.

The login page is **not** proxied. The web client opens the `gamecode` URL in a new tab and polls. COOP severing the opener does not matter, since nothing passes between the windows.

### `/relay`: service WebSocket

- Open the upstream WebSocket on the browser's behalf, adding `Authorization` and `is-reconnect`, which browsers cannot set.
- Report the upgrade's HTTP status to the browser, since browser APIs hide it. `205` must reach the client as "reconnect fresh".
- Keep frame types as sent. The client sends binary frames holding JSON and reads text frames. Allow at least 2 MB per message (`GO/OnlineServices_RoomsInterface.cpp:923`).
- Hold exactly one upstream per session. A second connection for the same user kills the first.
- This traffic must arrive reliably and in order, so use a WebTransport stream rather than datagrams. Ping and timeout handling belongs to the client: forward them rather than faking them.

### `/relay`: UDP

- **Open one UDP socket per ICE session, not one per browser client.** This departs from brief 4.6. GNS opens its own socket for each local interface in each ICE session (`gns/src/steamnetworkingsockets/clientlib/steamnetworkingsockets_ice_client.cpp:1805-1811`, `:1948`), and a mesh has one session per peer. Sharing one socket would need changes to GNS's demultiplexing **[inf]**. Each browser client still appears as its own endpoints. Cap at about 8 sockets per client, since lobbies hold 8 (`svc/LobbyManager.cs:723`).
- Tag each datagram with a socket id and the remote IP and port, in both directions. Support IPv4. IPv6 is optional **[inf]**.
- Tell the client its socket's public address. The GNS shim must report that as the host candidate in place of real interfaces, or ICE warns about having no host candidates (`gns/src/steamnetworkingsockets/clientlib/steamnetworkingsockets_p2p_ice.cpp:493-495`).
- Offer name resolution, since browsers cannot do DNS for STUN and TURN hosts **[inf]**.
- Make sure the host allows outbound UDP to ports 53 and 3478 and 19302, and inbound on the sockets. Port 53 is often filtered for non-DNS traffic **[inf]**.
- Forward STUN, TURN and peer packets unmodified, with no reordering, buffering or retransmission. All NAT traversal and keepalive logic stays in GNS in the browser, so the relay reproduces it simply by forwarding. A public relay socket behaves like a host with no NAT **[inf]**.
- **Plan for oversized datagrams.** Native peers send up to 1300 bytes of UDP payload, more with TURN framing, and this size is the sender's setting, so the web client cannot lower it for inbound packets. WebTransport's limit is set by the path and is often near that size. Check `datagrams.maxDatagramSize` at runtime. A packet that does not fit plus its header needs a stream fallback, because dropping it could kill the connection. Lower the web client's own `MTU_PacketSize` for outbound. Measure this early **[inf]**.
- Keep sockets for the WebTransport session's life and close them at its end. GNS gives up after 10 s of silence, so a relay stall longer than that drops peers and can fail the 8 s mesh check.
- WebSocket fallback, per the brief: same framing over TCP. Expect stalls under loss, so treat it as a last resort **[inf]**.

### Abuse limits

An open UDP relay is an attack tool, and GO's rules ban attacks on its service.

- Require the `wgo_session` cookie, as the contract says.
- Refuse private, loopback, link-local and metadata destinations.
- Rate limit packets and bytes per client, and cap sockets and destinations per client.
- Consider allowing peer destinations only while a lobby is active **[inf]**.

### Honesty and secrets

- The relay must not fabricate or alter anything the client reports: hardware ids, module lists, hashes, `client_id`, `anticheat_id`.
- It must not emulate, answer for or filter anti-cheat traffic. Messages `AC_REGISTER_PLAYER`, `AC_DEREGISTER_PLAYER` and `ANTICHEAT_MESSAGE` pass through untouched, and the client treats them as no-ops without a plugin.
- Never log `Authorization`, refresh or session tokens, login codes, TURN credentials, presigned URLs or `RNGSeed`. A login code is enough to claim the login while it is live.
- The relay operator can see every player's tokens and match RNG seeds. Tell players that plainly.

### Known effects of a shared relay

- GO sees the relay's IP and location for every web player: wrong region labels, wrong lobby tags, and one IP in device records (`svc/Controllers/CheckLogin/CheckLoginController.cs:205`). An IP-level ban or rate limit would hit all web players together **[inf]**.
- `ConnectionOutcome` will report relay paths as direct, since the relay is invisible to GNS (`GOH/NetworkMesh.h:56-60`) **[inf]**.
- If `enforce_ip_match` is on live, the API and WebSocket must leave from the same IP. Use a single egress address.

---

## 8. What only a live test or GO can confirm

### Live test, by the owner, briefly

- Whether `custom_third_party_client` still gets full access on the live service.
- The real answer to `VersionCheck`, and whether the service ties it to anything else.
- `417` on `-1`, and whether a `-1` lobby is allowed or visible.
- Live `ServiceConfig` values: `do_probes`, `relay_all_traffic`, `ice_implementation`, `use_new_networking`.
- What the front end, likely Cloudflare **[inf]**, does with a Go HTTP client: challenges, rate limits, bot rules.
- Whether `enforce_ip_match` is on.
- Refresh token lifetime, presigned upload hosts, and real datagram sizes through WebTransport.
- Whether a web peer can complete the full mesh check.

### Questions only GO can answer

The owner handles contact (brief 1.7).

1. May a web build use `custom_third_party_client` on live, or will GO add its own id?
2. What should a web build do about `VersionCheck`, given it has no exe?
3. What `anticheat_id` should it send? Is there any way for a web build and native players to share a lobby, for example hosts opting in?
4. Will missing hardware ids and an empty module list get accounts flagged or banned? Can test accounts be exempted?
5. Are many players behind one relay IP acceptable?
6. Are two test accounts and short automated or scripted sessions acceptable? Is the `:2087` test environment open to this?
7. Should test matches keep `track_stats` off so ladders stay clean?
8. Is a web build an "unauthorized modification" under the Code of Conduct?

**Web against native also needs identical simulation results.** Even with GO's agreement, the two builds must stay in lockstep (`GeneralsMD/Code/GameEngine/Source/GameClient/GUI/GUICallbacks/Menus/ScoreScreen.cpp:1997`). This document does not assess that.

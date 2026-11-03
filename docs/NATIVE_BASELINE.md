# Native client baseline: headless replay run

What the native Windows client (GeneralsMD, the build described in `NATIVE_BUILD.md`) does with real
game data when asked to replay the retail `GeneralsReplays/GeneralsZH` corpus headless. The web
build will not play native clients (see `DECISIONS.md`), so this is a record of behaviour, not a
compatibility test. The retail corpus is a negative control here: GO runs at 60 Hz with
`RETAIL_COMPATIBLE_CRC 0`, so mismatches were expected.

**No GUI session was run.** Every run used `-headless`. Rendering, audio, menus, input and every
online feature were not exercised.

## What was run

- Executable: the Release `win32-vcpkg` build, copied out of the build tree into a separate run
  folder outside the repo.
- Game data: the ingested files from `tools/ingest-assets` output, hard-linked into the run folder
  (122 files: the Zero Hour `.big` archives, `Data/` and the base-Generals archives under
  `ZH_Generals/`). Base Generals is also found through the per-user `InstallPath` registry value
  (see `DECISIONS.md`), which pointed at the Steam `ZH_Generals` folder.
- Third-party DLLs copied from the Steam install: `mss32.dll` and `binkw32.dll`, the only two that
  the exe imports statically and the system does not supply (checked with `dumpbin /dependents`).
- Deliberately not in the run folder: `crashpad_handler.exe`, `discord-rpc.dll`, `steam_api.dll`,
  any EasyAntiCheat file and the PDB.
- Replays: the 10 `.rep` files in `GeneralsReplays/GeneralsZH/1.04/Replays`, copied into
  `Replays/wgo-corpus/` under the game's settings folder, and the corpus map
  `Maps/tansooo` copied into its `Maps` folder. (The other corpus map was already there with
  identical bytes.) All of that was removed afterwards.
- Command, one replay per process, no `-jobs`, working directory the run folder, stdout and stderr
  redirected to files:

```
GeneralsOnlineZH.exe -headless -replay "wgo-corpus/<name>.rep"
```

- Limit 10 minutes per replay with a kill on timeout. Nothing reached it.
- Replays ran in order of file size, smallest first. A polling loop checked the process's TCP
  connections and its child processes, sleeping 2 seconds between passes. Passes took far longer
  than that in practice (see Results). They were not logged, so the number of samples per run is
  unknown.

## Reproduce

1. Build per `NATIVE_BUILD.md`.
2. Make a run folder. Copy `GeneralsOnlineZH.exe`, `mss32.dll` and `binkw32.dll` into it. Hard-link
   (same drive) or copy the ingested game files into it, keeping their relative layout. Do not copy
   `crashpad_handler.exe` (see the crash-report section for why this matters).
3. Check that `HKCU\SOFTWARE\Electronic Arts\EA Games\Generals\InstallPath` points at a base
   Generals folder. Back up the whole game settings folder first: the engine writes into it (see
   Side effects).
4. Copy the replays into a subfolder of `Replays/` and the corpus maps into `Maps/`, as `TESTING.md`
   says.
5. Run the command above for each replay and read the exit code and the first
   `CRC Mismatch in Frame` line on stdout.
6. Remove what you added, restore anything the engine changed from the backup.

## Results

Ten replays, one process each. "Seconds" is the time from launch until the runner's polling loop
finished, not how long the game ran. The game's last stdout write came 3 to 6 seconds after launch
in all ten runs. In the six crash runs the small crash dump was complete 4 to 8 seconds after launch
(from dump timestamps), and the loop only noticed it 16 to 51 seconds later, on its last pass. The
engine kept two of the full dumps, and each has a modified time within a second of its small dump,
so writing the full dump does not explain the gap. The real exit times were not recorded.

| Replay (file in `GeneralsReplays`) | Exit code | First mismatch frame | Seconds | Note |
|---|---|---|---|---|
| `11-25-57_2v2_Kana_...` | -1073741819 (0xC0000005) | none seen | 55.5 | access violation, see below |
| `05-01-50_2v2_amoor123_...` | -1073741819 | none seen | 40.9 | access violation |
| `00-03-45_2v6_PC03_ss_...` | -1073741819 | none seen | 42.6 | access violation |
| `366648` | 1 | 110 | 34.5 | CRC mismatch, run ended there |
| `00-41-30_2v2_Nic_...` | -1073741819 | none seen | 24.1 | access violation |
| `00-31-22_2v2_Derky_...` | 1 | 110 | 20.4 | CRC mismatch |
| `18-13-02_3v3_Supremac_...` | -1073741819 | none seen | 20.5 | access violation |
| `15-07-24_2v2v2_Emkill_...` | -1073741819 | none seen | 28.7 | access violation |
| `12-11-35_2v2_babai_...` | 1 | 110 | 46.6 | CRC mismatch (stdout gives the length as 27:32) |
| `!Golden Replay #1` | 1 | 111 | 55.9 | CRC mismatch (stdout gives the length as 49:34) |

Summary: 4 of 10 ended with a CRC mismatch at frame 110 or 111 and exit code 1. 6 of 10 crashed
with the same access violation. No replay ran to its end. No run timed out. The lengths are what
stdout printed, which counts frames at GO's 60 per second. `DECISIONS.md` says the corpus was
recorded at 30, so the real lengths would be about double.

Earlier launches, made while the runner was being tested, are not in the table. There were five,
going by the 15 Sentry `.run` folders created in total. Four of them left crash dumps, and the one
dump kept from them shows the same exception, a read of address 0. The first, on the shortest replay
with a 120 second limit, was killed at the limit.

### The crash

The run reported the same fault in all six crash dumps: exception 0xC0000005 reading address 0, in
the exe at the same offset. Those dumps were deleted in cleanup, so only the exit codes can be
rechecked now, plus one kept dump from an earlier launch that shows the same read of address 0.
Resolved against the PDB, the offset is `RadiusDecalTemplate::createRadiusDecal`
(`Core/GameEngine/Source/GameClient/RadiusDecal.cpp:80`), the line
`result.m_decal = TheProjectedShadowManager->addDecal(&decalInfo);`.

My reading, not verified: `TheProjectedShadowManager` is null when running `-headless`, and the
first radius decal a replay creates (a special-power or ability marker) dereferences it. The source
was not patched and I did not check where the shadow manager is created. What was observed: six
retail replays crash headless at that line within about 8 seconds, and the other four stop at a CRC
mismatch before reaching it. Whether the six would also mismatch is unknown, because they crash
before the run says anything about CRCs.

## Network and crash reports

Read from the code before running, then checked against the run.

What the `-headless -replay` path does:

- `WinMain.cpp:975` parses the command line, `:982` skips window creation when headless, `:987`
  calls `NGMP_OnlineServicesManager::AttemptLoadSteam()`, `:1042` calls `GameMain()`.
  `AttemptLoadSteam` (`OnlineServices_Init.cpp:203-236`) only loads `steam_api.dll` from the
  default DLL search path. The file was absent, and the game log recorded "steam_api.dll not found.
  Running without Steam."
- `GameMain.cpp:45-56` creates the engine, calls `GameEngine::init()` and then
  `ReplaySimulation::simulateReplays` (`ReplaySimulation.cpp`), which runs the replay in process.
- GO's online services do not start on this path. `NGMP_OnlineServicesManager::CreateInstance()` has
  one caller, the main-menu online button (`Core/GameEngine/Source/GameNetwork/GameSpy/MainMenuUtils.cpp:865`),
  which is followed by `Init()`. The version check (`OnlineServices_Init.cpp:377`), the WebSocket
  and the anti-cheat plugin load (`:911`) hang off that. `Win32GameEngine.cpp:109` only ticks the
  manager if it exists.
- Discord: `GameEngine.cpp:842-843` always creates the Rich Presence object and calls `Initialize()`,
  which loads `discord-rpc.dll` from beside the exe (`DiscordRichPresence.cpp:117-126`). The DLL
  was left out, so it failed to load (the log recorded the failure) and nothing else happened.
- Stats upload (`Common/StatsUploader.cpp:59`, WinINet) only runs with `-exportStats` or
  `-statsUrl`. Neither was passed.
- `GameResultsQueue` is created at `GameEngine.cpp:721`. I did not trace what its threads do.

**Sentry does start on this path.** `GameEngine.cpp:522` calls `NGMP_OnlineServicesManager::InitSentry()`
unconditionally, headless included. In a Release build (`#if !_DEBUG`) it builds the options with
GO's DSN (`OnlineServices_Init.cpp:1096`), points the crash database at a folder in the settings
folder (`:1088`) and calls `sentry_init` (`:1147`). `ShutdownSentry` runs on engine destruction
(`GameEngine.cpp:370`). So a stock run, with `crashpad_handler.exe` beside the exe, would have the
crashpad backend active and would talk to GO's Sentry project even without a crash: `sentry_init`
goes on to submit what older runs left in the crash database (`src/sentry_core.c:271`) and start a
session (`:283`), and `sentry_close` ends that session. A crash would be uploaded too.

What stops that: the crashpad backend refuses to start when its handler file is missing
(sentry-native 0.17.0, `src/backends/sentry_backend_crashpad.cpp:988-996`, "unable to start
crashpad backend, invalid handler_path", returns 1). `sentry_init` then jumps to its failure path
(`src/sentry_core.c:244-247`) before it sets the global options, processes old runs, or starts a
session (`:257-283`). The default handler path is `crashpad_handler.exe` in the exe's folder, and the
run folder did not have it, so this run's Sentry init failed by design and neither a crash nor a
session was sent.

What was observed:

- `crashpad_handler.exe` is not in the run folder, and the folder's modified time shows nothing was
  added to or removed from it after setup, before the first launch.
- No child process of the game was seen in the samples the poller took.
- The poller logged no TCP connection owned by the game in any of the 10 runs. This is weak evidence:
  its passes were far apart (at least 16 to 51 seconds at some point in each crash run, see Results),
  the number of samples is unknown, some may have come after the game exited, and UDP was not
  checked.
- The only trace of Sentry in the settings folder was one new, empty `.run` folder in the crash
  database per launch (the first stage of `sentry_init`, before the backend step). No report,
  envelope or crash marker was created.
- The engine's own handler wrote local crash dumps (a small one and a full one of about 260 MB)
  into the settings folder. That is local only.
- Windows Error Reporting was not examined.

This is a code reading plus the observations above, not a packet capture, and the conclusion rests
mainly on the code reading. If the run folder ever contains `crashpad_handler.exe`, this build is
expected to contact GO's Sentry on every run and to upload any crash.

## Side effects in the settings folder

The engine wrote to the owner's settings folder during these runs. Everything was restored from a
backup taken first, and a full file listing (size, hash and modified time) of the folder matches the
backup again. The crash database folder's own modified time was restored by hand afterwards.

- Created: crash dumps from the six crashes and the earlier test runs, and one empty Sentry `.run`
  folder per launch. All removed.
- Changed: a game log that was about 33 MB was truncated to a few hundred bytes, and the map cache
  was rewritten. Both restored.
- Deleted by the engine: two older crash dumps, apparently pruned when new ones were written.
  Restored.
- A settings file got a new modified time without a content change, and four map files I had
  overwritten with identical copies got new modified times. Times restored.

Anyone repeating this should back the folder up first.

## What this does and does not show

It shows:

- The native build runs, loads the real Zero Hour data headless (INI, archives, maps) and parses and
  starts simulating retail replays.
- On four replays it detects a CRC mismatch at frame 110 or 111 and exits 1. That agrees with the
  negative-control expectation. I did not test the cause.
- On this path the only thing that could have reached GO is Sentry (crash reports and session data),
  and it did not start because the handler was not there.

It does not show:

- That the web build, or any build, can play or match GO-recorded replays. No GO replay was used.
- Anything about determinism between machines. Only the first mismatch frame was recorded.
- That headless mode works in general: 6 of 10 replays crash it. Fixing that means a source change
  (not made here).
- Anything about rendering, audio, UI, or online play. No windowed session was run.
- That nothing at all touched the network. The poll was coarse and TCP only.

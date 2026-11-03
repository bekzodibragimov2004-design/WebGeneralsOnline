# Headless WASM port

The plan for P2's core: the engine builds to Emscripten wasm32 with a null renderer and no audio, and a Node runner plays a replay to its end with the game data and reports per-frame CRCs. The same wasm file then runs in Chrome for the cross-machine test.

Written 2026-11-03 against `main`. GO commit 6ff4044 plus the web folders. Line numbers refer to that tree.

| Label | Meaning |
|---|---|
| **[V]** | Run on this laptop while writing this plan (emcc 6.0.13, Node 24.20, Chrome 156 headless) |
| **[S]** | Read in source |
| **[D]** | Read from the ingested game data in `<assets>` |
| **[R]** | Reported by an earlier survey run on this laptop, not repeated here |
| **[I]** | Inference |

Probes for [V] claims ran in a temporary folder outside the repo, so the results that matter are written here.

Paths on the owner's machine are written as placeholders. `<assets>` is the ingested game data folder (it holds `manifest.json`), `<replays>` is a folder outside the repo for test replays, and `<emsdk>` is the Emscripten SDK folder. Package briefs give the real paths.

**Nothing has been linked or run on the stock tree yet.** No engine frame has executed in wasm. Every statement below about engine behaviour at run time is [S] or [I] until the packages in section 15 prove it.

## 1. Goal and pass test

The owner decided on 2026-11-03 that the web build runs its own GO version and doesn't play native Windows clients (`docs/DECISIONS.md`). That replaces Route A, and the brief's "matching CRCs with the native Windows build" and "every corpus replay". Determinism now means every web client on one build produces an identical simulation on every supported machine: desktop Chrome on Windows x64 (Intel and AMD) and macOS ARM64 (M4).

**Pass test**

1. **Round trip.** A replay recorded by the wasm client plays back in the wasm client with no CRC mismatch, at least one comparison, and to its final frame. The per-frame CRC stream of the recording equals that of the playback.
2. **Cross machine.** The same `generals.wasm` file (the test build, section 3.2), the same replay and the same manifest give an identical per-frame CRC stream in Node and Chrome on this x64 Intel laptop, in Chrome on the owner's M4, and in Chrome on an AMD x64 machine.
3. **Negative control.** The retail `GeneralsReplays` corpus parses to end of file, and playing one reports a mismatch rather than passing or crashing. GO's rules can't pass it (60 Hz, `RETAIL_COMPATIBLE_CRC` 0, `docs/DETERMINISM.md` section 5).

The native build stays useful for debugging behaviour and for P4's screenshots. Matching its CRCs is not a goal.

**End point of the packages in this document:** a wasm build, and a Node runner that plays a replay to its end using `<assets>` and reports per-frame CRCs (package WP12). The packages after that harden determinism and prepare the owner's M4 run.

**Can't be checked on this machine:** real ARM64 behaviour, AMD behaviour, Chrome on macOS, and OPFS on macOS. See section 11.4. Section 15 says how P2 closes while those are pending.

## 2. Decisions on conflicts between the surveys

| Question | Decision | Why |
|---|---|---|
| `wchar_t` | Keep 4 bytes. Read and write 16 bits at file boundaries, using OKJID's hunks. No `-fshort-wchar`. | [V] With `-fshort-wchar` and 16-bit overrides of `wcslen` and `wmem*`, `std::wstring` still breaks: after 40 `push_back` calls `wcslen(c_str())` is 1, and `wstring::find` is wrong. The prebuilt libc++ holds `basic_string<wchar_t>` instantiations that assume 4 bytes (`push_back`, `append`, `insert`, `resize` resolve to the library). The same probe is correct at 4 bytes. One survey's "fixed at link time" doesn't hold beyond its small test. |
| File backend | WasmFS in both Node and Chrome, one link line, one wasm file. Not `NODERAWFS`. | [V] One wasm file ran in both with the node backend and the OPFS backend. The cross-machine test needs the same bytes everywhere, and `NODERAWFS` is Node-only and exposes host paths. |
| `-sGROWABLE_ARRAYBUFFERS` | **Don't use it.** | [V] With `=1`, OPFS writes fail in Chrome 156: `fclose` returns -1, file size stays 0, errno 28. Without it, writes, reads, seeks, 64 of 64 offset reads over 8 MB, `ifstream` and directory listing all work. Node passes either way. Surveys tested this flag on Node only. |
| Asset mount | One root, `/game`, as `docs/WEB_CONTRACT.md` says. No split into `/game/zh` and `/game/base`. | [D] The ingested Steam data holds base archives under `ZH_Generals/`. The first pass lists them recursively (`StdBIGFileSystem.cpp:59`), and a no-case sort puts `zh_generals\` after every Zero Hour archive [I, from `FileSystem.h:66`]. The registry shim returns no `InstallPath`, so the second pass is skipped. A `Generals/` layout from `--generals-dir` would sort before `INIZH.big` and is not supported here, so `web_fs_mount` refuses it. In Chrome this root is one OPFS mount with path mapping (section 8). |
| x87 ports in `wwmath.h` | Don't edit `wwmath.h`. Use its portable branches. | These only mattered for matching native. It also keeps the file clean for a later merge of PR #2670. |
| Float to int | `-mno-nontrapping-fptoint` on every engine target. | Both this and the default are defined and non-trapping. [V] This flag gives `INT_MIN` for NaN and out-of-range; the default saturates. The reason isn't native matching. The engine has run with x86's `INT_MIN` for over 20 years, and a saturated `INT_MAX` loop count or index is a new behaviour it has never seen. [V] LTO silently undoes this flag, so LTO is off (section 3.2). |
| Audio lengths | Integer parse of WAV and MP3 headers. No table dumped from native Miles. | Any fixed answer works for web clients. It must be the same in P5's real audio manager. |
| Dynamic LOD reading FPS | Not a blocker for now. | [D] `GameLOD.ini` sets `DebrisSkipMask=0` and `SlowDeathScale=1.0` at all four dynamic levels, with a comment that the old values were removed to prevent desyncs. So the path at `W3DDisplay.cpp:1864-1873`, `SlowDeathBehavior.cpp:234,392` and `ObjectCreationList.cpp:1363` is neutral on this data. The trace logs both values at boot in case data changes. |
| `_UNIX` | Off on `core_config`, by filtering in the injected CMake file, and on privately for `z_gameengine` only, for GameSpy's header (section 3.1). No edit to `cmake/config-build.cmake`. | [V] Configure with the filter leaves no `-D_UNIX` on the WW libraries. Without `_UNIX`, thread and mutex code takes the Win32 paths onto the shim instead of no-ops (`thread.cpp:90`, `mutex.cpp:29`, [R]). |
| Third-party packages | Small config packages and hand-written type shims for curl, GNS and sentry. GO's online `.cpp` files stay out of the P2 build. | Headers need types only. See section 7. |
| `StdBIGFileSystem` read checks | No edit. | Partial downloads stay under `/partial/` until verified (`docs/WEB_CONTRACT.md:75`), so a truncated BIG can't enter `/game`. |
| Text-mode CR stripping | No edit. | It only affected matching native's INI CRC on loose files. |

**Set aside because they only matter for matching native:** bit-exact `Inv_Sqrt`, `Sin`, `Cos`, `Float_To_Long`, `D3DXVec4Transform` and `lroundf`; exception tables; `-fno-builtin-*`; MSVC argument evaluation order and any AST lint for it; a port of MSVC's `std::sort` for `PartitionSolver.cpp`; a native audio-length dump; comparing name-key order or `iniCRC` as a requirement; any `RTS_WEB_MATCH_MSVC` option.

## 3. Build layout

### 3.1 No upstream CMake edits

Upstream edit: one line in `CMakePresets.json`, `"include": ["Platform/Web/cmake/presets.json"]`. The file is version 6, which allows it. Native presets don't set `CMAKE_PROJECT_genzh_INCLUDE`, so they never load our CMake file.

`project(genzh ...)` is at `CMakeLists.txt:34`, so `CMAKE_PROJECT_genzh_INCLUDE` runs our file before Core is added. It defines empty `INTERFACE` targets for the Windows-only link names and schedules `cmake_language(DEFER DIRECTORY ${CMAKE_SOURCE_DIR} CALL web_finalize)`.

[V] On today's tree, with the probe file `inj/WebProject.cmake`: configure and generate exit 0. `build.ninja` has no `-D_UNIX`, 981 lines with `-ffp-contract=off` including the PCH lines, output `GeneralsMD/generals.js`, and a link line with no `core_debug`, `core_profile_legacy` or Windows `-l` flags.

`web_finalize` does this:

1. Remove `_UNIX` from `core_config`'s `INTERFACE_COMPILE_DEFINITIONS`. Add it back as `PRIVATE` on `z_gameengine` only (item 6).
2. `target_link_libraries(core_config INTERFACE web_strict)`, so every engine target and its PCH inherit the flags.
3. Add `Platform/Web/Include` with `BEFORE`, `Platform/Web/Include/online_shims`, and `-include web_prefix.h` to `core_config`, plus `WEB_TEST_API` when that cache variable is on. [V] A force-include works with a CMake-style PCH, as long as the PCH is built with it too.
4. Add `-idirafter Platform/Web/Include/casefix` and `-idirafter Platform/Web/Include/casefix/up/x` to `core_config`. **Casefix must stay last in the search order.** [V] On NTFS a forwarding header found before the real one includes itself, so the real header never loads: `-Icasefix -Ireal` fails, and `-idirafter casefix -Ireal` compiles. The `up/x` folder serves spellings like `../ngmp_interfaces.h`, which resolve one level above an include directory (`GeneralsMD/Code/GameEngine/CMakeLists.txt:1205`). The forwarding header sits in `casefix/up/`, and `x` is an empty folder kept with a placeholder file.
5. Force-include the parallel packages' headers only where they're needed, so one package's edit doesn't rebuild everything: `extra/libs.h` comes through `web_prefix.h` everywhere, `extra/logic.h` and `extra/client.h` go on `z_gameengine` and `z_gameenginedevice`, and `extra/device.h` on `z_gameenginedevice`.
6. GameSpy, [V] on all 101 GameSpy objects: its platform header has no Emscripten branch (`gsplatform.h:37-38,135,228`), and 34 engine files reach it too. `target_compile_definitions(gsinterface INTERFACE __linux__)` covers every GameSpy module: 97 failures with no define, 0 with it. `__linux__` must not reach engine files, because it flips libc++ branches (`__atomic/contention_t.h:44`, `__locale_dir/locale_base_api.h:119`, `cxxabi.h:183`) [S]. So the 34 engine files get `_UNIX` instead, through `z_gameengine`'s private definition. It stays off `core_config`, so `thread.cpp` and `mutex.cpp` keep their Win32 paths. [S] On `z_gameengine` it only changes `#include "osdep.h"` lines, two typedefs and a `strtok_r` declaration in WW headers, plus `errno` lines in `udp.*`, so no shared class changes layout. [V] It made no file newly fail in the file-by-file census. The shim's `_strlwr` and `_strupr` must be `extern "C"`, to match `gsplatform.h:427`.
7. Filter `INTERFACE_SOURCES` and `SOURCES` with the `exclude_*.cmake` lists. These replace OKJID's `REMOVE_ITEM` blocks.
8. On `z_generals`: remove `WinMain.cpp`, `WinMain.h` and `VCRuntimeCheck.cpp`, add every `Platform/Web/Source/**/*.cpp` through a `CONFIGURE_DEPENDS` glob (leaving out `Source/Test/` when `WEB_TEST_API` is off), remove `core_debug` and `core_profile_legacy`, set `OUTPUT_NAME generals` (`web/src/launch.ts:9` expects `/engine/generals.js`), and add link options, including one `-Wl,--wrap=<name>` per line of `Platform/Web/cmake/link_wraps.txt`. These sources see `z_gameengine`'s and `z_gameenginedevice`'s include directories and definitions through generator expressions, plus `Include/Precompiled` (`GeneralsMD/Code/GameEngine/CMakeLists.txt:1208`), so a package syntax-checks its file with `z_generals`' flags from `compile_commands.json`.
9. Fail configure if a banned flag appears in `CMAKE_C_FLAGS`, `CMAKE_CXX_FLAGS` or `CMAKE_EXE_LINKER_FLAGS`.

`GENERALS_ONLINE` stays defined and untouched (`GeneralsMD/Code/GameEngine/CMakeLists.txt:1242`, `NextGenMP_defines.h:3-5`). Its macros change the simulation (`GENERALS_ONLINE_HIGH_FPS_SERVER`, `GENERALS_ONLINE_COMMUNITY_PATCH_CHANGES`, `RETAIL_COMPATIBLE_CRC` 0), and a build without it is a different game. Don't copy OKJID's forced `RETAIL_COMPATIBLE_*` values or its GameMath.

`find_package(CURL/GameNetworkingSockets/sentry CONFIG REQUIRED)` at `GeneralsMD/Code/GameEngine/CMakeLists.txt:1224-1226` is satisfied by `Platform/Web/cmake/pkgs/<name>/<name>Config.cmake`, each defining the expected target as an `INTERFACE` library. No vcpkg package is needed [R]. `zlib`, `stb`, `lzhl` and `gamespy` come through their existing `FetchContent` fallbacks. The build directory stays under `build/` because long paths broke the zlib clone in a deep folder ([V] again here, fixed only by `core.longpaths`).

### 3.2 Presets

| Preset | `-O` | LTO | `WEB_TEST_API` | Stack check | Purpose |
|---|---|---|---|---|---|
| `emscripten-headless` | 2 | No | On | 2 | Daily build, and every package up to WP13 |
| `emscripten-headless-opt` | 3 | No | On | 0 | **The test build.** The corpus, the M4 run and the results document use it |
| `emscripten-release` | 3 | No | Off | 0 | What later phases ship. Checked as in section 11.3 |

**The test API is compiled out of release** (brief section 7). `WEB_TEST_API` gates the frame hook line in `GameLogic.cpp`, the test-only counters in shared files, everything in `Platform/Web/Source/Test/`, and the `-web*` test options. The release wasm is therefore a different file from the test wasm, and the pass test on the test build says nothing directly about it. So it replays the whole corpus with the engine's own CRC compare and must report zero mismatches.

**No LTO, which is a deviation from brief section 4.1.** [V] `-O3 -flto -mno-nontrapping-fptoint` on a small program gives `(int)NaN` 0 and `(int)3e10` `INT_MAX`. `-O3` alone gives `INT_MIN` for both. So LTO silently undoes the float-to-int decision in section 2. Repeating the flag at link or passing `-Wl,-mllvm,-mattr=-nontrapping-fptoint` doesn't help [R]. `-flto` is therefore banned until someone shows `-webSelfTest` passing on an LTO build of the engine.

Cache variables for all: `CMAKE_BUILD_TYPE=Release`, `CMAKE_CXX_FLAGS_RELEASE=-O<n> -DNDEBUG` (and the `C` form), `CMAKE_PROJECT_genzh_INCLUDE`, `RTS_BUILD_GENERALS=OFF`, `RTS_BUILD_ZEROHOUR_TOOLS=OFF`, `RTS_BUILD_CORE_TOOLS=OFF`, `RTS_CRASHDUMP_ENABLE=OFF`, `RTS_MEMORYPOOL_DEBUG=OFF`, `CURL_DIR`, `GameNetworkingSockets_DIR`, `sentry_DIR`, `CMAKE_FIND_ROOT_PATH_MODE_PACKAGE=BOTH`, `CMAKE_C_FLAGS` and `CMAKE_CXX_FLAGS` set to `-pthread -fwasm-exceptions`, `CMAKE_EXPORT_COMPILE_COMMANDS=ON`, `WEB_TEST_API`, plus `WEB_EXTRA_COMPILE` and `WEB_EXTRA_LINK` for the variants in section 11.3. Toolchain file: `$env{EMSDK}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake`. Generator Ninja.

`cmake/compilers.cmake:39-40` appends `-g` to Release flags, so `web_finalize` adds `-g0` on `core_config` and on the link, or the wasm carries DWARF [R].

The build target is `z_generals`. `generals` isn't a ninja target ([V] `build.ninja:13338,13414`).

The version string compiles in the git commit and a dirty flag (`resources/gitinfo/gitinfo.cpp.in`, `version.cpp:399-434`), so wasm bytes change with every commit and with any uncommitted change. Compare wasm SHA-256 values only between runs of the same built file, and build anything the owner will compare from a clean commit.

### 3.3 Flags

**Every engine target, set at target level through `core_config`, never per source:**

```
-pthread -fwasm-exceptions -ffp-contract=off -fno-strict-aliasing -fwrapv
-fno-delete-null-pointer-checks -mno-nontrapping-fptoint -g0
```

[V] This set compiles with a CMake-style PCH. Per-source flags are out because `-msimd128`, `-ffast-math` and `-mno-nontrapping-fptoint` are hard errors against a PCH built without them [R].

MSVC behaviours these keep: no type-based aliasing (`BaseType.h:186`, `XferCRC.cpp:125`, `wwmath.h:102`) and wrapping signed overflow.

**Banned everywhere:** `-ffast-math`, `-Ofast`, `-funsafe-math-optimizations`, `-ffinite-math-only`, `-mrelaxed-simd`, `-fshort-wchar`, `-sGROWABLE_ARRAYBUFFERS`, `-flto`. One `-ffast-math` TU can poison strict callers through COMDAT merging, depending on link order, and adds `wasm-opt --fast-math` to the whole binary [R].

**Not in engine targets for now:** `-msimd128`. SIMD goes in new render and audio targets from P4. Adding it to client-side engine targets waits until replays pass, and then they run again.

**Link line.** [V] This exact line, apart from the wrap list and allow-list, linked and ran in Node and in Chrome from one wasm file, with pthreads, a proxied main, a C++ throw and catch, WasmFS node and OPFS mounts, a backslash path through the wrap, and 917 MB of heap growth. The trial stopped there; the 3.5 GiB cap is [R] on Node. `-sSTACK_OVERFLOW_CHECK` follows the preset.

```
-pthread -fwasm-exceptions -sPROXY_TO_PTHREAD -sEXIT_RUNTIME=1
-sENVIRONMENT=web,worker,node -sWASMFS=1
-sDEFAULT_LIBRARY_FUNCS_TO_INCLUDE=$stringToUTF8OnStack
-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=256MB -sMAXIMUM_MEMORY=3758096384
-sMEMORY_GROWTH_GEOMETRIC_CAP=256MB -sABORTING_MALLOC=0
-sSTACK_SIZE=4MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB -sSTACK_OVERFLOW_CHECK=2
-sERROR_ON_UNDEFINED_SYMBOLS=0 -Wno-pthreads-mem-growth -g0
-Wl,--wrap=<each line of Platform/Web/cmake/link_wraps.txt>
```

`$stringToUTF8OnStack` is there because of a bug in emscripten 6.0.13's OPFS directory listing. [V] `_wasmfs_opfs_get_entries` calls it without declaring it, so a program with `int main()` gets a `ReferenceError`, which is caught and turned into `EIO` on every `opendir`. It only works by accident when `main` takes arguments, which is why an earlier probe passed.

Stack sizes are starting choices, not measurements. The default 64 KB is far too small: `GlobalData.cpp:1393,1418,1429` each put a 64 KB array on the stack [R].

**Host-independent by construction:** the wasm file is frozen at link time. Compile-time constant folding, UB choices and libc++ algorithms are the same bytes on every machine. So anything that only differs between compilers is not a risk to the pass test.

## 4. Platform layer

```
Platform/Web/
  README.md                how to build and run
  NOTICE.md                files derived from OKJID's port, marked as modified, under GPL-3.0 with EA's terms
  shared-edits/<WP>.md     one ledger per package (section 9)
  undefined_symbols_allowlist.txt
  cmake/
    presets.json  WebProject.cmake  exclude_{libs,logic,client,device}.cmake  link_wraps.txt
    pkgs/{curl,gns,sentry}/*Config.cmake
  Include/
    web_prefix.h           force-included; includes extra/libs.h last
    web_wide.h             16-bit file reads and writes (section 10)
    windows.h d3d8*.h d3dx8*.h ddraw.h dinput.h mss.h io.h process.h ...
    extra/{libs,logic,client,device}.h   additions by parallel packages
    online_shims/          curl/, steam/, sentry.h, ws2ipdef.h ...
    casefix/               forwarding headers for wrong-case includes, always last in the search order
  Source/
    Main/    WebMain.cpp web_options.h WebGameEngine.{h,cpp} WebGameClient.cpp
    Win32/   WebRegistry.cpp and bodies for the windows.h shim (threads, files, time)
    FS/      web_fs_core.{h,cpp} WebLocalFileSystem.{h,cpp} WebPathWrap.cpp
    Device/  dx8wrapper_null.cpp
    Audio/   WebNullAudioManager.{h,cpp} audio_length.{h,cpp}
    Text/    WebWideFormat.cpp WebQuotedPrintable.cpp
    Online/  OnlineHeadlessStubs.cpp
    Stubs/   everything else the link needs
    Test/    WebTrace.cpp WebScenario.cpp WebSelfTest.cpp WebCoverage.cpp WebInject.cpp WebVariants.cpp WebStackProbe.cpp
             compiled only with WEB_TEST_API
  test/
tools/wasm/                build-report, check-flags, check-imports, check-undefined, check-shared-edits, check-fnptr-casts, ci-local
tools/replay-runner/       run, record, compare, rep, corpus, variants/, browser/, scenarios/, test/
```

**Starting point:** copy `Platform/MacOS/Include` from `okjid/okji/feat/macos-port` (40 files), change the guard to `__EMSCRIPTEN__`, and remove Apple parts (`mach-o`, `_NSGetExecutablePath`, objc, `MacOS*` hooks, `malloc.h`, `metal_prefix.h`, `MacOS*.h`). On wasm32 keep Win32's `long`-based `DWORD`, `ULONG` and `LONG`, so `bittype.h` stays untouched [R]. Add the empty stand-ins `PreRTS.h` asks for (`excpt.h`, `new.h`, `lmcons.h`, `objbase.h`, `ocidl.h`, `shlobj.h`, `shlguid.h`, `snmp.h`, `tchar.h`, `winerror.h`, `winreg.h`, `mapicode.h`).

**Stock tree, not OKJID's tree.** Its diff in Core and GeneralsMD is 631 files, +49,415/-3,932, with math rerouted across 70 GameLogic files and forced gameplay defines [R]. With the retargeted shim and no shared-file edits, 792 of 934 engine files pass a syntax-only compile [R]. Take an OKJID hunk only when a compile error asks for it, and never one that changes simulation behaviour. Examples to avoid: its `EMPUpdate.cpp` client-RNG change, `MAC_SYNC_FLAGS`, `skirmishSideOwnsTeams`, and any edit under GameLogic, WWMath or W3DModelDraw without separate reason.

`web_prefix.h` handles small name clashes without touching engine files: `#undef CLOCK_BOOTTIME` after `<time.h>` (`time_compat.h:31` would otherwise return garbage), `_stricmp`, an alias for `utc_clock`, and the `pause` clash at `InGamePopupMessage.cpp:81` [R].

**Entry point.** `WebMain.cpp` mirrors `WinMain.cpp:918-1042` (critical sections, `initMemoryManager`, `parseCommandLineForStartup`, `TheVersion`), using `MacOSMain.mm:150-212` as the Cocoa-free template. It defines `ApplicationHWnd` (null), `ApplicationHInstance`, `TheMessageTime`, `_Module` and `CreateGameEngine`, then calls `GameMain()` unchanged. `GameMain.cpp:54-56` already runs `-replay`, and `:61` calls the virtual `TheGameEngine->execute()` (`GameEngine.h:70`) otherwise. `WebGameEngine::execute()` handles the test paths through the option table below (`WebScenario`, quit after init), and calls the base class if none is active. No copy of `GameMain` to keep in step, and `GameMain.cpp` stays unedited.

**Web arguments.** `web_options.h` is a small table that any `Platform/Web/Source` file registers into at static-init time, so a package adds an option without editing `WebMain.cpp`. `-webAssets`, `-webUser` and `-webVersion` are always there, and every other option comes from `Source/Test/` under `WEB_TEST_API`. All `-web*` arguments are removed before the engine's `GetCommandLineA` shim builds its string (`CommandLine.cpp:1399-1405`). An unknown `-web*` argument fails at start.

## 5. What "null renderer" must keep running

**There is no device at all, and the real W3D object code still runs.** That is what native `-headless` already does, and every branch keys on `TheGlobalData->m_headless` or on the device being absent. A do-nothing `IDirect3DDevice8` would change the paths taken. So `-headless` is always passed, `_Get_D3D_Device8()` returns null, and `DX8Wrapper::Is_Initted()` returns false.

[S] `W3DDisplay::init` under `m_headless` skips scenes, `WW3D::Init`, the render device and the shader manager, but still calls `WWMath::Init` (`W3DDisplay.cpp:796`), installs `W3DFileSystem` (`:793`) and creates `W3DAssetManager` with load on demand (`:848-851`). `W3DDisplay::draw` returns at once (`:1856`).

**Must stay real, because the simulation reads it** [S, survey citations re-read in part]:

| Simulation need | Path |
|---|---|
| Pristine bones for docks, parking, exits, parachutes, drops | `Object.cpp:6161-6250` to `Drawable.cpp:754` to `W3DModelDraw.cpp:3397-3505`, then `animobj.cpp:774-796`, `htree.cpp:559-586` |
| Launch offsets, turret positions | `Weapon.cpp:3102` to `W3DModelDraw.cpp:3247-3394` |
| Barrel count | `Weapon.cpp:2731` to `W3DModelDraw.cpp:3685-3689` |
| Bridge extents from mesh vertices | `W3DBridgeBuffer.cpp:293-395`, then `TerrainLogic.cpp:2174,2234` |
| Terrain height, cliff, line of sight | `W3DTerrainLogic.cpp:97-343`, `BaseHeightMap.cpp:864,1015,1260`, `AIPathfind.cpp:4714`, `BuildAssistant.cpp:490` |
| Projectile curves | `DumbProjectileBehavior.cpp:443-452` to `BezierSegment.cpp` to `BezFwdIterator.cpp:60-67`, which calls `D3DXVec4Transform` |
| Command sets | `Object.cpp:6270`, `AIGroup.cpp:3270` through `TheControlBar` |

So `D3DXVec4Transform` must be real code in the shim (`d3dx8math.h`), and it's compiled strict like everything else. It needn't match `d3dx8.lib`.

**Keep in the source list, never executed under `-headless`:** `W3DWater`, the `Shadow` folder, `W3DRadar`, `W3DMouse`, `W3DGhostObject`, `W3DView`, `W3DTreeBuffer`, `W3DPropBuffer`, `W3DBibBuffer`, `W3DShroud`, `W3DParticleSys`, the `Gadget` folder, WW3D2's `dx8renderer`, `sortingrenderer`, `render2d`. They are referenced across the tree (`W3DTerrainVisual.cpp:216-240`) and P4 needs them. If one needs more than a short shim fix to compile, stub it and record that in the package's ledger.

**Replace or leave out:** `WinMain.cpp`, `VCRuntimeCheck.cpp`, `Win32Device/*`, `MilesAudioDevice/*`, `VideoDevice/Bink`, `VideoDevice/FFmpeg`, `dx8wrapper.cpp`, `dx8caps.cpp`, `dx8webbrowser.cpp`, `FramGrab.cpp`, `W3DWebBrowser.cpp`, GDI font raster in `render2dsentence.cpp`, `EABrowser*`, `MiniDumper`, `StackDump.cpp`, `WorkerProcess.cpp` (with a stub for the class, since `ReplaySimulation.cpp:138-219` references it), `core_debug`, `core_profile_legacy`, `StdLocalFileSystem.cpp` (replaced, section 8).

**`WWDownload` stays in the link.** `z_wwdownload` is linked at `GeneralsMD/Code/Libraries/Source/WWVegas/CMakeLists.txt:29`, and `DownloadManager.cpp:38` constructs a `CDownload`, whose vtable must exist. [V] `Download.cpp` and `urlBuilder.cpp` compile; `FTP.cpp:247` and its own `registry.cpp:27` don't yet. WP02 makes them compile with shim additions, or excludes them and records what needs a stub.

`dx8wrapper_null.cpp` follows the shape of OKJID's `Platform/MacOS/Source/Metal/dx8wrapper_metal.mm`: the 57 undefined `DX8Wrapper` members from the survey link [R], plus `DX8Wrapper_IsWindowed` and `DX8Wrapper_PreserveFPU`. P4 replaces this one file with the WebGPU version.

**Host inputs to pin:** `GameLODManager::init` calls `testMinimumRequirements` (`GameLOD.cpp:330,340`, defined at `W3DShaderManager.cpp:3089`), which may run a timing benchmark. On web it returns fixed values and never benchmarks.

Static LOD reaches logic by two routes [S]:

- `GameLogic.cpp:1966`, which `:1973-1976` overrides in multiplayer and skirmish, including replays.
- Draw modules. When `m_useDrawModuleLOD` is set, `Drawable.cpp:445-447` skips modules above the static level, and logic asks those modules for bones, whose pristine counts add up across modules (`Drawable.cpp:754-779`). The flag comes from `UseBuildupScaffolds` and from `Options.ini` (`GameLOD.cpp:398,622`). The graphical path applies a recommended level per machine and the headless path doesn't (`W3DDisplay.cpp:971-973`).

On current data this looks small: [R] all 180 gated modules need MEDIUM, none is the first draw module, and none lists weapon or turret bones. Bone names inside the scaffold W3D files weren't checked. Headless is unaffected, and the `@WGO` init line logs the level and the flag. **For P4:** either ignore `MinLODRequired` on web, or scan the scaffold models for public bones and record the result.

`CPUDetectClass`, `GetSystemInfo` and `GlobalMemoryStatus` shims return constants.

**Known null path.** Six of ten retail replays crashed the native client under `-headless` at `Core/GameEngine/Source/GameClient/RadiusDecal.cpp:80`, on `TheProjectedShadowManager->addDecal` (`docs/NATIVE_BASELINE.md`). The manager is set in `W3DShadow.cpp:118,126` and looks unset under `-headless`, though that hasn't been confirmed. Simulation code reaches this line through `ObjectCreationList.cpp:212`, `DeliverPayloadAIUpdate.cpp:260`, `DynamicShroudClearingRangeUpdate.cpp:146`, `NeutronMissileUpdate.cpp:199` and `RadiusDecalUpdate.cpp:55`. On wasm a null read doesn't fault, so this could misbehave without any crash. WP09 gives the web build a wrapped null check or a do-nothing manager. A null `m_decal` is already handled just below that line, and a decal is visual only. Treat it as the first example of the null-read risk in section 11, not as the only one.

## 6. Audio and video

**Audio.** `MilesAudioManagerDummy` keeps Miles open on purpose, because scripts need real file lengths for the CRC (`MilesAudioManager.h:352-358`). `ScriptEngine::isSpeechComplete` and `isAudioComplete` turn a length into a frame count (`ScriptEngine.cpp:7362-7366,7397-7401`, through `GameAudio.cpp:948-964`). So a zero length changes script timing.

`WebNullAudioManager` derives from `AudioManager`, not Miles:

- It implements the 42 pure virtuals (`GameAudio.h:148-315`) with the dummy's return values, and keeps `AudioManager::init` and the base `addAudioEvent` path so INI parsing and event bookkeeping are unchanged.
- `getFileLengthMS` opens the file through `TheFileSystem`, so it works from a BIG, and parses it with integer math only: WAV (PCM and IMA ADPCM) and MP3 frame walk. It lives in `audio_length.cpp` so P5's real manager calls the same function and never a browser-decoded duration.
- [D] Speech and sound archives checked hold only `.wav` (`SpeechZH.big` 12, `SpeechEnglishZH.big` 2,430, `AudioZH.big` 287). `MusicZH.big` holds 7 `.mp3`. Base archives under `ZH_Generals/` weren't checked.
- A file it can't parse counts as `audioUnknown` in the trace, and fails the run. Never returns a guess silently.
- Pending audio requests must not grow without bound when `TheAudio->UPDATE()` never runs: the replay loop only calls `TheGameLogic->UPDATE()`. Check `AudioManager::addAudioEvent`, and drain or drop requests.
- `isCurrentlyPlaying` returns false. Logic uses that answer only to decide whether to re-add a sound (`FiringTracker.cpp:161`, `TurretAI.cpp:792`, `JetAIUpdate.cpp:2670`), which touches audio state and the audio RNG, not logic state [S]. That alone doesn't make the audio RNG harmless: it can reach script timing, which section 11.2 fixes. With that fix, P5 can answer truthfully without a desync.
- It counts length queries, so the trace shows when a replay uses them.
- Don't pass `-noaudio`.

**Video.** `NullVideoPlayer` exists (`VideoPlayer.h:304-309`). Its base `init` still parses Video INI. `W3DGameClient.h:48,114-118` hard-codes Bink, so the header gets a wrapped guard, with `createVideoPlayer`, `createKeyboard` and `createMouse` moved to `WebGameClient.cpp` (as in OKJID's `MacOSGameClientFactory.cpp`). Video doesn't reach the simulation: `notifyOfCompletedVideo` calls are commented out (`ScriptEngine.cpp:7335-7345`) [R].

## 7. Online code

P2 has no network. The P2 build can't contact GO, and nothing here sends any identity.

**Why GO headers stay and GO `.cpp` files go.** Replay simulation calls only `TheGameLogic->UPDATE()` (`ReplaySimulation.cpp:88-111`). `NGMP_OnlineServicesManager::CreateInstance` has one caller, `MainMenuUtils.cpp:865`, so a native headless replay also has `GetInstance()==nullptr` and `TheNGMPGame==nullptr` [R]. A stub holding that same null state matches.

- Keep `NextGenMP_defines.h` and every simulation conditional unchanged.
- `Platform/Web/Include/online_shims` holds type-only headers: `curl/curl.h`, `curl/multi.h`, `sentry.h`, `steam/steamnetworkingcustomsignaling.h`, `steam/isteamnetworkingmessages.h`, `ws2ipdef.h` and whatever else compile errors name, including the `CURL_HTTP_VERSION_*` constants `GeneralsOnline_Settings.h` uses. Written by hand, as small as compile errors allow. If the GNS shim passes about 500 lines, stop and report, because fetching real headers may be better.
- `exclude_client.cmake` removes `Source/GameNetwork/GeneralsOnline/*.cpp` except `GeneralsOnline_Settings.cpp`, which is plain JSON and file code.
- WOL menus stay compiled, because `FunctionLexicon.cpp:64-292` references their callbacks, and `TheNGMPGame` is defined at `WOLGameSetupMenu.cpp:76`.
- `OnlineHeadlessStubs.cpp` defines what the headless path does call (`InitSentry`, `ShutdownSentry`, the Discord class, a stdout `NetworkLog`, `GameEngine.cpp:522,542,842-843`) and the static data (`Settings`, `m_pOnlineServicesManager`, `m_singletonMutex`, `g_MainThreadID`, `g_bAdvancedNetworkStats`, `m_ScreenshotMutex`, `m_vecGuardedSSData`). Add vtable or static symbols as the linker reports them.
- All other GO functions stay undefined under `-sERROR_ON_UNDEFINED_SYMBOLS=0`, so reaching one aborts with its name instead of changing behaviour [R]. Undefined data is still a link error [R]. [V] On a small program the abort also happens at `-O2` and `-O3` with `ASSERTIONS` off, through a function pointer and inside `catch(...)`, and an undefined vtable or data symbol is a link error. WP09 confirms the abort on the engine.
- `undefined_symbols_allowlist.txt` lists every allowed name. `tools/wasm/check-undefined.mjs` fails on any name outside it, so the flag can't hide a real porting gap.

`LANAPI.h:270`'s `static_assert` on packet size gets a wrapped guard, in WP01, because logic files include that header too. Web clients only talk to each other at P6, so wire compatibility with 2-byte clients isn't needed. P6 still must check packet sizes against the real limit.

**Later phases.** The identity is `client_id` `custom_third_party_client`, `anticheat_id` `-1`, no hardware ids (`docs/NETWORK.md`, `docs/DECISIONS.md`). OKJID's `GeneralsOnline/` changes (29 files, +1550/-160 [R]) are reference for P6, not for now.

## 8. Files

**Mounts.** The engine sees `/game` (read-only game data) and `/player` (writable user data), and its current directory is `/game`.

- **Node:** two WasmFS node-backend mounts, `/game` at `-webAssets <host path>` and `/player` at `-webUser <host path>`, a per-job folder.
- **Chrome:** one OPFS mount at `/opfs`. `WebPathWrap` maps `/game` to `/opfs/game` and `/player` to `/opfs/<web user folder>`, which is `player` unless `-webUser` names another. A test run uses a fresh `test-runs/<id>`, so `Options.ini` and other leftovers can't change its result (`GlobalData.cpp:1301-1316`, `ArchiveFileSystem.cpp:238-250`).

The OPFS backend can't mount a subfolder. `wasmfs_create_opfs_backend(void)` always opens the OPFS root (`wasmfs.h:91`, `opfs_backend.cpp:387-388`). [V] Mounting it at both `/game` and `/player` gives two views of the root: a file written as `/game/a` appears as `/player/a`, and a shell-installed file is at `/game/game/<path>`. [V] The single mount with path mapping works in Chrome 156 from a real OPFS layout: `stat`, `fopen`, `ifstream`, `mkdir`, `chdir` with a relative open, and `directory_iterator` on `/game`, `.` and `/player`, with no leak between them.

**Refuse a `Generals/` layout.** Base archives under a top-level `Generals/` folder would sort before `INIZH.big` and load in the wrong order (section 2). `web_fs_mount` aborts with a clear message if `/game/Generals` exists.

The registry shim and `WebRegistry.cpp` (replacing `GeneralsMD/Code/GameEngine/Source/Common/System/registry.cpp`, one of several files with that name) return `Language=english` and no `InstallPath`. `SHGetSpecialFolderPathW` returns `/player`, so user data keeps upstream's leaf name under it (`GlobalData.cpp:1113-1148`).

**`WebPathWrap.cpp`.** A link-time `--wrap` of the WasmFS path syscalls: `__syscall_openat`, `stat64`, `lstat64`, `newfstatat`, `mkdirat`, `unlinkat`, `rmdir`, `chdir`, `getcwd`, `faccessat`, `renameat`, and any other path-taking call in `wasmfs/syscalls.cpp`. `__syscall_openat` is really variadic, so its wrapper must be too, reading the mode only when `O_CREAT` is set [V]. It does five things:

1. Turns backslashes into slashes for every caller, including direct `fopen`, `ifstream`, `std::filesystem`, `mkdir` and `rename` calls from outside the file system classes (`UserPreferences.cpp:131,185`, `MapUtil.cpp:349`, `GlobalData.cpp:1145`, `DataChunk.cpp:244,264`, `XferLoad.cpp:83`, `XferSave.cpp:123`, `GeneralsOnline_Settings.cpp:101-131`). [V] on open and stat, in Node and Chrome. [R] for the others.
2. Maps `/game` and `/player` onto the OPFS mount in Chrome.
3. Resolves `/game` paths case-insensitively through one lower-case to real-path index built at startup. Don't use `wasmfs_create_icase_backend`: it lower-cases names before asking the real backend, so mixed-case stored names aren't found on a case-sensitive host (`ignore_case_backend.cpp:92-104`) [R].
4. Returns `EROFS` for writes under `/game`, so the engine can't write to game data.
5. Returns a clean current directory from `getcwd`. [V] Under the OPFS mount WasmFS returns `//game` after `chdir("/opfs/game")`, because it can't name the mount folder.

For writable `/player`, a per-component no-case walk with a small cache cleared on write. `fs::create_directories` with an all-backslash path fails [R], because `std::filesystem::path` only splits on `/`, so engine paths built that way need normalising first in `WebLocalFileSystem`.

**This laptop hides these bugs.** NTFS ignores case, and Windows accepts backslashes. So file tests run on the WasmFS memory backend, with no host help.

**`WebLocalFileSystem`** replaces `StdLocalFileSystem`, which doesn't compile on emcc (`StdLocalFileSystem.cpp:70,344`) and lists wrongly [R]:

| `StdLocalFileSystem` problem | Effect | Fix |
|---|---|---|
| `:243` matches extension only, case sensitive | `alpha.BIG` dropped; `*` and `*.*` wrong | Real no-case wildcard match |
| `:247` returns `/` paths with `./` prefix | `MapUtil.cpp:566-574` skips user maps; loose and archived names both kept; sort order changes (`FileSystem.h:66`, `INI.cpp:241-269`) | Return exactly `original + current + name` with backslashes, as `Win32LocalFileSystem.cpp:145-176` does |
| `:275` recurses with the leaf name only | Depth 2 and below skipped | Recurse with `current + name + backslash` |
| `:114` replaces the path on a write under a missing folder | File lands elsewhere | Create parents, then write |

Start from OKJID's `MacOSLocalFileSystem.mm`. Use the existing `StdBIGFile` and `StdBIGFileSystem`, whose first pass is what gives the order (`StdBIGFileSystem.cpp:59`). The archive layer already lower-cases every token (`ArchiveFileSystem.cpp:146-147,308-309`) [R].

**Community patch.** `ArchiveFileSystem::loadMods` loads `<UserData>GeneralsOnlineGameData/500_900_CommunityPatch_CoreINI.big` if present (`ArchiveFileSystem.cpp:236-255`). [D] It is not in the ingested data. So the web build runs retail INI plus the Steam `Patch*.big` set for now. All clients get the same data, so determinism isn't affected, but gameplay differs from live GO. See open questions.

**Exe CRC.** `GlobalData::generateExeCRC` opens `GetModuleFileName` (`GlobalData.cpp:1388-1392`). The shim returns a path that doesn't open, so the CRC covers the version and script files only. The replay check for it is a debug assert (`Recorder.cpp:1129-1175`). P6 must bind this to the build hash.

## 9. Changing shared engine files

Rules, from the brief section 3 and the merge goal:

1. Prefer in this order: a shim or stub in `Platform/Web`; a link-time wrap; a `web_prefix.h` macro; and only then a shared-file edit.
2. Every shared edit is the smallest possible and sits in `#if defined(__EMSCRIPTEN__)` or `#if !defined(__EMSCRIPTEN__)`, with a short comment on why. A file in `tools/wasm/shared_edit_exceptions.txt` is the only exception, and each entry says why. Today's expected entries are `CMakePresets.json` (one line), `Damage.h` (upstream's own commit, section 11.2) and `ParticleSys.h` (the `#if` line extended).
3. Never change simulation math. The frozen files are `wwmath.h`, `trig.h`, `Trig.cpp`, `vector3.h`, `matrix3d.h`, `quat.*`, `htree.*`, `hanim*` and `motchan*`, plus `NextGenMP_defines.h` and `GameDefines.h`.
4. PR #2670 changes 203 files. `tools/wasm/pr2670_files.txt` holds that list. An edit in one of them needs a reason in the ledger, and packages prefer a shim or exclusion there. A trial merge is an integrator step at the end of a phase.
5. Every edit gets a line in `Platform/Web/shared-edits/<WP>.md`: file, the `#if` block's comment, reason, what would remove it. Name the block rather than a line number, because line numbers go stale after a merge. WP18 folds the ledgers into one `Platform/Web/SHARED_EDITS.md` keyed by file.

**`tools/wasm/check-shared-edits.mjs`** exists from WP01, and every package's acceptance runs it. It does three things:

- Reads the base commit from the GO row in `UPSTREAM.md`, so a sync moves the base by editing one line.
- Fails if a frozen file differs from the base, or a changed file under `Core GeneralsMD Dependencies cmake CMakeLists.txt CMakePresets.json` has no ledger line. `--paths <prefix,...>` limits the ledger check to one package's area while other packages are mid-edit.
- For each changed file, strips the `__EMSCRIPTEN__` blocks (dropping the `#if` branch and keeping any `#else`, the other way round for `!defined`) and requires the result to equal the base blob. It works on raw bytes, because many of these files aren't UTF-8. This shows Windows source is unchanged, not just that a ledger line exists. It warns on an edit in a PR #2670 file.

**A native compile backs this up.** WP13 and WP18 run `cmake --build --preset win32-vcpkg` on the edited tree, since the check can't catch a broken guard and upstream CI is disabled here (`docs/DECISIONS.md`). [R] It took 2 min 43 s once configured (`docs/NATIVE_BUILD.md`).

**Expected edits.** Wide chars: section 10. Portability: `endian_compat.h:28,119` (`#error` otherwise; `XferCRC` needs it), `W3DGameClient.h`, `LANAPI.h:270`, plus what compile errors demand. Determinism: section 11.2. Hook: one line in `GameLogic.cpp`.

## 10. Wide characters

`WideChar` is `wchar_t` (`BaseType.h:36`), 4 bytes on wasm32 [V], and files hold 2-byte units. At 4 bytes these misread every replay header and map string [S, R].

OKJID's `__APPLE__` hunks show what has to change, and they are the reference. They add 269 lines to seven shared files, not counting `GameText.cpp` ([V] `git diff --stat`), and section 9 prefers shims. So this port does the same job with less in shared files:

| What | How | Shared edit |
|---|---|---|
| Wide `%s` means something else than on MSVC. `vswprintf` is called at `UnicodeString.cpp:426`, `LocalFile.cpp:440`, `widestring.cpp:253,287`, `wwstring.cpp:246,281` and `InGameUI.cpp:2393,2434,2466`; OKJID's hunk fixes only the first | One link-time wrap of `vswprintf` in `Platform/Web/Source/Text/` rewriting the format: `%s` to `%ls`, `%c` to `%lc`, `%S` and `%hs` to `%s`, `%C` to `%c`. [V] Correct for all forms through `vswprintf` and libc's `swprintf`, and `std::to_wstring` still works. A macro would clash with libc++'s `using ::vswprintf` [I] | None |
| `QuotedPrintable.cpp`, the slot list in the replay header. Its two Unicode functions walk bytes in pairs and stop after the first 4-byte character [S] | Link-time wraps of `UnicodeStringToQuotedPrintable` and `QuotedPrintableToUnicodeString`, with bodies from OKJID's hunks. A stale mangled name would silently leave the original in place, so `-webSelfTest` runs a round trip | None |
| `LocalFile.cpp`: `readWideChar`, `writeFormat`, `writeChar` | One helper header, `Platform/Web/Include/web_wide.h`, for 16-bit reads and writes, called from one-line wrapped blocks | Small |
| `RAMFile.cpp`: `readWideChar` | Same | Small |
| `Recorder.cpp`: header strings, `WIDECHAR` arguments (`:864`, `:1252-1260`, `:1534-1536`) | Same | Small |
| `DataChunk.cpp`: map strings (`:375`, `:988-989`). Not its `NativeFileSystem` edit | Same | Small |
| `GameText.cpp`: CSF strings (`:947`). OKJID's +557 is mostly unrelated | Same, 16-bit reads only | Small |
| `LanguageFilter.cpp`: `:163-172` | Same | Small |

WP08 reports its line count in shared files against OKJID's.

Left out for now: `XferSave.cpp`, `XferLoad.cpp` (saves are out of scope and web clients agree with each other), `NetPacketStructs.*` (P6). The logic CRC doesn't carry wide strings: `xferUnicodeString` in simulation is only in `Player::xfer`, not `crc` (`Player.cpp:4022,4366`) [S, R].

Replay `Bool`, `SYSTEMTIME` (16 bytes in the shim) and `replay_time_t` (`Recorder.cpp:68`) keep the Windows layout, so one parser reads both retail and wasm-recorded replays.

## 11. Determinism plan

### 11.1 What can differ between two machines running the same wasm file

| Source | How it's handled |
|---|---|
| **NaN sign and payload.** The wasm spec leaves them to the host. [V] x64 produces `0xFFC00000` from `0/0`. ARM produces `0x7FC00000` by default [I, architecture fact; `-webSelfTest` on the M4 confirms it]. | Guards at every bit read and hash (11.2), the NaN variant test and a forced-NaN run (11.3). |
| Relaxed SIMD | Not used. `check-flags` and a scan of the final wasm. |
| Host math | None. `libm` is musl compiled into the module. `check-imports` compares `WebAssembly.Module.imports` with an allow-list and rejects anything math-shaped. |
| Time, CPU count, memory, GPU, FPS | The simulation reads none of them for state [S: the `timeGetTime` at `GameLogic.cpp:1979,2099,2362,4870-4918` covers load progress and network timeouts; `QueryPerformanceCounter` in logic is profiling or behind a commented-out macro at `RailroadGuideAIUpdate.cpp:49,127`; `rand` isn't in GameLogic]. Static LOD pinned (section 5). Dynamic LOD neutral on this data (section 2). |
| Threads | The simulation runs on exactly one thread. `WebTrace` records the thread id at the first logic frame and compares it on every frame, and a change fails the run. It also wraps `pthread_create` and counts threads started during a replay, and that count is part of the pass rule. Expected: 0 in Node. The value in Chrome is measured in WP16, since the OPFS backend starts a worker of its own (`opfs_backend.cpp:20-26`), probably before the replay [I]. |
| Which player is local | Logic reads the local player in many places (`Object.cpp:1768-1791`, `PartitionManager.cpp:1295`, `SpecialPowerModule.cpp:554`, `StealthUpdate.cpp:1017`, `ScriptEngine.cpp:5864`), and clients in a match have different local players. No state leak is confirmed, but every replay plays from one slot. Tested with a variant (11.3). |
| A second match in one process | Bone caches and template pointers persist inside a process [R], and the runner uses one process per replay, so it never sees this. Tested with a variant (11.3). Until that's measured, later phases reload the page between matches. |
| V8 native stack limit, which differs by CPU and tier [I] | Recursion past it is a `RangeError`, so loud, not silent, but one client failing still splits a match. WP16 measures the margin on x64 and the checklist measures it on the M4 (section 13.4). |
| `memory.grow` failing on a small host | `malloc` returns null, the engine throws (`GameMemory.cpp:234-237`), and the run fails with reason `oom`. Loud, with one known exception on a simulation path: `TerrainLogic.cpp:1267,1280-1283` eats any exception while reading waypoints and carries on without them. WP13 makes that site rethrow out-of-memory. |
| Game data | Same manifest. The Chrome page requires the installed manifest to equal the served one, and the shell verified every file's SHA-256 when it installed it (`web/src/download/worker.ts:1-9`). Both harnesses can also rehash every file on demand. `iniCRC` covers INI text only, so a bad W3D or map of the right size is only caught by that rehash. `iniCRC` and the BIG list go in the trace. |
| User data | Node starts from an empty job folder. The Chrome page uses a fresh, empty OPFS folder per run (section 8) and records that it was empty. |
| Uninitialised memory, pointer values, allocator order | Same bytes and same history give the same result, but a client's different call history (rendering, UI) changes stack contents, addresses and free-list order. Tested with variants (11.3). |

Survey findings cleared in source and not re-tested: `hash_map` is only looked up in simulation, with iteration in save paths and audio; pointer-keyed maps use find, dump or order-independent sums; no thread creation in logic directories [R].

### 11.2 Required code changes

**NaN guards.** [V] This is a real leak, not theory. `fast_float_trunc` (`BaseType.h:186`) clears the mantissa of NaN, leaving `+inf` or `-inf` according to NaN's sign. `lroundf` in the prebuilt libc saturates regardless of our flags: `lroundf(inf)=2147483647`, `lroundf(-inf)=-2147483648`. So `REAL_TO_INT_FLOOR(NaN)` is `INT_MIN` on x64 and `INT_MAX` on ARM. `fast_float_floor` and `fast_float_ceil` read the sign bit too, but only to choose an adjustment, and pass NaN on into the guarded `fast_float_trunc` [S].

| Site | Change |
|---|---|
| `BaseType.h` `fast_float_trunc` | Under `__EMSCRIPTEN__`, `if (f != f) return f;`. Don't return a NaN literal: [V] `wasm-opt --denan` rewrites a literal to its helper's constant, so the polarity builds would no longer match the normal one. The sign of the returned NaN doesn't matter, because every later read is guarded |
| `BaseType.h:162` `fast_float2long_round` | Under `__EMSCRIPTEN__`, return 0 for NaN, infinities and values that don't fit, so the result can't depend on sign. Also the value Windows' runtime gives (`docs/DETERMINISM.md` 3.4) |
| `XferCRC.h`, `XferCRC.cpp` | Under `__EMSCRIPTEN__`, override `xferReal` (`Xfer.h:151`). Test for NaN on the raw bits with no float load, hash the integer pattern `0x7FC00000` and count it. `xferCoord3D`, `xferRealRange` and similar already go through `xferReal` (`Xfer.cpp:210-217,292-298`) |
| `Object.cpp:4025,4078,4097` | Raw `xferUser` of `Matrix3D`, `health`, `scalar`. Under `__EMSCRIPTEN__`, call `xferReal` per float, same order and same bytes |
| Audit | Grep simulation and `WWMath`, `WW3D2` code for other bit reads: `*(int *)&`, `reinterpret_cast`, unions, `memcpy` with floats. Known others: `Fast_Is_Float_Positive` (`wwmath.h`, used in `colmathplane.h:68-80`), `Float_To_Int_*` (`HeightMap.cpp:254`, client shading), `Float_As_Int` (`wwmath.h:156`). `WWMath::Fabs` (`wwmath.h:102`) clears the sign and doesn't leak. Don't edit `wwmath.h` unless the audit or NaN test shows a simulation path; report it first |

The non-empty `crc` functions that hash floats, from a script over the tree: `Player.cpp:4022`, `AI.cpp:972`, `AIGroup.cpp:3322`, `AIPathfind.cpp:11315`, and `Object.cpp:3998`; all but `Object.cpp` use `xferReal` [V]. `Weapon.cpp:3292` was checked by the same script and hashes no float through `xferUser` or `xferReal`.

**Test-only counters.** Under `WEB_TEST_API`, the guards count how often a NaN reaches them. The trace reports these with `nanHashed`. Without them, a run where no NaN ever reached a guard looks exactly like a pass. The known real NaN path ends in a plain cast (`SlowDeathBehavior.cpp:182-185`: 0/0 goes to an `Int`, then a `max`), so it touches neither the hash nor the guards. A run where every counter is 0 reports "NaN path not exercised" for that risk rather than a pass.

**UB that clang acts on.** `getDeathTypeFlag` and its siblings shift by `dt-1` with `DEATH_NORMAL` 0 (`Damage.h:241-251`). x86 masks the count. At wasm `-O3` a constant `dt` gave 0 where x86 gives bit 31 [R].

- `Damage.h`: TheSuperHackers fixed this in `fed53656f` (`1UL << dt`, plus a `static_assert`), on `tsh/main` and not yet in this tree. Apply exactly that change, unwrapped, so a later merge absorbs it. [S] It moves the flag bits, and that's safe because `m_deathTypes` and the other flags are only built and read through these helpers plus the all-ones and zero constants (`INI.cpp:1914-1943`, `DieModule.cpp:46,69`). WP13 re-checks that before applying it.
- `GameCommon.h:293-303`, the veterancy flags: upstream hasn't touched it (`tsh/main` still has `dt - 1`). A wrapped `& 31` keeps x86's result.

Run one UBSan build (`-fsanitize=shift,float-cast-overflow`) over a replay, and treat each hit in simulation as a bug to look at.

**Audio randomness reaching script timing.** `isSpeechComplete` and `isAudioComplete` build an event that isn't marked logical (`ScriptEngine.cpp:7361-7363,7396-7398`, unlike `ScriptActions.cpp:348,365,2803,2817`). `getAudioLengthMS` then picks a file with the audio RNG (`GameAudio.cpp:958-961`, `AudioEventRTS.cpp:339-348,390-393,408-411`). The picked file's length becomes a stored completion frame that a script condition reads. Audio RNG draws differ between clients, because `addAudioEvent` returns before drawing for a sound not meant for the local player (`GameAudio.cpp:435-447`). So two clients in one match can pick files of different lengths. [R] 823 of 3,979 audio events in `INIZH.big` have `Control` random with more than one sound. Speech is streaming and returns before the pick (`AudioEventRTS.cpp:327-330`). A headless replay can't show this, since it plays from one local player. Which map scripts use these conditions wasn't checked.

Fix, wrapped, at both sites: `event.setIsLogicalAudio(true)`, which picks with `GameLogicRandomValueUnchanged` and doesn't move the seed. `WebNullAudioManager` counts length queries, so the trace shows whether a replay used them.

**Function-pointer casts.** A cast to another signature compiles and then traps at `call_indirect`. [V] A file-by-file scan with `-Wcast-function-type-strict` found 41 distinct sites in the 794 files that compile, so this is a lower bound. Most are `FARPROC` casts behind a null `GetProcAddress` result or GameSpy callbacks, not reached in P2 [I]. One is simulation code on a path AI replays may never reach: `ScriptActions.cpp:5091,5115` casts a function returning `void*` to `ContainIterateFunc`, which returns `void`. [V] The same cast with the planned flags traps. So WP10 fixes that one with a wrapped adapter, and `tools/wasm/check-fnptr-casts.mjs` keeps the scan and a reviewed list as a standing check. Never use `-sEMULATE_FUNCTION_POINTER_CASTS`.

**Headless parity with graphical play.** A web replay recorded in a live match must replay headless. Two sites in GO's code break that today [S]:

- `SpectreGunshipUpdate.cpp:618` gates gattling logic on a particle template. With `RETAIL_COMPATIBLE_CRC` 0, `ParticleSystemManagerDummy::init` is empty (`ParticleSys.h:850-859`), so `INI::parseParticleSystemTemplate` stores null (`INI.cpp:1302-1312`) and the logic is skipped in headless. The fix upstream is 50f27e057, not in this tree.
- `EMPUpdate.cpp:347` draws `GameLogicRandomValue` inside `if (sys)`. In headless `sys` is null, so the seed doesn't advance.

Fix, wrapped: extend the `#if RETAIL_COMPATIBLE_CRC` at `ParticleSys.h:766` and `:850` to also take that branch under `__EMSCRIPTEN__`, so the dummy loads templates and returns null. In `EMPUpdate.cpp`, under `__EMSCRIPTEN__`, draw the same value when `tmp` is set and `sys` is null. `createParticleSystem` returns null only for a null template (`ParticleSys.cpp:3117`), so the extra draw happens only in the dummy case. This changes CRC values for replays with those units compared with an unfixed build, so do it before the test corpus. Test-only counters at both sites show the fixed code actually ran.

**Other known headless and graphical differences, for P4 to test** [S]. First check for P4: `-VerifyClientCRC` (`CommandLine.cpp:1246`, `CRCDebug.cpp:53-85`) shows whether client update changes the logic CRC.

- `ViewDummy::isCameraMovementFinished` (`View.h:403-435`, `ScriptConditions.cpp:2753`).
- `getWaterGridHeight` without a water object (`W3DTerrainVisual.cpp:876-886`, `TerrainLogic.cpp:1134-1138`).
- `getBarrelCount` following `m_curState` (`W3DModelDraw.cpp:2059-2069`).
- A script condition reads the local UI selection (`ScriptConditions.cpp:1406-1415`).
- Whether a frame runs at all depends on the camera outside network games (`GameEngine.cpp:377-390`, `GameLogic.cpp:3985-3988`). So a skirmish recorded in a graphical client can differ from headless playback, and a network match replayed with `TheNetwork` null honours script time freezes that the live match ignored.
- Static LOD choosing draw modules (section 5).

P4 adds a test that plays the same replay graphical and headless and compares streams.

**Other wasm traps to expect, all loud:** integer divide by zero. Native access violations don't trap on wasm: a null read returns a value, so a bug that crashes on Windows may run on silently [R]. Keep the engine's null checks.

### 11.3 Tests that run on this machine

All compare per-frame CRC streams on the same replays. A difference is a bug to find unless the table says otherwise.

| Test | Build change | What it says |
|---|---|---|
| Round trip | None | Recording against playback |
| Re-record | None; record the same scenario twice | Anything non-repeatable |
| Trace off | Play without `-webTrace`, using the engine's own compare against CRCs recorded with the hook on. In WP12, before the corpus exists | `getCRC` having side effects. Expected none: it allocates (`GameLogic.cpp:4391-4510`) and that's why this is tested |
| **NaN polarity** | `wasm-opt --denan`, then patch the helper's constant. P and N must match | NaN bits reaching state, without ARM hardware |
| NaN polarity, Z | Same, constant 0 | **Information only.** Z is expected to differ when the 0/0 death path runs, because NaN becomes 0 before the cast. A difference shows NaNs flow, not a fault |
| Forced NaN | `-webInjectNaN` sets a float to NaN at a chosen frame, in a form that reaches the hash and in one that reaches the guards. P must equal N, and the M4 must equal x64 | That the guards work, on a run where counters prove they ran |
| Allocator | `-sMALLOC=emmalloc` | Absolute addresses and large blocks. It does **not** change object order: global `new` goes to the engine's pools, and blocks come from each pool's own free list inside a blob (`GameMemory.cpp:1188-1207,1254-1259,2184,3274-3279`) |
| High pointers | `-sGLOBAL_BASE=2GB -sINITIAL_MEMORY=2200MB` | Signed-pointer bugs and pointer values [R: ran on a small probe] |
| Pool churn | `-webChurn <seed>`: test code allocates and frees from the dynamic allocator and named pools each frame in a seeded pattern, with its own generator | Free-list order, the thing a rendering client really changes |
| Stack fill | `-ftrivial-auto-var-init=pattern` | Uninitialised stack reads reaching simulation. Heap is zero-filled by the engine's allocators while `RTS_GAMEMEMORY_ENABLE` stays on (`GameMemory.cpp:1703-1704,2277-2278,3279`) [R, re-read] |
| Local slot | Rewrite the replay header's slot digit (`Recorder.cpp:945-958`) and compare streams. The engine's own compare may report nothing, because it only compares the header's player (`Recorder.cpp:1022-1031`) | Logic depending on the local player |
| Second match | One process plays A then B, through the list `ReplaySimulation.cpp:52` already takes, against B alone. **Information only:** decides whether later phases must reload between matches | State surviving between matches |
| Release | `emscripten-release`, whole corpus, engine's own compare only | The build that ships |
| `-O2` against `-O3` | The daily build's stream against the test build's. **Information only** | UB that optimisation exposes |
| UBSan | `-fsanitize=shift,float-cast-overflow`; lists hits, isn't compared | Section 11.2 |
| Chrome x64 | None, at least twice per replay. The OPFS worker may change heap interleaving between runs [I] | Node against browser; OPFS against the node backend |

**NaN polarity method.** [V, on a threaded, exception-using module with the planned link line] `wasm-opt generals.wasm --denan` makes every float result pass through helpers `deNan32` and `deNan64`, whose bodies are `if (x==x) x else const 0`. Patching those constants in the binary gives three builds from one input:

- body bytes for f32: `20 00 20 00 5B 04 7D 20 00 05 43 00 00 00 00 0B 0B`, constant at offset 11
- body bytes for f64: `20 00 20 00 61 04 7C 20 00 05 44 00*8 0B 0B`, constant at offset 11
- variant P uses `7FC00000`, variant N uses `FFC00000` and `FFF8000000000000`, variant Z keeps 0

Use explicit features, not `--all-features`: [V] that option wrote a module V8 rejected ("unknown import kind"). Working list: `--enable-threads --enable-bulk-memory --enable-bulk-memory-opt --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals --enable-exception-handling --enable-simd --enable-multivalue --enable-reference-types --enable-call-indirect-overlong`.

P equal to N is close to what ARM64 would do, but not proof. [V] Float loads collapse a NaN to the helper's polarity, while raw bits read with no float load keep their sign. So a both-signs case in `-webSelfTest` only tests both signs in the default build, on x64 and on the M4, and in P and N it exercises one.

### 11.4 What can't be verified here

| Item | Who | How |
|---|---|---|
| Identical streams on ARM64 | Owner on the M4 | `docs/TESTING_MAC.md`, written by WP16. Self test first, then replays. Result: JSON report and stream file, filed as a GitHub issue |
| ARM's NaN bits, which section 11.1 infers | Owner on the M4 | `-webSelfTest`: seconds, no game data, prints raw bits |
| Identical streams on AMD x64 | Owner, if an AMD machine is available | Same page |
| OPFS on macOS Chrome | Owner | Same run |
| Stack margin on the M4 | Owner | Same page |
| The release wasm on the M4 | P3, once the client ships it | The same replay check |
| Graphical play against headless | P4 | Section 11.2 |
| Linux host with the node backend | Partly CI, without game data | CI runs file tests on the memory backend and builds on a case-sensitive file system |

This laptop's CPU is an Intel i5-12450H [R]. Wasm semantics make an Intel and AMD difference very unlikely [I], and it remains unmeasured.

### 11.5 Finding a divergence

The normal test wasm can do this with no rebuild, so the bytes examined are the bytes that failed, and it works across machines. A rebuild could move or hide a difference that depends on stack or heap contents, since those depend on call history [I].

1. `node tools/replay-runner/compare.mjs a.json b.json` reads both reports' stream files and prints the first differing frame F. It refuses different wasm SHA-256 unless given `--allow-different-wasm`.
2. Rerun both sides with `-webDumpFrames F-1 F` (on another machine, through the test page). For each frame this prints the seed, the CRC after each section (objects, partition manager, player list, AI), and per object its id, template, CRC and every hashed value as hex, from a subclass of `XferCRC`. It follows `getCRC`'s order (`GameLogic.cpp:4391-4510`). Run with the same arguments otherwise.
3. `node tools/replay-runner/compare.mjs --dump a.dump b.dump` prints the first differing section, object and value.
4. A moved seed means the RNG stream changed. The dump can't say which call moved it, and that's when step 5 is needed.

**5. The CRC log build, only if the dump isn't enough.** `RTS_DEBUG_LOGGING=ON` turns on `DEBUG_CRC` (`CRCDebug.h:33-35`), with mid-frame logs and `DEBUG_RANDOM_LOGIC` (`RandomValue.cpp:44`) naming each RNG call by file and line. Run with `-ignoreAsserts -DebugCRCFromFrame F-1 -DebugCRCUntilFrame F+1 -LogObjectCRCs -SaveDebugCRCPerFrame /player/crc` (`CommandLine.cpp:1222-1259`). The path must be absolute, because a relative one lands under read-only `/game` and `CRCDebug.cpp:148,155` then returns silently. **It doesn't compile today, and no package makes it compile until a divergence needs it** ([V] census with `-DDEBUG_LOGGING=1`). The known gaps are `__int64` at `Debug.h:226-228`, `LARGE_INTEGER` at `ScriptEngine.cpp` and `AIPathfind.cpp:6052-6058`, `_finite`, `WSAGetLastError`, `DebugBreak` and `MB_*` at `Debug.cpp`, and `CreateDirectory` and `DeleteFile` at `CRCDebug.cpp:123,133`.

Limit: the CRC covers selected fields, so hidden state can diverge frames earlier. Avoid `XferDeepCRC` as a first tool: it uses save mode, so `hash_map` iteration order shows false differences [R].

**The tool is shown to work by fault injection.** `-webPerturb <frame>:<object>` flips one bit of one float in one object's transform at frame N. `compare.mjs` must name frame N or the next one, and that object. Comparing two different seeds proves nothing, because the seed is hashed and they differ from the first CRC (`GameLogic.cpp:4445-4458`).

## 12. Test replays with no renderer

An AI skirmish recorded headless in wasm. No shipped replay can serve: retail can't pass, and native recordings aren't the target.

**Why this should work** [S; not run]:

- Skirmish records: `Recorder::updateRecord` starts on `MSG_NEW_GAME` for `GAME_SKIRMISH` (`Recorder.cpp:474-492`) and stops on `MSG_CLEAR_GAME_DATA` (`:494-500`). `GAME_SINGLE_PLAYER` is not recorded, so `-file map.map` can't help (`GameEngine.cpp:796-799`).
- Skirmish emits CRCs: `isMultiplayer()` is true when `TheSkirmishGameInfo` exists (`Recorder.cpp:1714-1737`), so `GameLogic.cpp:3996-4024` generates on `m_frame % TheGameInfo->getCRCInterval() == 0`. `MSG_LOGIC_CRC` is a network message, so it's written (`Recorder.cpp:503-508`). On playback `isMultiplayer()` is true because slots are occupied, and `CRCInfo` doesn't skip the first value (`:1198-1199`, `:113-118`).
- Local index is 0 in skirmish (`Recorder.cpp:633-636`), so slot 0 is the compared player.
- Message translators attach in headless too (`GameClient.cpp:305-323`), and only the keyboard is behind `m_headless` (`:278`). So `TheMessageStream->propagateMessages()` (`MessageStream.cpp:1089`) carries CRC messages to `TheCommandList`.

**`WebScenario`** in `Platform/Web/Source/Test/`. It follows `SkirmishGameOptionsMenu.cpp:419-451,1295-1339`:

```
TheSkirmishGameInfo = NEW SkirmishGameInfo;
init(); clearSlotList(); reset(); setLocalIP(...); enterGame();
slot 0: SLOT_PLAYER, PLAYERTEMPLATE_OBSERVER (or a faction, for the idle-human form)
other slots: SLOT_BRUTAL_AI / SLOT_MED_AI / SLOT_EASY_AI, template, team, start position, color
setMap(lower-case map path); setMapCRC/setMapSize from TheMapCache->findMap(...);
setSeed(scenario.seed); startGame(0);
TheWritableGlobalData->m_mapName = map; InitRandom(seed);
TheMessageStream: MSG_NEW_GAME(GAME_SKIRMISH, DIFFICULTY_NORMAL, 0, maxFPS)
while (frame < N) { TheMessageStream->propagateMessages(); TheGameLogic->UPDATE(); }
TheMessageStream: MSG_CLEAR_GAME_DATA; propagateMessages(); TheGameLogic->UPDATE();
```

Read the seed from the scenario, never `GetTickCount` (the menu does at `:1339`).

**One shared edit needed:** `GameLogic.cpp:1442` skips the load screen only in simulation playback. In record mode it would build one against the dummy window manager. Under `__EMSCRIPTEN__`, also skip it when `TheGlobalData->m_headless`. Later `m_loadScreen` uses are already guarded (`:1465`, `:2375`, `:2392`).

**The loop is the same as replay simulation:** logic only, no `TheGameClient->UPDATE()`. That makes recording and playback use the same paths. It also means client-to-logic leaks aren't exercised until P4.

**Scenario files** in `tools/replay-runner/scenarios/*.json`: map, seed, slots, frames, optional `bot`. **Output** goes outside the repo, to `<replays>` (WP12 creates it), as `<scenario>.rep`, `<scenario>.stream.json` and the stream file.

**Coverage target:** every faction and general template in `PlayerTemplate.ini`; at least 3 maps including an 8-player map from `MapsZH.big`; at least one match of 108,000 logic frames (30 game minutes at 60 Hz); superweapons, Spectre and EMP actually seen. `WebCoverage` walks the object list every 30 frames, read-only, and reports the set of template names, so the claim is measured. Seeing a template doesn't show that the risky code ran, so the report also gives the counters at the patched EMP and Spectre sites, the NaN guard hits and the audio length queries. Time per frame is unmeasured, so adjust lengths once known and record what was used.

**Command bot.** AI-only replays hold almost no player commands, so `logicMessageDispatcher` paths aren't exercised, and the cross-machine result would cover only part of the simulation. An optional `bot` block in the scenario gives an idle-human slot a seeded list of commands, appended to `TheMessageStream` during recording only: train a unit, build a structure, move, attack, use a special power, sell. It picks targets by template from the bot's own objects, with its own generator, so it draws no logic RNG. Playback reads them from the replay like any other. It's a partial cover: live recordings from P4 on are still needed.

A native recording can't enter this set: other compiler, other math. It may help debug behaviour by eye, not by CRC.

## 13. The runner

### 13.1 Trace

One hook in shared code, placed just before `isMPGameOrReplay` at `GameLogic.cpp:3996`, so it sees the same state the game hashes:

```cpp
#if defined(__EMSCRIPTEN__) && defined(WEB_TEST_API)
	if (g_webLogicFrameHook) g_webLogicFrameHook(m_frame);
#endif
```

`g_webLogicFrameHook` is a null function pointer defined in `Platform/Web/Source/Test`. `WebTrace.cpp` sets it when `-webTrace` or another observer is active.

**The callback ignores `GAME_NONE` and `GAME_SHELL`,** the same gate as `isMPGameOrReplay`. [S] The first update of a game runs with mode `GAME_NONE` and frame 0 (`GameLogic.cpp:288,3996-4000`), the mode is then set and `m_frame` stays 0 because `m_startNewGame` is true (`:1292-1316,4178-4181`), and the second update starts the game and hashes frame 0 (`:3940`). Without the gate there are two `c 0` lines for one CRC, and every playback is off by one.

The callback calls `getCRC(CRC_RECALC)` and prints. It doesn't touch `m_CRC`. It's expected to only read, and the trace-off test in WP12 checks that (`getCRC` allocates, `:4391-4510`). It also compares `pthread_self()` with the value from the first logic frame, and fails the run on a change. Other test code (coverage, dumps, injection, churn) registers as an observer of this callback, so no package needs to edit `WebTrace.cpp` to add one.

Lines go to stdout, flushed:

```
@WGO {"t":"init","iniCRC":"FEAAE3F3","exeCRC":"...","wasm":"<build id>","bigs":["AudioEnglishZH.big","..."],"lod":{"staticLevel":"...","useDrawModuleLOD":false,"debrisSkipMask":0,"slowDeathScale":1}}
@WGO c 1234 0ABCDEF0
@WGO {"t":"end","frame":36000,"mismatch":false,"heapMB":812,"threads":0,"sameThread":true,"nanHashed":0,"nanGuards":0,"audioUnknown":0,"audioLenQueries":0,"sites":{"empDraw":0,"spectreGate":0}}
```

**Stream hash:** SHA-256 of the UTF-8 text with one `<frame> <crc-hex>\n` per `c` line.

**Stream file.** The runner saves that text, gzipped, beside each report and each `<scenario>.stream.json`. The JSON holds only the hash. `compare.mjs` needs the full stream to name a first differing frame, and 36,000 lines at about 15 bytes is about 540 KB, too large for an issue body. The test page offers the same file, and the M4 steps say to attach it.

`iniCRC` first gate: `VANILLA_INI_CRC` is `4272612339`, 0xFEAAE3F3 (`NextGenMP_defines.h:41`), the value in 9 of 10 retail ZH replay headers (`docs/DETERMINISM.md` section 5). It hashes INI text in load order, so a match says BIG order, shadowing, listing and the line reader are right, with no native build and no float math. A difference isn't automatically wrong, since Steam's `Patch*.big` set might change it: [D] `PatchINI.big` holds only `WindowTransitions.ini`. If a native build exists under `build/`, compare with it to decide.

### 13.2 Node runner

`tools/replay-runner/run.mjs --engine <dir> --assets <assets> --replay <file or dir> [--match <regex on file name>] [--maps <dir>] [--reference <report or .stream.json>] [--no-trace] [--extra-args "<engine args>"] [--verify-data] [--out report.json] [--jobs N] [--timeout-min M] [--expect pass|mismatch] [--require-game-data]`

For each replay:

1. Parse it with `rep.mjs`, no engine. Layout: `docs/DETERMINISM.md` section 5.
2. Make a temporary job folder. Stage the replay as `job.rep` under the user `Replays` folder, because `-replay` names are relative to it and awkward names are a problem (`Recorder.cpp:1585-1600`, `CommandLine.cpp:1399-1405`). Stage any `userdata/maps/...` map under the user `Maps` folder.
3. Spawn one Node process with `generals.js -webAssets <assets> -webUser <job> -webTrace -headless -replay job.rep`. One process per replay, because bone caches and template pointers persist inside a process [R], and a hung wasm blocks its event loop, so only a separate process can be timed out [R].
4. Collect trace lines, exit code and a stderr tail. Host paths are redacted. Kill at the timeout. Trace lines the runner doesn't know are kept under `extra` in the report, so test code can add a line without changing the runner.
5. Delete the job folder unless it failed.

`--verify-data` hashes every manifest file once and records the result, with a marker file in the temp folder keyed by manifest version so later runs skip it. Without it, sizes are checked.

Never mount the game folder writable. Never print `GAME_DIR`.

### 13.3 Pass rule and report

**`pass` needs all of:** exit 0; no `CRC Mismatch in Frame` line; `compared > 0` (the native check passes silently with no records, `docs/DETERMINISM.md` section 5); final frame at or past the header's `frameCount`; `audioUnknown` 0; `sameThread` true; `threads` equal to the host's expected value (0 in Node); `iniCRC` equal to the header; and if `--reference` is given, the same stream hash. A `--reference` is either a report or a `.stream.json`, which holds `wasmSha256`, `frameCount` and `streamSha256`.

With `--no-trace` there is no stream, so the rule is exit 0 and no mismatch line.

**Independent compare.** The runner reads recorded `MSG_LOGIC_CRC` values from the replay itself, and checks them in order against `c` lines at `frame % C == 0`. So a mistake in the engine's own compare can't hide a mismatch. It mirrors the engine in two ways: `CRCInfo` drops the first local CRC when the original game mode is `GAME_INTERNET` or `GAME_LAN` (`Recorder.cpp:113-135,1198-1199`), and only the header's player's records count (`:1022-1031`). A skirmish recording has no drop.

**Status values:** `pass`, `mismatch`, `dataMismatch` (INI CRC differs from the header, so it's not a simulation failure), `fail` and `notRun`. A `fail` carries a `reason`: `crash`, `oom`, `hang`, `incomplete`, `noComparisons`, `cannotOpen`, `threadChanged` or free text. A replay with `dataMismatch` still runs and still reports `firstMismatch`, and `--expect mismatch` accepts either status with a `firstMismatch` frame, because the retail control may legitimately have a different `iniCRC`.

```json
{ "schema": 1, "startedAt": "...",
  "engine": { "wasmSha256": "...", "emcc": "6.0.13", "preset": "emscripten-headless-opt" },
  "node": "24.20.0",
  "gameData": { "present": true, "manifestVersion": "db5b548edb4f0d6b", "verified": false, "userFolderEmpty": true },
  "summary": { "total": 1, "pass": 1, "mismatch": 0, "dataMismatch": 0, "fail": 0, "notRun": 0 },
  "replays": [ { "file": "obs-7brutal-a.rep", "sha256": "...", "header": { "version": "...", "exeCRC": "...", "iniCRC": "...", "frameCount": 36000, "crcInterval": 100, "localPlayer": 0, "map": "..." },
    "status": "pass", "reason": null, "exit": { "code": 0, "signal": null }, "frames": { "final": 36000, "expected": 36000 },
    "crc": { "compared": 360, "firstMismatch": null, "streamSha256": "...", "streamFile": "obs-7brutal-a.stream.txt.gz", "frames": 36000 },
    "nan": { "hashed": 0, "guards": 0 }, "audio": { "unknown": 0, "lenQueries": 0 }, "threads": 0, "sameThread": true, "extra": {}, "heapMB": 812, "ms": 0, "stderrTail": [] } ] }
```

Exit codes: 0 when all runnable replays meet `--expect`; 1 on any failure; 2 on a runner or setup fault. `notRun` only fails with `--require-game-data`.

### 13.4 Chrome harness

The shell installs the game data, and the test page never downloads it. `web/src/download/worker.ts:1-9` already resumes, verifies SHA-256 and writes `/game/manifest.json` last, and this gives the shell its first real end-to-end run. `tools/replay-runner/browser/replay-test.html` and `.js` sit in the relay's `--engine-dir` under `/engine/test/`, next to the test build's `generals.js`, with replays at `/engine/test/replays/`. So they get the session cookie and the COOP, COEP and CORP headers with no relay or `web/` change (`docs/WEB_CONTRACT.md`). Nothing is at `/engine/generals.js`, so the shell stops at its normal "engine build not available" state instead of starting the test build with no arguments.

The page:

1. Offers **Self test** first, which needs no game data: runs `-webSelfTest` and shows the output, with the lines that must match x64 marked. This takes seconds, and it's the only direct test of the inference that ARM gives `7FC00000`.
2. Otherwise refuses to run unless OPFS `/game/manifest.json` equals `/assets/manifest.json`. **Verify data** rehashes every file with SHA-256 and records the result in the report. The owner's second stage uses it.
3. Makes a fresh OPFS folder `test-runs/<id>`, starts the engine with `Module.arguments` set to the runner's with `-webUser test-runs/<id>`, collects `@WGO` lines through `Module.print`, and runs one replay. Reload per replay. Removes the folder afterwards.
4. Shows the wasm SHA-256, replay name, final frame, compared count, status, stream hash, browser and platform, with buttons to download the JSON report and the stream file. The report's parsing is shared with `run.mjs`.
5. Second stage, for a mismatch: takes a frame range, reruns with `-webDumpFrames` and offers the dump as a download.
6. **Stack margin:** runs `-webStackProbe`, which recurses in a fixed-size frame until a `RangeError` and prints the depth reached. On x64, WP16 also reruns the smoke replay with Chrome's `--js-flags=--stack-size=<half the default>`, to see how much margin a real game has. If the flag doesn't reach workers, it says so.

[V] Chrome 156 ran the planned link line against OPFS from `http://127.0.0.1`. The LAN path needs HTTPS through mkcert: `docs/MAC_TEST_SETUP.md`, which WP16 writes (brief section 4.6).

## 14. CI

New workflow `.github/workflows/wasm-headless.yml` on Ubuntu with Node 24. Emsdk pinned at 6.0.13, cached. Checkout with submodules and `fetch-depth: 0`. No game data anywhere. The workflow has two steps: build, then `node tools/wasm/ci-local.mjs --dir <build>`, so the step list exists in one place.

| Step | Checks |
|---|---|
| Build | `cmake --preset emscripten-headless`, then `ninja z_generals`. A case-sensitive host finds wrong-case includes (14 lines, 7 spellings [V]: `Platform/Web/Include/casefix`) |
| `tools/wasm/check-flags.mjs` | From `compile_commands.json`: every engine TU has the strict set and none has a banned or `-msimd128` flag |
| `tools/wasm/check-undefined.mjs` | Wasm imports against the allow-list. Reads the `-O2` daily build, because `-O3` minifies import names ([V] `env._Z6GoStubi` against `a.a`), and fails loudly if names look minified. The source set is the same, so the answer carries over to the opt build |
| `tools/wasm/check-imports.mjs` | Module imports against an allow-list, no host math. Same `-O2` rule |
| `tools/wasm/check-shared-edits.mjs` | Section 9 |
| `tools/wasm/check-fnptr-casts.mjs` | No function-pointer cast outside the reviewed list |
| `node generals.js -webVersion`, `-webSelfTest` | Static constructors run. `(Int)NaN` is `INT_MIN`. NaN of both signs through `fast_float_*`, `REAL_TO_INT_*` and `XferCRC` gives one answer. Quoted-printable round trip |
| NaN variants of `-webSelfTest` | P and N give the same output, apart from the raw-bits lines |
| `rep.mjs` over `GeneralsReplays` | All 15 parse to exact end of file |
| `Platform/Web/test/fs` on the memory backend | Generated BIGF files, load order, shadowing, loose against archived names, backslash and mixed-case opens, wildcard masks, writes under missing folders, `/game` write refusal |
| `Platform/Web/test/audio`, `Platform/Web/test/text` | Synthetic WAV and MP3 headers; wide formats |
| `tools/replay-runner/test` | A fake engine produces each status and the two-line frame 0 case, and the runner classifies each one |

Replay jobs that need game data show `notRun` and don't pass. They run locally with `--require-game-data` (brief section 7). Test fixtures are generated at run time: `.big` and `.wav` are forbidden in the repo (`.gitignore`, `tools/safety/`). `web-safety.yml` stays as is.

The first CI run may find Linux-only failures. If it does, the integrator reopens WP17 with the log, since it owns `Platform/Web/Include/casefix` from then on.

## 15. Work order

The briefs are held with the work list, and they point here.

1. WP01 skeleton: build files, the shim, the shared headers two or more areas need, and the checks every later package runs.
2. In parallel, each with its own build folder: WP02 libraries, WP03 logic and common, WP04 client and network, WP05 device, WP06 file system, WP07 audio. Don't serialise these for build time: [R] 12 sampled `z_gameengine` files averaged 1.06 s at `-O2`, so about 6 minutes for all 951 files at `-j 3`. Batch edits to your `extra/*.h` and rebuild after a batch, because each edit rebuilds your target.
3. WP08 wide chars. It comes after the compile packages because `Recorder.cpp` needs GO's headers to compile, and those packages would otherwise overlap its files.
4. WP09 link, including a first `-webVersion` in Chrome. WP10 boot and `iniCRC`. WP11 runner and hook. **WP12 recording and full playback (end point).**
5. WP13 determinism fixes.
6. In parallel: WP14 test corpus, WP16 Chrome harness and Mac steps, WP17 CI. Then WP15 variants, once the corpus exists.
7. WP18 full x64 run and results.

Chrome first runs at WP06 (file tests) and WP09 (`-webVersion`), and with the engine and game data at WP16, which may change `Platform/Web/Source/FS`.

**Commit points.** The integrator commits and pushes after WP01, after WP02 to WP07 together (the tree doesn't fully build between), after WP08, and after each package from then on. A commit must not hold a half-finished parallel package. Commit before WP15 and before WP18, so those builds have no dirty flag. Run `tools/safety/check.mjs --staged` before each commit, and `--all` after the last.

**Records (brief section 1.6).** At each commit point the integrator updates `STATUS.md` and `docs/PROGRESS.md`. At the end of WP01, the integrator also records these:

- `docs/DECISIONS.md`: a superseding entry for "The engine port must mount that folder" (the `Generals/` layout isn't supported and is refused at mount); no LTO for now; section 2's decisions in short.
- `UPSTREAM.md`: the reference port row now says code is derived from it, at commit `026659213`. `Platform/Web/NOTICE.md` cites the same commit.
- `docs/DETERMINISM.md`: a one-line correction of section 2's claim that no path runs from logic into Miles, once its author has finished (`ScriptEngine.cpp:7362-7366` to `GameAudio.cpp:948-964` to `MilesAudioManager.cpp:2557-2575` is such a path [S]).

**Upstream (brief section 8).** GO main is still 6ff4044 [R]. The integrator checks before each commit point. A merge happens only at a commit point, never during a parallel group, and then moves the base line in `UPSTREAM.md`, rebuilds native and web, and reruns the checks.

**Any new wasm SHA-256 voids recorded hashes and the owner's M4 result**, unless a run shows the streams unchanged with `--allow-different-wasm`. A CRC change means re-recording. The owner compares only against the table in `docs/WASM_RESULTS.md` for the wasm named there.

**Exit from P2.** Brief section 6 says not to wait for the owner. After WP18, with pass-test items 1 and 3 and the x64 part of item 2 met, P2 closes as "x64 Intel passed; ARM64 and AMD pending" in `STATUS.md`, and work moves to P3. At the start of each phase the integrator reads the repo's issues (brief section 6). A filed ARM64 or AMD mismatch reopens P2 ahead of other work, starting from section 11.5. If no AMD machine turns up, AMD stays listed as not verified, and that doesn't block anything.

## 16. Rules for parallel work

- One working tree, branch `main`. No branches, worktrees or stash. **Don't commit:** the integrator does. Read-only git is fine, including `git show okjid/okji/feat/macos-port:<path>`, `git diff 6ff4044 okjid/okji/feat/macos-port -- <path>` and `git show tsh/main:<path>`.
- Stay inside your package's paths. If a file outside them must change, stop and report it. Other packages may be editing at the same time.
- Each package uses its own build folder: `cmake --preset emscripten-headless -B build/<wp-id-lowercase>`, and a `-j` limit if the brief gives one. Never share one with another running package. In PowerShell, every command needs `& <emsdk>\emsdk_env.ps1 | Out-Null` first, since shell state doesn't persist. Set `$env:GIT_OPTIONAL_LOCKS='0'`: the build's `git_watcher` runs `git status` (`resources/gitinfo/git_watcher.cmake:130`).
- `FetchContent` clones into `build/` during configure are fine. They leave the repo untouched.
- **No game data in the repo.** Read `<assets>` only. Never copy any of it into the repo. Never open or list an installed game folder or `GAME_DIR`. Never contact GO's servers.
- Never add AI or tool attribution anywhere. Keep existing licence notices. Files derived from OKJID's port are GPL-3.0 with EA's terms: mark them as modified, and list them in `Platform/Web/NOTICE.md`, or in your final report if it isn't in your paths.
- Follow section 9 for shared files. Your ledger is `Platform/Web/shared-edits/<WP>.md`. Never change simulation behaviour to make something compile. If you can't tell, stop and report.
- Use `git diff <base>`, not a bare `git diff`, in any check, so committed changes count.
- Back claims with evidence. Separate what you ran from what you inferred, and list what you didn't check. Don't guess numbers: measure them or say they're unmeasured.
- If this document is wrong, don't quietly work around it. Say what's wrong and what you did.

## 17. Open questions and known unknowns

**For the owner**

- The community patch archive isn't in the ingested data, so web gameplay is retail INI for now. Should the ingestion tool take it, and from where? Client source only reads it. Changing it later means a new manifest and new test replays.
- Is an AMD x64 machine available for the cross-machine test?

**Unmeasured**

- Everything at run time on the stock tree. Survey counts (93 of 631 failed steps, 146 undefined symbols) come from partial runs at `-O1`, some on OKJID's tree.
- Whether the recording path in section 12 runs as read, including skirmish start without a load screen and an observer in slot 0. The fallback is a local human slot left idle.
- Whether the command bot in section 12 reaches `logicMessageDispatcher` through the translators as read.
- Time per frame, peak memory, whether 4 MB and 1 MB stacks are enough, and recursion depth against V8's limit (WP16 measures the margin).
- `-O3` compile time, link memory and wasm size. WP13 measures them.
- Undefined-function aborts on the real engine. [V] On a small program, an undefined function aborts with its name and exit 1 at `-O2` and `-O3` with assertions off, including through a function pointer and inside `catch(...)`. WP09 confirms it on the engine.
- OPFS read speed on 2.2 GiB, and on macOS at all. [R] Node backend reads measured 437 MB/s under pthreads on a cached file, an upper bound.
- Whether NaNs occur in real simulation at all. The counters will say, per replay.
- Which map scripts use the audio conditions, and bone names inside scaffold W3D models (section 5).

## 18. Review notes

The draft was reviewed for determinism, buildability and fit with the brief. Each claim was checked in source, and the ones that held are worked into the sections above. Five new probes ran on this laptop while checking: OPFS with path mapping, the `vswprintf` wrap, `-O3` with and without LTO, `--denan` on a NaN literal, and the missing `$stringToUTF8OnStack`.

**Rejected or changed, with reasons**

| Proposal | Decision | Why |
|---|---|---|
| Make the CRC log build compile from WP09 on, and keep it green in CI | Rejected | `-webDumpFrames` in the normal wasm answers which frame, section, object and value, across machines, with the same bytes. The log build costs engine edits and a CI build, and only adds mid-frame detail. Section 11.5 lists its known gaps for whoever needs it. |
| Keep `first-divergence.mjs` to automate the procedure | Dropped | With dumps, the procedure is two runs and one `compare.mjs --dump`. Fault injection still proves the tool works. |
| Make `-O3` with LTO the build the pass test uses | Changed: `-O3` without LTO | LTO silently changes float-to-int results (section 3.2, [V]). The point that the tested build should be the optimised one stands, so the corpus and M4 run use `-O3`. |
| Route `vswprintf` through a `web_prefix.h` macro | Changed: link-time wrap | A wrap catches every caller, ranks higher in section 9 rule 1, and was proven by a probe. A macro would clash with libc++'s `using ::vswprintf` [I]. |
| Replace `QuotedPrintable.cpp` with a whole-file copy | Changed: wrap the two functions | No copy to keep in step with upstream, and the round trip in `-webSelfTest` catches a stale name. |
| Run WP03 and WP04 one after the other to limit rebuilds | Rejected | Measured compile time is small (section 15). Scoped force-includes and batching are enough. |
| Use `userOverlaySha256` to record the Chrome user folder | Changed | The folder is fresh and empty for every run, which is simpler than recording what's in it, and `--user-overlay` had no user. |
| Collect template names at object creation | Changed: sample every 30 frames, plus counters at patched sites | Sampling needs no hook in shared code. The counters answer the real question, whether the risky code ran. |
| Verify SHA-256 in the test page on every reuse | Changed: on demand | The shell already verifies on install, and hashing 2.2 GiB per replay isn't worth it. The owner's second stage uses it. |
| Drop NaN variant Z | Kept, as information only | It's cheap (no rebuild), and it shows whether NaNs flow through plain casts, which the counters can't see. |
| Remove `--user-overlay`, reduce to five statuses, one CI step list | Accepted | Listed here because it removes things earlier sections described. |

**Accepted with a limit:** the local-slot variant may find the engine refuses an AI slot as local. WP15 records why, and a two-human scenario is the fallback.

**Not checked in this review:** any engine compile or run, ARM64, real V8 stack limits, a trial merge of PR #2670 (it would write git objects), and which map scripts use the audio conditions.

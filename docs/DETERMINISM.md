# Floating-point determinism: native GO client against wasm32

Researched 2026-11-03. No compiler was installed, so nothing here was built or run. The game was not launched.

Line numbers refer to GO commit 6ff4044. Everything committed since then leaves the cited source files unchanged.

Each claim carries one of these labels:

| Label | Meaning |
|---|---|
| **[S]** | Read in the source at 6ff4044 |
| **[B]** | Read from a local binary by static parsing and hand decoding of bytes. Never executed. |
| **[D]** | Stated in Microsoft documentation |
| **[R]** | Reported by someone else and not reproduced here |
| **[I]** | My inference |

## Summary

| Question | Answer | Evidence |
|---|---|---|
| SSE2 or x87? | **Both.** Ordinary compiled scalar math is SSE2. The shipped client also runs x87 code, all under `_PC_24`. | §1, §3 |
| Route B today? | **No.** Not in GO main, not in any of the 395 `go/*` refs, and not in the shipped client. | §4 |
| Do corpus replays hold CRC data? | **Yes.** All 15 hold `MSG_LOGIC_CRC` records, 27,241 in total. | §5 |
| Can native GO pass that corpus? | **No.** It has a different tick rate and different rules. The corpus can't be a pass gate for GO. | §5 |
| Route A verdict | **Feasible but unproven, and the plan as written is too narrow.** Medium confidence. | §6 |

Four findings change the plan:

1. **The premise "the simulation compiles to SSE2 scalar math" is only partly true.** The shipped executable has 30,884 SSE scalar arithmetic instructions and 6,055 x87 arithmetic instructions [B]. That is not fatal, because `setFPMode` forces 24-bit x87 precision, so x87 float arithmetic rounds like SSE float arithmetic in the normal range [I].
2. **`atan2` is an x87 function on this build.** It reaches `fpatan` with no SSE2 path [B]. `WWMath::Sin`, `Cos`, `Sqrt` and `Inv_Sqrt` are x87 inline assembly [S].
3. **GO's current release is newer than its public source.** The release came from a `vs2026-vcpkg` preset that is in no public ref, and it is version `100126_QFE6`. Public main says `100126_QFE2` [S, B]. This is the largest risk to Route A, and it isn't about math.
4. **The GO developers asked another non-Windows client to turn off cross-play with the PC client** [R]. See §6.5. The owner should read that before investing further.

## 1. Build

### Flags

No preset, CMake file or target sets `/fp` anywhere. The only `/arch` in the tree is `cmake/config-build.cmake:41`, and it applies only when `RTS_BUILD_OPTION_OPTIMIZED` is on. No per-target or per-file FP flags exist. The only `set_source_files_properties` in the GeneralsMD game code is a define for `VCRuntimeCheck.cpp` (`GeneralsMD/Code/Main/CMakeLists.txt:94`). [S]

| Preset | Source | `/arch` set by repo | `/fp` set by repo | Other relevant flags |
|---|---|---|---|---|
| `win32` | `CMakePresets.json:107-123` | none | none | `/W3`, `/MD`, `/MP`, `/Zc:__cplusplus`, `/guard:cf` |
| `win32-vcpkg` | `CMakePresets.json:142-160` | none | none | Same, plus the `x86-windows-static-md` triplet |
| `win32-vcpkg-optimized` | `CMakePresets.json:178-187` | `/arch:SSE2` (`config-build.cmake:41`) | none | `/O2 /Ob3 /Oi /Ot /Gy /Gw /GL`, `/LTCG` (`config-build.cmake:34-46`) |
| `win32-vcpkg-pgo-*` | `CMakePresets.json:189-203` | Inherited from optimized | none | `/GL`, `/LTCG`, PGO (`config-build.cmake:63-75`) |

The other common flags come from `cmake/compilers.cmake:49,51`, `cmake/config-build.cmake:51-53`, and `CMakePresets.json:89,101`.

**Defaults when unset:**

- On x86, "If you don't specify an `/arch` option, the default instruction set is SSE2" [D, [/arch](https://learn.microsoft.com/en-us/cpp/build/reference/arch-x86)].
- `/fp:precise` is the MSVC default [I, from memory]. The shipped binary agrees: it imports the `_precise` CRT entry points [B].
- CMake's stock Release flags supply `/O2 /Ob2` for presets that don't override them [I].

The same Microsoft page warns that x86 calling conventions pass floating-point values on the x87 stack, so "your code may use a mixture of both x87 and SSE/AVX instructions". It also describes `_controlfp` precision control as a separate x87-only effect [D]. That is the mechanism behind §3.3.

### Which preset GO ships

The repo says `win32-vcpkg`. The shipped binary says otherwise.

| Evidence | What it says |
|---|---|
| `.github/workflows/ci.yml:138-149` | Only the vcpkg presets can build GeneralsMD. CI builds `win32-vcpkg`, `-profile`, `-debug`. |
| `MakePatch.ps1:2`, `:31` | Packages `build\win32-vcpkg\GeneralsMD\Release\GeneralsOnlineZH.exe`. |
| `PatchNotes/092625.md` | No build information. |
| `TESTING.md:14` | Replay testing needs a VC6 build. Says nothing about what GO ships. |
| `.github/workflows/weekly-release.yml` | Fully commented out. Not how GO releases. |
| Local install, `GeneralsOnlineZH_60.exe` [B] | Build directory `vs2026-vcpkg`, linker 14.51, PE timestamp 2026-10-03T02:44:13Z. |
| Same file, Rich header [B] | Product IDs 0x105 and 0x104 with counts 1,199 and 1,214 at compiler build 36257. I read those as C++ and C objects, and the absence of LTCG product IDs as `/GL` being off [I, from my memory of the Rich product ID table]. |
| Same file, strings [B] | `100126_QFE6`, `gen_online_60hz`. |
| `https://cdn.playgenerals.online/manifest.json`, fetched 2026-11-03 | Version `100126_QFE6A`, file `GeneralsOnline_portable_100126_QFE6.zip`. So the installed build is at least the QFE6 family that is current today. |

`GeneralsOnlineZH.exe` in the same folder is a .NET apphost launcher with no game code [B].

**What this means:**

- `vs2026-vcpkg` is in no public preset, and `git log --all -S vs2026-vcpkg -- CMakePresets.json` finds nothing. The shipped build's real flags can't be read from the repo.
- Its imports match SSE2 with `/fp:precise`: `_libm_sse2_sin_precise` and the rest [B].
- CI builds on `windows-2022` (`build-toolchain.yml:32`), which is not the VS2026 toolset of the shipped build. Codegen for §3.3 depends on the compiler version, so a CI build isn't proof of what ships [I].
- Public `NextGenMP_defines.h:16` says `100126_QFE2`. `git log --all -S 100126_QFE6` finds nothing, and public main hasn't moved since 6ff4044. The binary was built about 1h40m after that commit. The exact source of the current release is not public, and only the version string is known to differ [S, B].

### `RETAIL_COMPATIBLE_CRC`

It is **0** for GO [S]:

- `Core/GameEngine/Include/Common/GameDefines.h:108-114` sets it to 0 when `GENERALS_ONLINE` is defined, and to 1 otherwise.
- `GENERALS_ONLINE` comes from `GeneralsMD/Code/GameEngine/CMakeLists.txt:1242`, which is directory scoped. Core sources join that target through `corei_gameengine_private` (`Core/GameEngine/CMakeLists.txt:1169`, `GeneralsMD/Code/GameEngine/CMakeLists.txt:1213`).
- It also comes from `NextGenMP_defines.h:3-5`, which `WWCommon.h:28` includes before `GameDefines.h` through `Core/GameEngine/Include/Common/GameCommon.h:54-55`.
- All real uses are in Core and GeneralsMD game-engine code. `Core/Libraries/Include/Lib/BaseType.h:227,352` only mention it in comments. The directory-scoped define therefore can't split the setting across libraries.

Related settings that also move GO away from retail [S]:

- `RETAIL_COMPATIBLE_XFER_SAVE`, `RETAIL_COMPATIBLE_PATHFINDING_ALLOCATION` and `RETAIL_COMPATIBLE_AIGROUP` are 0 (`GameDefines.h:116-154`).
- `GENERALS_ONLINE_COMMUNITY_PATCH_CHANGES` is 1 (`NextGenMP_defines.h:9`), which flips three `PRESERVE_*` switches (`GameDefines.h:50-82`).
- `GENERALS_ONLINE_HIGH_FPS_SERVER` is 1 (`NextGenMP_defines.h:73`), which gives 60 logic frames per second (`WWCommon.h:48-52`, `GameCommon.h:69`).

## 2. Runtime FPU state

### What `setFPMode` does

`GeneralsMD/Code/GameEngine/Source/GameLogic/System/GameLogic.cpp:201-224` [S]:

1. `_fpreset()`.
2. `_controlfp(newVal, _MCW_PC | _MCW_RC)` with `_RC_NEAR` and `_PC_24`.
3. `_controlfp_s(&cw, _MCW_EM, _MCW_EM)`, which masks all exceptions.

The comment at lines 203-206 says rounding is set to CHOP. **That comment is stale.** Line 216 sets `_RC_NEAR`, and the CHOP line is commented out at 217.

`_fpreset` in the 32-bit UCRT decodes to `fninit` followed by loading 0x1F80, apparently into MXCSR (`DB E3`, `B9 80 1F 00 00`) [B]. So each call clears FTZ and DAZ.

**State under simulation** [I, from the above]: x87 control word 0x007F (24-bit, nearest, all masked), MXCSR 0x1F80 (nearest, all masked, no FTZ, no DAZ). Experiment 9 confirms this at run time.

The in-tree search for `_control87`, `_mm_setcsr`, `fesetround`, `FLUSH_ZERO`, `DENORMALS_ZERO`, `_set_SSE2_enable` and `_set_FMA3_enable` found nothing. In-tree `fldcw` is only in `dx8wrapper.h:999-1046`, which is VC6 only (`:986`). [S]

### When it runs

| Site | When |
|---|---|
| `GameLogic.cpp:3937` | Start of every `GameLogic::update`. This is the one that protects the simulation. |
| `GameLogic.cpp:4396` | `GameLogic::getCRC` |
| `GameLogic.cpp:445`, `:528` | `init`, `reset` |
| `GameLogic.cpp:1459`, `:2385` | New game setup, during the fade loop around draws |
| `Core/GameEngine/Source/GameClient/GUI/LoadScreen.cpp:173`, `:649`, `:1142` | After load-screen draws |
| `GeneralsMD/.../Menus/ScoreScreen.cpp:882` | After score-screen video |
| `Core/GameEngine/Source/Common/INI/INI.cpp:376` | Every INI load: "so we have consistent Real values for GameLogic" |
| `Core/GameEngine/Source/GameClient/MapUtil.cpp:433` | Map cache update |
| `Core/GameEngineDevice/.../Draw/W3DModelDraw.cpp:507`, `:603`, `:727`, `:865` | Lazy bone, weapon-barrel and turret validation, because simulation reads those |
| `Core/GameEngine/Source/Common/Diagnostic/SimulationMathCrc.cpp:64`, `:68` | Sets the mode, then `_fpreset`. No callers in the tree, and its name string is absent from the shipped exe [S, B]. |

`W3DWaterTracks.cpp:842` is only a declaration. No `CreateThread`, `_beginthread` or `std::thread` appears in the game-logic directories, so logic is single threaded with respect to FP state [S].

### D3D8 and Miles

**D3D8.** The device is created without `D3DCREATE_FPU_PRESERVE` unless `-FPUPreserve 1` is passed (`Core/Libraries/Source/WWVegas/WW3D2/dx8wrapper.cpp:45,102,545-550`, `GeneralsMD/Code/GameEngine/Source/Common/CommandLine.cpp:146-153,1202`) [S]. Without that flag, Direct3D defaults to single precision and round-to-nearest, and the older managed docs add that it resets FPU state on every call [D, [D3DCREATE](https://learn.microsoft.com/en-us/windows/win32/direct3d9/d3dcreate), [CreateFlags](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/bb322872(v=vs.85)?redirectedfrom=MSDN)]. Those pages cover D3D9 and managed D3D, so applying them to D3D8 is my inference. `FPUControl.h:33-36` gives the same reason for `setFPMode` existing.

D3D's default state and `setFPMode` agree on precision and rounding, so the simulation doesn't depend on which one ran last, as long as nothing else unmasks exceptions or leaves FTZ set [I].
**Miles.** `MilesAudioManager.cpp:1417,1424` starts it. `mss32.dll` and `binkw32.dll` contain raw `fldcw` byte patterns (32 and 30 matches) and no `ldmxcsr` patterns [B, heuristic]. Headless mode selects a different audio manager (`GameEngine.cpp:603`), so a headless pass doesn't exercise Miles. I found no path from logic into Miles inside a frame, but I didn't prove there is none [I]. Experiment 9 checks this.

### The CRT reads FPU state

This matters and is easy to miss. The UCRT's x86 math functions test FPU state at run time [B, hand decoded from `ucrtbase.dll` 10.0.26100.9711]:

```
_libm_sse2_sin_precise:
  stmxcsr [esp+4]
  (mxcsr & 0x7F80) == 0x1F80 ?   all SSE exceptions masked, round nearest
  fnstcw  [esp]
  (x87cw & 0x7F) == 0x7F ?       all x87 exceptions masked
  if not: jump to a different code path
```

Microsoft documents the same condition: "The SSE2 implementation is only used if all exceptions are masked" [D, [`_set_SSE2_enable`](https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/set-sse2-enable)]. So the `_MCW_EM` mask at `GameLogic.cpp:223` is load-bearing. It keeps the CRT on its SSE2 algorithm. `_PC_24` isn't checked, and doesn't affect that SSE2 path.

## 3. Math reachable from the simulation

### 3.1 Inventory

Scope of the scan: `GeneralsMD/.../GameLogic`, `Core/.../GameLogic`, both `Source/Common`, both `Include`, `Lib/Include`, and `WWMath`. Counts are comment-stripped regex hits, so treat them as approximate. They include definitions. The scan doesn't cover `WW3D2` or `GameEngineDevice`, which hold simulation-reachable code too (§3.5).

"Site" counts are direct calls through import thunks in the whole shipped exe, including rendering and libraries [B].

| Source route | Count in scan | Shipped x86 path | Exe sites | Precision behaviour |
|---|---|---|---|---|
| `Sin()`, `Cos()` from `Lib/trig.h` | 64, 61 | `Trig.cpp:49-57` to `sinf`, `cosf`, then `(float)sin((double)x)` | `_libm_sse2_sin_precise` 124, `_cos_` 125 | SSE2 double, rounded once to float |
| Raw `sin`, `cos` | 12, 7 | Same | Same | Same |
| `sinf`, `cosf` in `matrix3d.h`, `matrix3.h`, `vector3.h` | 23, 23 | Same | Same | Same |
| `WWMath::Sin`, `Cos` | 23, 15 | Inline asm `fld; fsin; fstp` (`wwmath.h:353-391`) | 38 and 26 `fsin`, `fcos` in sweep | x87 extended internally, rounded once on store |
| `ACos()`, `acos` | 10, 3 | `Trig.cpp:64-67`, `wwmath.h:519-522` | `_libm_sse2_acos_precise` 11, `_CIacos` 2 | SSE2 path while masked |
| `ASin()`, `asin` | 4, 2 | `Trig.cpp:69-72`, `wwmath.h:556-559` | `_libm_sse2_asin_precise` 6 | SSE2 path while masked |
| `atan2`, `WWMath::Atan2` | 30, 20 | `_CIatan2` (`wwmath.h:137`, `matrix3d.cpp:251,269,287`) | `_CIatan2` 28 | **x87 `fpatan`, no SSE2 path** (§6.2) |
| `WWMath::Atan` | 0 outside its definition | `wwmath.h:136` | `_libm_sse2_atan_precise` 2 | Not used by the scanned simulation code |
| `sqrt`, `sqrtf` | 52+, 25 | Inline `sqrtsd`, with a CRT call on the error path | `sqrtsd` 282, `_libm_sse2_sqrt_precise` 282 | Correctly rounded |
| `WWMath::Sqrt` | 11 | Inline asm `fsqrt` at `_PC_24` (`wwmath.h:565-581`) | 110 `fsqrt` | Correctly rounded to float |
| `WWMath::Inv_Sqrt` | 10 | Magic constant and Newton steps in x87 asm (`wwmath.h:613-663`) | **212 inlined** (`B8 08 B5 6E BE`) | Not equal to `1/sqrt` |
| `pow` | 10, all exponent 2 | `PartitionManager.cpp:5756,5784,5812,5840`, `BuildAssistant.cpp:1438` | `_libm_sse2_pow_precise` 16 | UCRT special-cases exponent 2 [R] |
| `floor`, `ceil`, `floorf`, `ceilf` | Few | CRT | `floor` 56, `ceil` 56 | Exact. Uses `roundsd` when the CPU has SSE4.1 [B]; the result doesn't change. |
| `fabs`, `WWMath::Fabs` | 128, 297 | `wwmath.h:100-105` is a bit mask through a pointer cast | | Exact, but aliasing-sensitive |
| `tan` | Only `matrix4.h:438-439`; `Tan()` has no callers in scan | | `_libm_sse2_tan_precise` 13 | Not simulation in scanned code |
| `exp`, `log`, `log10`, `sinh`, `cosh`, `tanh` | Only uncalled `SimulationMathCrc.cpp` | | 2, 9, 4 | Not simulation in scanned code |
| `fmod` | 0 in scan | | `_CIfmod` 11 | Not simulation in scanned code |
| Lookup tables | `_FastSinTable`, `_FastAcosTable`, `_FastAsinTable` | Built in `wwmath.cpp:51-72`, called from `W3DDisplay.cpp:796`; read by `Fast_*`, used in `quat.cpp:467-471` | | Built with CRT `sin`, `acos`, `asin` and stored as float |

Trig tables in `Trig.cpp:74-143` are dead code behind `REGENERATE_TRIG_TABLES` [S].

**On 32-bit MSVC there are no real float transcendentals.** The x86 `ucrtbase.dll` exports no `sinf`, `cosf` or `atan2f` [B]. Only the `/fp:fast`-style `__libm_sse2_sinf` family exists, and GO imports none of it [B]. So `sinf(x)` is `(float)sin((double)x)` [I; R agrees]. On Clang, `sin(float)` resolves to a true `sinf` with its own rounding, which is a trap for wasm (§6.3).

### 3.2 Inline assembly

Active on the shipped build:

| Function | Location | Note |
|---|---|---|
| `Float_To_Long` (float, double) | `wwmath.h:316-347` | `fistp` under `_RC_NEAR`, so it **rounds**, unlike a C cast |
| `Cos`, `Sin` | `wwmath.h:353-391` | `fsin`, `fcos` |
| `Sqrt` | `wwmath.h:565-581` | `fsqrt` |
| `Inv_Sqrt` | `wwmath.h:613-663` | Reaches simulation through `Vector3::Normalize` (`vector3.h:422,435`), `vector2.h:330,340`, `quat.cpp:117` |

**`fast_float2long_round`, `fast_float_trunc`, `fast_float_floor` and `fast_float_ceil` are not assembly on this build.** The asm in `BaseType.h:157-160` and `:173-183` requires `_MSC_VER < 1300`. Modern MSVC gets `lroundf` and bit manipulation (`BaseType.h:162`, `:186-192`, `:197-212`).

`Float_To_Int_Chop` and `Float_To_Int_Floor` (`wwmath.h:583-607`) are integer bit manipulation, also not assembly.

Dead assembly: `quat.cpp:257` (`#if 0`, with the live C version at `:440`), `matrix3d.cpp:746` (`#if 0`), `vp.cpp:68,84` (`__ICL` only), `dx8wrapper.h:986` and `crc.h:95` (VC6 only). The remaining `__asm` files are CPU detection, stack walking, profiling, atomics and image code, with no FP math.

### 3.3 Compiler-generated x87

Whole-exe census from a linear sweep with a small length decoder, which resynchronized 16 times over `.text` [B, heuristic but consistent with raw byte counts]:

| Group | Count |
|---|---|
| SSE scalar arithmetic (`add`, `sub`, `mul`, `div`, `ss`/`sd`) | 30,884 |
| x87 arithmetic (`fadd`, `fmul`, `fsub`, `fdiv` families) | 6,055 |
| x87 load and store | 8,023 |
| `fsin`, `fcos`, `fsqrt`, `fpatan`, `fptan`, `fyl2x`, `f2xm1`, `fsincos` | 188 |
| `fist`, `fistp`, all sizes | 372 |
| x87 arithmetic with a 64-bit memory operand | 178 |
| `cvttss2si`, `cvttsd2si` | 726, 136 |

A decoded example, at RVA 0x115696:

```
e8 15 cb 11 00   call  <float-returning method>
d8 4d f8         fmul  dword ptr [ebp-8]
51               push  ecx
d9 1c 24         fstp  dword ptr [esp]
```

The return value arrived on the x87 stack, so MSVC finished the expression there. Directly after a `call`, the sweep found `fmul m32` 131 times, `fadd m32` 94, `fdiv m32` 29, `fdivr m32` 13, `fsub m32` 9, `fsubr m32` 7, and `fdivr m64` once. A TheSuperHackers developer reached the same conclusion from Godbolt output: math in an expression involving a floating-point return is subject to this, and `/fp:strict` didn't stop it [R, PR #2670 comments, 2026-08-26].

The Android port's report says "ordinary float and double arithmetic is IEEE SSE on both sides; only explicit x87 assembly differs" [R]. That overstates it, per the census above. Its result still holds up, for the reason in §6.1.

I can't say how many of these sites are simulation. The exe has no symbols. Attribution needs a matching build with listings (experiment 3).

### 3.4 Float and integer conversions

| Macro or form | Source | Shipped behaviour | Sites in scan |
|---|---|---|---|
| `REAL_TO_INT(x)`, plain casts | `BaseType.h:215` | `cvttss2si`: truncate. NaN and out of range give 0x80000000. | 61 |
| `REAL_TO_INT_CEIL`, `_FLOOR` | `BaseType.h:231-232` | Bit-level ceil or floor, then **UCRT `lroundf`** | 38, 90 |
| `REAL_TO_UNSIGNEDINT` | `BaseType.h:216` | Through `long long`, truncated to 32 bits, under the VS2022 default [D, [/fpcvt](https://learn.microsoft.com/en-us/cpp/build/reference/fpcvt)] | 9 (`PartitionManager.cpp:5763` and siblings, `EMPUpdate.cpp:93-94`, `ScriptEngine.cpp:7363,7398`, `BuildAssistant.cpp:249`) |
| `fast_float_trunc`, `_floor`, `_ceil` | `BaseType.h:170-212` | Read float bits through pointer casts, so NaN sign matters | Through the macros |
| `Float_To_Long` | `wwmath.h:316-347` | `fistp`, rounding | No callers in GameEngine directories |

`lroundf` returns **0** for NaN, infinities and out-of-range values, not 0x80000000. The bytes show the range check, `cvttss2si` for valid input, and `xor eax,eax; leave; ret` for invalid input [B; R agrees].

These cases do occur in real games [R]. The Android port traced one such divergence to `SlowDeathBehavior::getProbabilityModifier`, where debris with zero max health computes 0/0 and casts it to `Int`. x86 gets 0x80000000, the value clamps to 1, and no RNG value is drawn. Other behaviour draws one, and the seed diverges.

### 3.5 Other points

**`long double`:** only `GeneralsOnline/json.hpp:7932`, which isn't simulation. It is 8 bytes on MSVC and 16 on wasm32, so keep it out of simulation code [S, I].

**Mixed float and double evaluation that is active in simulation** [S]:

- `Coord2D::length`, `Coord3D::length` (`BaseType.h:286,522`): float arithmetic, then `sqrt(double)`, then a cast to `Real`.
- `ICoord2D::length`, `ICoord3D::length` (`BaseType.h:425,634`).
- `PartitionManager::calcMinRadius` and `calcRadiusVec` (`PartitionManager.cpp:3201-3216`, `:3232-3234`, active because `PartitionManager.h:72` defines `FASTER_GCO`). `double dist = sqrtf(minDistSqr)` narrows, then widens.
- `pow` and `atan2` return values, and float-with-double-literal expressions (roughly 160 lines in the logic directories, by a loose regex).

Other `double` hits in the logic directories are profiling and debug: `AIPathfind.cpp` under `DEBUG_QPF`, `ScriptEngine.cpp` under `SPECIAL_SCRIPT_PROFILING`, `GameLogic.cpp` timers.

**How often x87 meets a double literal:** a raw scan of `.text` found only one x87 arithmetic instruction whose operand is a `.rdata` double, `fmul 1000000.0` [B]. So double literals almost always go through SSE2. The other x87 64-bit operands are locals or fields, and I can't attribute them yet.

**Simulation reaches outside GameLogic** [S]:

- Bones: `Object.cpp:6163`, `TransportContain.cpp:340`, `W3DModelDraw.cpp:121,507`. These use `WW3D2`'s `htree.cpp`, `motchan.cpp` and `Fast_Slerp`.
- Terrain normals: `BaseHeightMap` through `Vector3::Normalize`, and therefore `Inv_Sqrt` [R].

## 4. Route B state

**Not available.** It would need both a GO merge and a GO release, and neither has happened.

| Check | Result |
|---|---|
| `git grep` for `USE_DETERMINISTIC_MATH`, `gmath.h`, `gamemath.cmake`, `GM_ENABLE_INTRINSICS` across all 395 `go/*` refs, in `Core`, `GeneralsMD`, `cmake`, `CMakeLists.txt` | **0 hits** |
| fb25379 reachable from `go/main`, `go/stable`, `go/60hz`, `go/ipc`, `go/plugins` | No, for all five |
| Newest public `go/main` | 6ff4044, 2026-10-03T01:02Z, before the merge on 2026-10-18 |
| TheSuperHackers commits since the shared merge base (e760b36) up to fb25379 | 360 |
| Shipped QFE6 client | Imports `_libm_sse2_*_precise` and `_CIatan2`. Five fdlibm double constants: 0 hits. [B] |
| `okjid/okji/feat/macos-port` | **Has it** (5 files), and its merge base with `go/main` is 6ff4044. It is a third-party fork, not GO. Useful as a reference only. |

**If GO did merge:** `tsh/main`'s `BaseDefines.h` turns deterministic math on unless `RETAIL_COMPATIBLE_CRC` is set or `gmath.h` is missing. GO runs with `RETAIL_COMPATIBLE_CRC` 0, so taking the merge would switch GO to GameMath automatically [S, I]. That is a CRC-breaking change for every GO player, so it can only arrive in a coordinated release. No public GO commit prepares for it.

Route B wouldn't remove x87 from Windows either. `tsh/main` still sets `_PC_24` (`GameLogic.cpp:216` there). The PR routes the `Pow`, `Atan` and `Atan2` double overloads through float because of it [R, PR #2670, 2026-08-21]. Its authors measured macOS against Windows x86 at `_PC_24` with 0 differences in plain-float rows and 312 in through-double rows, out of 2,904 rows [R]. That table covers GameMath functions only, not the CRT.

## 5. Replay check

### Flags

`GeneralsOnlineZH.exe -headless -replay <file-or-wildcard> [-jobs N]`. Entries at `GeneralsMD/Code/GameEngine/Source/Common/CommandLine.cpp:1154,1160,1166`, parsers at `:411-424,442-464,467-479` [S]. A wildcard path is relative to the user `Replays` folder (`Core/GameEngine/Source/Common/ReplaySimulation.cpp:228-256`).

`-exportStats` crashes the GO client, according to the Android port [R]. Don't combine it.

### Code path [S]

1. `GameMain.cpp:54-57` calls `ReplaySimulation::simulateReplays`, which runs in-process or in worker processes (`ReplaySimulation.cpp:263-269`).
2. `Recorder.cpp:972-978`, `:1110-1243`: read the header, take the CRC interval from the replay's own game options, and build `CRCInfo` (`:1185`, `:1198-1199`).
3. `ReplaySimulation.cpp:91-111` loops on `TheGameLogic->UPDATE()`.
4. Each frame at `GameLogic.cpp:3996-4024`: on `frame % interval == 0`, compute `getCRC` and append `MSG_LOGIC_CRC(crc, isPlayback=true)` to the command list.
5. `GameLogic.cpp:4036` updates the recorder, which reads recorded commands for this frame (`Recorder.cpp:441-444`, `:1317-1409`). Recorded CRC messages carry `false` in the boolean.
6. `GameLogic.cpp:4041` processes commands. `GameLogicDispatch.cpp:808-811` and `:2417-2423` call `handleCRCMessage`.
7. `Recorder.cpp:1010-1075`: a local value (true) is queued, with the first dropped for multiplayer recordings (`:120-135`). A recorded value (false) from the recording player pops the queue and compares (`:1028-1031`).

### Reporting a mismatch [S]

- `printf("CRC Mismatch in Frame %d\n", ...)` (`Recorder.cpp:1056`), computed from the queue depth (`:1046`).
- `setSawCRCMismatch` runs only when no window has focus (`:1060-1069`).
- The loop stops and counts an error (`ReplaySimulation.cpp:106-110`). Exit code is 1 (`:135`, `GameMain.cpp:56`). Worker mode prints `Error!` (`:163-167`).

**Limits of the check** [S, I]:

- Only the recording player's messages are compared (`Recorder.cpp:1024-1026`), and other players' are skipped.
- A replay with no CRC records compares nothing and passes silently. It doesn't check that any comparison happened.
- Checkpoints are 100 frames apart: `C=100` in every replay here, with `NET_CRC_INTERVAL` at `Network.cpp:58-60` and the clamp at `GameInfo.h:220`.
- What's hashed is raw bytes, floats and NaN bits included (`XferCRC.cpp:123-132`, `GameLogic.cpp:4391-4506`).

### `.rep` format [S]

From `Recorder.cpp:526-698`, `:771-870`, `:876-970`, `:1185-1196`, `:1317-1409`. `Bool` is one byte (`BaseTypeCore.h:122`).

| Part | Layout |
|---|---|
| Magic | `GENREP`, 6 bytes, no terminator |
| Times | int32 start, int32 end |
| Stats | uint32 frame count, `Bool` desync, `Bool` quit early, 8 × `Bool` disconnect |
| Text | UTF-16 name, SYSTEMTIME (16 bytes), UTF-16 version, UTF-16 build time |
| Identity | uint32 version number, uint32 exe CRC, uint32 INI CRC |
| Game | ASCII options (`...;C=<interval>;...`, `GameInfo.cpp:935`), ASCII local slot index |
| Mode | int32 difficulty, int32 original game mode, int32 rank points, int32 max FPS |
| Each record | uint32 frame, uint32 type, int32 player, uint8 N, then N × (uint8 arg type, uint8 count), then arguments |

Argument sizes: int, real, object, drawable, team, timestamp 4; bool 1; location 12; pixel 8; region 16; widechar 2 (`Recorder.cpp:829-870`, enum at `MessageStream.h:65-79`).

`MSG_LOGIC_CRC` evaluates to **1095** in both `MessageStream.h` files, counting enumerators from 1000 (`GeneralsMD/.../MessageStream.h:513,619`).

### Corpus results

Parsed with a Node script. Every file parsed to exactly end of file with no bytes left over. Every CRC record has the shape `INT×1, BOOL×1` with the boolean false, and no CRC value is zero.

"Checkpoints" is the number of distinct CRC values. In all 15 files it equals the largest per-player message count, so all players agreed at every checkpoint when the games were played [I].

**Zero Hour 1.04: 19,657 CRC records.** Build time `Mar 10 2005 13:47:03` except where noted. Exe CRC `DA2B4B18` throughout. INI CRC `FEAAE3F3` except where noted.

| Replay (prefix) | Frames | CRC records | Checkpoints | Note |
|---|---|---|---|---|
| `!Golden Replay #1` | 178,496 | 11,601 | 1,766 | INI CRC `B859D2F9` |
| `00-03-45` | 20,865 | 416 | 208 | |
| `00-31-22` | 55,427 | 1,108 | 554 | Build `Oct 17 2005 17:31:25` |
| `00-41-30` | 37,019 | 740 | 370 | |
| `05-01-50` | 23,160 | 391 | 197 | |
| `11-25-57` | 8,027 | 227 | 78 | Russian version string |
| `12-11-35` | 99,130 | 1,982 | 991 | Russian version string |
| `15-07-24` | 85,581 | 1,710 | 855 | Russian version string |
| `18-13-02` | 41,031 | 1,080 | 360 | |
| `366648` | 13,500 | 402 | 134 | |

**Generals: 7,584 CRC records.** The folder is named `1.08`, but headers say `Version 1.7` or its Russian equivalent, number 0x10007. Build `Nov 10 2005 10:44:49`, exe CRC `FCD27C0E`, INI CRC `772766FB`.

| Replay (prefix) | Frames | CRC records | Checkpoints |
|---|---|---|---|
| `15-00-59` | 18,379 | 366 | 183 |
| `20-49-07` | 36,529 | 2,341 | 363 |
| `20_17_41` | 35,428 | 2,112 | 352 |
| `20_51_02` | 25,747 | 1,536 | 256 |
| `CW_050307` | 61,625 | 1,229 | 616 |

**One GO recording, for comparison:** `Version 1.04`, build time `Oct  2 2026 22:44:06` (matching the shipped exe's PE timestamp in UTC-4), mode 5 (`GAME_INTERNET`, `GameLogic.h:81`), 26,573 frames, `C=100`, 525 CRC records, 265 checkpoints. So GO recordings carry CRC data too, at 100-frame intervals on the 60 Hz clock.

### What this settles

**The open question in PR #2670 is answered: the replays do contain CRC data.** The check isn't just proving absence of crashes. Evidence that it can fail:

- `xezon` got `CRC Mismatch in Frame 102635` on the Golden Replay, on an earlier version of the PR [R].
- In the PR's fork CI, `vc6` passed 10 of 10 while the `win32` control **mismatched on all 10** [R, 2026-09-15].

**Why it passed "with and without" deterministic math** [I]: the check runs VC6 builds with `RETAIL_COMPATIBLE_CRC` 1, and `BaseDefines.h` undefines `USE_DETERMINISTIC_MATH` in that case. VC6 doesn't get GameMath either. So the flag had no effect on the run being compared.

**Which build recorded the corpus:** retail executables, from the version strings, 2005 build dates and constant exe CRC [I]. `TESTING.md:14` says only a VC6 optimized non-debug build is compatible.

**Native GO can't pass this corpus.** [S, I]

- 60 logic frames per second, against the corpus's 30.
- `RETAIL_COMPATIBLE_CRC`, `_XFER_SAVE`, `_AIGROUP` and pathfinding allocation are all off.
- Community patch switches change rules.
- GO has already disabled the job: the `replaycheck-generalsmd` block in `ci.yml:158-173` is commented out.
- `check-replays.yml:175` looks for `generalszh.exe`, but GO's output name is `GeneralsOnlineZH` (`GeneralsMD/Code/Main/CMakeLists.txt:5,7`).
- Even TheSuperHackers' own `win32` build, which has no 60 Hz change, fails all 10 [R].

I expect a mismatch at the first compared checkpoint, around frame 111 [I]. Experiment 15 records it.

### The pass criterion should change

"One mismatch fails Route A" is **unfair on this corpus**, because the reference itself can't pass. It is not meaningless, since the data is there. It is fair and strong on a corpus that the reference can pass:

1. Use replays recorded by the exact current GO client.
2. Keep only replays that the shipped exe itself replays with no mismatch. A replay the reference fails is not evidence. The Android port flags this as an unmeasured input of its own: whether a client reproduces its own recording [R].
3. Require coverage: every faction, superweapons, a long match, AI players, and debris and death paths. A matching replay proves only what it exercised [R].
4. On that set, one mismatch fails.
5. Keep the retail corpus only as a parser test and a negative control.

## 6. Feasibility of Route A

### 6.1 Why x87 isn't fatal

Three x87 classes exist, and they differ a lot:

| Class | Example | Matches IEEE on wasm? |
|---|---|---|
| x87 float arithmetic at `_PC_24` | `fld m32; fmul m32; fstp m32` | **Yes in the normal range.** Each operation rounds to 24 bits with the same mode as `mulss`. Differs only outside the normal float range, because x87 keeps a wider exponent: an intermediate overflow can come back in range, and denormal results are rounded twice. |
| x87 functions at higher internal precision | `fsin`, `fcos`, `fpatan` | **Rounded once to float**, so it matches a correctly rounded float result, apart from rare near-midpoint cases and any inputs where x87's accuracy is poor. |
| x87 operating on double values at `_PC_24` | `fld m64; fmul m64` | **No.** Rounds to 24 bits where the C meaning, and wasm, keep 53. These sites need finding and emulating. |

The third class is what matters, and it is small: 178 instructions in the whole exe with a 64-bit memory operand, and the simulation's movement path declares no doubles [R]. Unattributed, though.

A fourth, subtler case: a CRT function returns an extended-precision value that x87 arithmetic consumes directly. The sweep shows two `_CIacos` sites followed by x87 operations with no store, so the result was never rounded to float first [B]. A model of "float, then multiply" would be wrong there.

### 6.2 UCRT x86 internals

All from `ucrtbase.dll` 10.0.26100.9711 on this one machine, x86 unless stated [B]. The opcode counts are byte-pattern heuristics, not a full disassembly.

| Finding | Detail |
|---|---|
| **No FMA3 dispatch on x86** | `_set_FMA3_enable` isn't exported. Only 3 FMA3-looking byte sequences exist in the DLL, attributed to `fma`, `fmaf`, `fmal`. The x64 DLL exports it and has 402 such sites. Microsoft says the switch and FMA3 variants are x64 only, and that results can differ across CPUs there [D, [`_set_FMA3_enable`](https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/get-fma3-enable-set-fma3-enable)]. So CPU-based FMA variation **doesn't apply** to the shipped 32-bit client. |
| Entry points | `_libm_sse2_{sin,cos,tan,asin,acos,atan,exp,log,log10,pow,sqrt}_precise` are what GO imports. The `__libm_sse2_*` family without `_precise` is exported too; GO imports none of them. |
| SSE2 fast path | Pure `xmm` code with tables, after a range check on the exponent (`pextrw`, `sub`, `cmp`). I didn't decode the large-argument path. |
| `atan2` | `_CIatan2` loads a descriptor named `atan2` and jumps to a shared x87 dispatcher. The two-argument setup at RVA 0x8DA05 loads control word 0x133F (64-bit precision) for this descriptor, so `_PC_24` doesn't truncate inside. The kernel at RVA 0x8DEA0 is `fabs; fxch; fabs; fxch; fpatan`, then `fldpi` and `fsubrp` for negative `x`, and `fchs` for negative `y`. The result is left in `st(0)`. Where the next instruction is an x87 store, callers use `fstp` to 32 bits at 15 sites and 64 bits at 6, out of 28 sites. `__libm_sse2_atan2` exists, but GO doesn't import it. |
| `_CIfmod` | Same x87 dispatcher pattern. |
| `sin`, `_CIsin`, `_CIacos` | Check a global flag set by `_set_SSE2_enable` (RVA 0x104D2C), then the FPU-state test, then the SSE2 path. So `_CIacos` likely reaches the same algorithm as `_libm_sse2_acos_precise`; I decoded only the entry [I]. |
| `floor`, `ceil` | Test CPU level and use `roundsd` if available. Exact either way. |

**The reference isn't one fixed thing.** GO imports math through `api-ms-win-crt-math-l1-1-0.dll` and doesn't ship `ucrtbase.dll` next to the exe [B]. Results therefore come from whatever UCRT the player's Windows has. If two Windows versions differ in the last bit, GO players could already be exposed. x87 `fsin`, `fcos` and `fpatan` can also differ by CPU vendor in low bits [I]. Neither is measured (experiment 5).

### 6.3 wasm32 differences

| Topic | Windows x86 | wasm32 | What Route A must do |
|---|---|---|---|
| Float to int | `cvttss2si`: 0x80000000 for NaN and out of range | `trunc` traps. `trunc_sat` gives 0, INT_MAX or INT_MIN. | Route every simulation conversion through a helper with x86's result. A flag can't do this [I]. |
| Float to unsigned | Through `long long` | Traps or saturates | Same, per `/fpcvt:BC` |
| `lroundf` | Returns 0 on invalid, 32-bit `long` | musl differs [I] | Own implementation with the UCRT contract |
| NaN bits | Default NaN is 0xFFC00000 | Spec leaves the sign and payload nondeterministic. Likely follows the host CPU [I]. | Canonicalize before any bit read: `fast_float_*` (`BaseType.h:186,200,209`), `Fast_Is_Float_Positive` (`wwmath.h:193`), `Float_To_Int_*`, and CRC of raw floats. **Must test ARM64 browsers.** |
| `FLT_EVAL_METHOD` | Nominally SSE, plus the x87 sites | 0 | Nothing beyond §6.1 |
| Denormals | MXCSR has no FTZ or DAZ, reset every frame | Preserved | Nothing, except the x87 denormal double rounding in §6.1. Debris spin decays into this range [R]. |
| Double to float | `cvtsd2ss`, nearest | `f32.demote_f64`, nearest | Identical. |
| FMA contraction | None under `/fp:precise` [R] | `-ffp-contract=off` | Set it |
| Fast math | Absent | Must stay absent | No `-ffast-math` |
| C++ overloads | `sin(float)` means `(float)sin((double)x)` | Resolves to true `sinf` | Provide `sinf`, `cosf`, `tanf`, `asinf`, `acosf`, `atanf`, `atan2f` with "double, round once" semantics [R]. |
| Compiler-made calls | n/a | Clang merged `sin` plus `cos` into `sincosf` on Android [R] | Check the final import list, not the source |
| Compile-time folding | n/a | Clang can fold math with host libm [I] | `-fno-builtin` for those functions |
| UB assumptions | MSVC doesn't use type-based aliasing and lets signed overflow wrap | Clang assumes both are forbidden | `-fno-strict-aliasing -fwrapv -fno-delete-null-pointer-checks`. Clang changed code in 276 of 441 files with these [R]. |
| `long` | 32 bits | 32 bits | Fine, and better than Android's 64 |
| `wchar_t` | 2 bytes | 4 bytes | Not math, but replays and network strings need care |

### 6.4 What matching takes

| Item | Method | Can it be proven? |
|---|---|---|
| `sin`, `cos`, `asin`, `acos` (one float argument, through double) | Software double-then-round, plus an exception table against native | **Yes.** All 2^32 float inputs can be enumerated. |
| `fsin`, `fcos` for `WWMath::Sin`, `Cos` | Software, plus an exception table | **Yes**, enumerable. Reported agreement with `(float)sin((double)x)`: 0 differences on 62,801 and 20M angles [R]. Another test saw about 25% difference from CRT `sinf` on a 10M corpus [R]. Those can both be true if that corpus used a wider range or a different comparison [I]. Measure on game-range inputs, per CPU. |
| `fsqrt`, `sqrtsd` | `f32.sqrt`, `f64.sqrt` | Measured equal on 2^31 non-negative encodings [R]. Enumerate again, including NaN results. |
| `Inv_Sqrt` | Same algorithm in float, in the same order | **Yes**, enumerable. 6,918,440 inputs, 0 differences [R]. |
| `pow(x, 2.0)` | `(double)x * (double)x` | Enumerable for float `x`. Differences: 0 on modern MSVC [R]. |
| `atan2` | Double-double or similar accuracy, rounded once | **Not by enumeration:** 2^64 pairs. See below. |
| x87 double sites | List from compiler listings, emulate with explicit float rounding at the source | Only for one given build |
| x87 float out of normal range | Instrument and measure. Emulate if it ever occurs. | Measured per replay |
| Conversions, NaN bits | Helpers (§6.3), sanitizer audit | Measured per replay |

**`atan2` residual risk** [I, not measured]: `fpatan` is specified to about 1 ulp of 64-bit precision. Rounded to float, an exact implementation can only disagree when the true value lies within about 1 extended ulp of a float midpoint, a window of about 2^-39 per call. The PR's profile on a 60 Hz fork measured 633 to 733 `atan2` calls per logic frame [R]. At that rate, one game hour makes about 1.6×10^8 calls, for an expected worst case near 3×10^-4 disagreements per game hour. This assumes the full error bound and uniform values. Real error is likely smaller.

The Android port measured something related: 52,824 libm calls in 100 frames, and all of a 5,200-frame window, with zero within 4 double ulps of a float midpoint [R].

**Exact-match by copying UCRT code:** translating `ucrtbase` SSE2 routines to wasm would be bit-exact by construction, but that is Microsoft's proprietary code and tables. Treat it as a legal question and not as an engineering shortcut.

### 6.5 External evidence, and its limits

The closest precedent is `MYSOREZ/GeneralsZH-Android-Port`, an IEEE-only ARM64 client with no x87, documented in its `LESSON-cross-play-desync-method.md`. It reports [R, not reproduced]:

- **PC recordings from GO clients matched:** `USA.rep` all 308 checkpoints, `Global_War.rep` all 811, and `Global_War2.rep`, every faction and superweapon, 194,600 frames and **all 1,946 checkpoints** (24/09/2026).
- "None of them was floating point" for its last batch of divergences. Earlier ones were the x87 `Inv_Sqrt`, `Float_To_Long`, true-`sinf` overloads, NaN casts and `lroundf`.
- **Those were against older GO builds.** Build `100126` changed the CRC shape again and every live match failed at frame 100 until it was fixed. The same shape change is visible here: the shipped exe has no `OfficialLogicCRCRevision` string [B], and that port's notes say builds from 22-28/09 did.
- **Status 18/10/2026: "cross-play with the PC client is turned off at the GeneralsOnline developers' request."**

Parts of this I could check. Its description of the exe holds on the installed build: linker 14.51, `_libm_sse2_*_precise`, `_CIatan2`, `_ftol`, and exactly 212 `Inv_Sqrt` sites [B]. Its statement that the client is "VC6" elsewhere in the same notes is wrong for this build.

**That last status line is a non-technical blocker.** Technical success doesn't confer permission. A web client can't honestly present a Windows exe CRC. See `docs/NETWORK.md`. The owner should decide how to approach the GO developers before matching their client in live play.

### 6.6 Verdict

**Route A is feasible but unproven, at medium confidence. The plan needs to grow beyond "strict IEEE plus replacement CRT functions."**

Reasons for feasibility:

- Most of the x87 surface collapses to IEEE float semantics under `_PC_24`.
- The transcendental set the simulation actually uses is small: `sin`, `cos`, `asin`, `acos`, `atan2`, and `pow` only with exponent 2. All but `atan2` can be proven by enumeration.
- The x86 UCRT has no FMA3 dispatch.
- An IEEE-only client has reportedly passed long GO recordings.

Reasons it is only medium:

- **Nothing is measured on this build.** No compiler has run.
- **Source parity with the shipped client is unsolved.** Public source is behind the current release, and the toolset differs.
- **Double-typed x87 sites are unattributed.**
- **It recurs.** Each GO release can change x87 site choices, and CRC shape as well. Route A means re-verifying every release, without upstream help.
- **ARM browsers** add a NaN-bit problem that the Windows reference doesn't have, and Windows version and CPU vendor spread is unknown.

**Risks, most serious first:**

1. Exact source of the shipped client
2. GO's position on third-party clients and exe CRC
3. Non-math divergence from wasm differences (`wchar_t`, enum numbering, uninitialized reads) [R]
4. Unattributed x87 double sites
5. NaN and conversion behaviour in real games
6. `atan2` residual

Route B remains the better long-term outcome, but it depends entirely on GO, and there's no sign of it yet.

## Measurements needed once the native build exists

Do 1 and 2 first. They can stop Route A before any wasm work.

1. **Baseline the reference.** Record new GO matches on the current client, then run the shipped exe with `-headless -replay <rep>`, without `-exportStats`. Capture stdout and exit code. Only replays that pass enter the reference set. Note the exe CRC and build-time string in each header.
2. **Source parity.** Build 6ff4044 with `win32-vcpkg`, on MSVC 14.51.36257 if obtainable, and replay the reference set. Pass means public source reproduces the release. A failure at the first checkpoint points at CRC shape (compare with `MARKER:` strings in the exe). A later failure points at the unpublished changes. Diff `getCRC` against the shipped exe, and ask GO for the QFE6 source.
3. **Attribute x87.** Build with `/FAcs`. For each simulation TU, list x87 arithmetic, separated into float and double operands, and whether a CRT extended result is consumed without a store. Compare totals with this document's census to judge how close the toolset is.
4. **Exhaust one-argument math.** On native, under `setFPMode`, run all 2^32 float inputs through `(float)sin`, `(float)cos`, `(float)asin`, `(float)acos`, `fsin`, `fcos`, `fsqrt`, `Inv_Sqrt`, `pow(x,2.0)`, `lroundf`, `(Int)`, and `(UnsignedInt)`. Save a hash per function. Compare with the wasm implementation and produce exception tables. Record the run time, since none is known yet.
5. **Spread of the reference.** Repeat 4 on at least one Intel and one AMD CPU, and on Windows 10 22H2 and current Windows 11, recording each `ucrtbase.dll` version. Any difference means GO itself isn't uniform, which sets the bar for Route A.
6. **`atan2`.** Log real `(y, x)` pairs from the simulation during replay. Compare `_CIatan2` stored to float with a high-precision reference (MPFR or similar) over those pairs and over a large random set. Report mismatches, and how many fall inside the fragile window.
7. **Check `pow`.** Confirm that every simulation `pow` call has exponent 2 at run time, and that the UCRT's result equals exact double multiplication on each Windows version from 5.
8. **x87 range edges.** Using the sites from 3, instrument native to detect x87 results outside the normal float range during replays. Read `_statusfp` per frame and attribute underflow and overflow by module.
9. **FPU state assertions.** In the native build, assert control word 0x007F and MXCSR 0x1F80 at the end of each logic frame and at subsystem boundaries, with real rendering, Miles and EOS present. Also check that no exception mask changes inside a frame, because that would change the CRT's algorithm.
10. **Conversion audit.** Build wasm or native Clang with `-fsanitize=float-cast-overflow -fsanitize-recover=float-cast-overflow`, replay the reference set, and list each NaN or out-of-range conversion by file and line. Every simulation hit needs the helper. Do the same for out-of-range `lroundf`.
11. **NaN bits.** Log whether any hashed float is NaN, and whether a sign-bit read ever sees one. Then run the same wasm build on x64 and ARM64 browsers and compare per-frame CRCs.
12. **Wasm build verification.** Confirm the module imports and links no `sinf`, `sincosf`, `exp2f` or similar from musl for simulation code, and that `-ffp-contract=off` and the UB flags reach every simulation TU. Read this from `wasm-objdump` output and `compile_commands.json`, not from the build scripts.
13. **Wasm against the reference.** Replay the reference set in the wasm build. On a mismatch, narrow it with a per-frame copy of the replay (`C=001`, a method the Android port documents), then compare per-object CRC. One mismatch on this set fails, per §5. Cover Chrome on x64 and ARM64, the only browser in scope.
14. **Live lockstep.** Only after 13 passes, and only with GO's agreement: a private match between the wasm client and native clients, long enough to cover the fragile cases, on the 60 Hz server.
15. **Controls.** Run native GO on the retail corpus and record the first mismatch frame, as a negative control that shows the harness detects failure. Separately, confirm a VC6 TheSuperHackers build passes it, as a positive control for the corpus itself.

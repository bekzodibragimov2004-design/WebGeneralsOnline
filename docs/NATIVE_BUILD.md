# Native Windows build and floating-point measurements

Reference notes for the native Generals Online Zero Hour client (GeneralsMD), built from this
repo on 2026-11-03. The web build will not play native Windows clients, so these numbers are
for debugging behaviour and screenshot comparison, not for matching CRCs. The game was not
run and no game data was touched.

## Result

| | |
|---|---|
| Built | Yes, exit 0, no source/CMake/preset changes |
| Preset | `win32-vcpkg` (Ninja Multi-Config, Release), triplet `x86-windows-static-md` |
| Source | `main` at `a8606c9b2` (untracked `web/` and `tools/ingest-assets/` not involved) |
| Executable | `build/win32-vcpkg/GeneralsMD/Release/GeneralsOnlineZH.exe` |
| Size | 14,419,456 bytes; PDB 131,526,656 bytes |
| SHA-256 | `df2cf6e134ee0cb4e43ae9397fe2f0541580c8e143e425bd5d1a38d592614477` |
| Format | PE32, machine x86 (0x14C), linker 14.44, GUI subsystem, DYNAMICBASE, NXCOMPAT, CFG |
| Also produced | `crashpad_handler.exe`, `discord-rpc.dll` next to the exe |
| Toolchain | MSVC 14.44.35207 (cl 19.44.35229, `Hostx64\x86`), Windows SDK 10.0.26100.0, CMake 4.4.4, Ninja 1.13.2, vcpkg 2026-10-29 |

Time (12-core machine, other builds sharing the CPU):

| Step | Wall time |
|---|---|
| `cmake --preset` incl. vcpkg install (20 packages, cold cache, from source) | 1 h 33 min (03:11 to 04:44) |
| `cmake --build --preset` (1123 ninja steps) | 2 min 43 s |
| Total | about 1 h 36 min |

The vcpkg step dominates: openssl alone took 49 min and ffmpeg 19 min, then abseil, protobuf
and GameNetworkingSockets. A warm vcpkg binary cache makes configure take seconds.

## Reproduce from a clean machine

Prerequisites: Visual Studio 2022 Build Tools (MSVC v143 x86/x64 tools, Windows 10/11 SDK),
CMake 3.25 or newer, Ninja, git, and a bootstrapped vcpkg clone with full history (the
manifest baseline `b61d330` must exist in it). Network access is needed: vcpkg fetches
sources from GitHub (including the `tintinhamans/GNS` registry), plus nasm.us, qt.io (jom) and
a portable Strawberry Perl for openssl.

```bat
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x86 -host_arch=x64
set "VCPKG_ROOT=<path to vcpkg clone>"
set "VCPKG_FEATURE_FLAGS=manifests,versions,binarycaching"
set "VCPKG_BINARY_SOURCES=clear;files,<binary cache dir>,readwrite"
cd /d <repo root>
cmake --preset win32-vcpkg -DRTS_BUILD_ZEROHOUR=ON -DRTS_BUILD_GENERALS=OFF ^
  -DRTS_BUILD_CORE_TOOLS=OFF -DRTS_BUILD_ZEROHOUR_TOOLS=OFF ^
  -DRTS_BUILD_CORE_EXTRAS=OFF -DRTS_BUILD_ZEROHOUR_EXTRAS=OFF
cmake --build --preset win32-vcpkg
```

This follows `.github/workflows/build-toolchain.yml` (same preset, same
`RTS_BUILD_ZEROHOUR` / `RTS_BUILD_GENERALS` switches, same two commands). The only difference
from CI's `win32-vcpkg` job is that CI also passes `RTS_BUILD_CORE_EXTRAS=ON` and
`RTS_BUILD_ZEROHOUR_EXTRAS=ON`; they are off here because the extras are not needed for the
game exe and do not change its compile flags. The build directory is the preset's
`build/win32-vcpkg` (ignored by git via `/build*`). Put `ninja.exe` and `cmake.exe` on PATH
after VsDevCmd; the Build Tools' bundled copies also work.

## Measurements

### a. Effective compile flags (from `compile_commands.json`, Release)

`Locomotor.cpp` and `PartitionManager.cpp` (GameLogic) have the same flags:

```
cl.exe /nologo /TP -D<defs: GENERALS_ONLINE, RTS_ZEROHOUR=1, RTS_RELEASE, NDEBUG, ...>
  /DWIN32 /D_WINDOWS /EHsc /O2 /Ob2 /DNDEBUG -std:c++20 -MD -Z7 /MP /Zc:__cplusplus
  /guard:cf /W3 /Yu<cmake_pch.hxx> /FI<cmake_pch.hxx> /FS -c <file>
```

| Item | Value |
|---|---|
| `/arch` | none on the command line. Compiler default for x86 is SSE2: with these flags `_M_IX86_FP` is 2 |
| `/fp` | none on the command line. Default is precise: no `_M_FP_*` macro is defined, and a test file compiled with and without `/fp:precise` gives identical assembly (`/fp:fast` differs) |
| Optimization | `/O2 /Ob2` (implies `/Oi` intrinsics, `/Ot`, `/Gy`), `/DNDEBUG` |
| `/GL` and `/LTCG` | not used (objects are plain COFF, link has no `/LTCG`) |
| CRT | `/MD` (`_DLL` defined), dynamic |
| C++ standard | `-std:c++20` (`_MSVC_LANG` 202002) |
| Debug info | `-Z7` (embedded), link with `/DEBUG /OPT:REF /OPT:ICF /INCREMENTAL:NO` |
| Other | `/guard:cf`, `/SAFESEH:NO`, `/MANIFEST:NO`, `/NODEFAULTLIB:libci.lib`, `/DELAYLOAD` of four msvcp140_* DLLs |

Across all 1,098 Release compile entries, none contains `/arch`, `/fp`, `/GL` or `/Gw`.
`cmake/config-build.cmake` adds `/Ob3 /Ot /Gy /Gw /GL /arch:SSE2` and `/LTCG` only for
`RTS_BUILD_OPTION_OPTIMIZED` (preset `win32-vcpkg-optimized`) and `/GL` for the PGO presets.
That was read from the CMake, not built.

### b. Instruction mix

Method: `dumpbin /disasm` on the exe and on objects, and for the simulation sources an exact
count from `cl /FA` listings (the exact Release compile commands re-run with `/FA`, outputs
sent outside the build tree). For the three objects checked (Locomotor, PartitionManager,
matrix3d) the dumpbin x87 and SSE-scalar counts equal the `/FA` counts, so data-as-code noise
did not show up in those columns. "SSE scalar" counts ss/sd arithmetic, moves, compares and
conversions; "SSE packed" counts ps/pd operations and moves.

**Whole exe** (linear disassembly, 3,300,001 instructions): x87 **17,743**, SSE scalar
**82,149**, SSE packed 38,859, SSE integer 24,440, AVX 1,712, FMA **0**. Attributed to
libraries with a link map (a relink with `/MAP` into the scratch area; its `.text` is
byte-identical to the shipped exe, and all 38,849 function labels matched a map symbol):

| Origin | x87 | SSE scalar | SSE packed | AVX |
|---|---|---|---|---|
| First-party (z_gameengine 2,778, z_gameenginedevice 2,447, ww3d2 1,918, wwmath 767, rest ~3) | 7,913 | 80,539 | 25,599 | 13 |
| d3dx8 (prebuilt DirectX 8 static lib) | 7,288 | 389 | 1,419 | 0 |
| vcpkg libraries (libcrypto 2,146, sentry 129, protobuf 78, others) | 2,442 | 1,159 | 11,499 | 1,400 |
| GameSpy, zlib, CRT stubs, exe objects | about 100 | about 60 | about 290 | 299 |

So first-party code is about 10 SSE-scalar instructions per x87 instruction. The CRT's 299
AVX instructions are in the statically linked float-to-int helpers (see c).

**Simulation sources, exact (`/FA`, 298 files, before dedup/stripping):**

| Group | Files | Files with x87 | Instructions | x87 | SSE scalar | SSE packed |
|---|---|---|---|---|---|---|
| GeneralsMD `Source/GameLogic` | 253 | 137 | 813,814 | 3,788 | 30,341 | 8,374 |
| Core `GameEngine/Source/GameLogic` (incl. AIPathfind) | 7 | 2 | 50,027 | 115 | 2,390 | 529 |
| WWMath | 35 | 26 | 63,220 | 2,282 | 19,507 | 2,842 |
| Total (plus 3 device files) | 298 | 167 | 931,547 | 6,197 | 52,342 | 11,776 |

AVX and FMA are 0 in every one of these.

| Object | Instructions | x87 | SSE scalar | SSE packed |
|---|---|---|---|---|
| `Locomotor.cpp` | 12,949 | 332 | 2,290 | 446 |
| `PartitionManager.cpp` | 23,652 | 212 | 1,977 | 371 |
| `PhysicsUpdate.cpp` | 6,297 | 75 | 1,478 | 380 |
| `AIPathfind.cpp` | 31,577 | 54 | 2,183 | 445 |
| `SimulationMathCrc.cpp` | 535 | 61 | 154 | 38 |
| WWMath `matrix3d.cpp` | 2,927 | 114 | 1,748 | 380 |

x87 mnemonics in those listings: fld 2,165, fstp 1,533, fmul 992, fmulp 374, fxch 372,
fsub 268, fsubp 126, fadd 117, fsqrt 50, fldz 46, faddp 40, fsin 31, fcos 23, others fewer.
There is no `fpatan`, `fyl2x`, `fptan` or `fistp` in them.

**Why simulation functions still use x87.** 1,516 functions in the listings contain x87.
Two causes, both visible in the listings:

1. Hand-written x87 inline assembly in `Core/Libraries/Source/WWVegas/WWMath/wwmath.h`
   (`#if defined(_MSC_VER) && defined(_M_IX86)`): `WWMath::Inv_Sqrt` (fast reciprocal sqrt,
   magic constant `0be6eb508h`, 22 x87 instructions, 124 copies across the listings),
   `WWMath::Sin` (`fsin`), `WWMath::Cos` (`fcos`) and `WWMath::Sqrt` (`fsqrt`). 147 functions
   contain one of these templates, holding 3,035 of the 6,197 x87 instructions. `Inv_Sqrt`
   is reached through `Vector3::Normalize`. Largest GameLogic cases:
   `tryToRotateVector3D` and `calcDirectionToApplyThrust` (Locomotor.cpp),
   `ParticleUplinkCannonUpdate::update`, `DumbProjectileBehavior::update` and
   `::calcFlightPath` (also `fsqrt`), `MissileAIUpdate::projectileFireAtObjectOrPosition`,
   `NeutronMissileUpdate::calcTransform` and `::doAttack`, `WeaponTemplate::dealDamageInternal`,
   `CountermeasuresBehavior::launchVolley` (also `fsin`/`fcos`), `PhysicsBehavior::update`.
   In WWMath: the collision contact-normal code (`colmath*.cpp`), `quat.cpp`, `euler.cpp`,
   `vehiclecurve.cpp`, `obbox.cpp`.
2. The x86 calling convention returns `float` in ST(0). In the other 1,369 functions
   (3,162 x87 instructions) the x87 is `fld`/`fstp`/`fldz`/`fld1` around calls and returns
   (2,692 of them) plus 470 arithmetic instructions that use a just-returned value directly,
   for example `call GeometryInfo::getMaxHeightAbovePosition` then `fadd [mem]`, `fstp`
   (PartitionManager.cpp), or `return 0.0f` compiled as `fldz` (Locomotor.cpp).

The game also sets the x87 control word in `setFPMode()` (`GameLogic.cpp`: `_fpreset`, then
`_controlfp` with `_PC_24` and round-to-nearest). That was read from the source, not measured.
It affects only the x87 paths above; SSE code ignores precision control.

### c. CRT math entry points

The UCRT is linked **dynamically**. The exe imports 14 `api-ms-win-crt-*-l1-1-0.dll` API sets
(heap, math, runtime, stdio, string, time, convert, locale, filesystem, multibyte, utility,
process, environment, plus `api-ms-win-core-synch`) and `VCRUNTIME140.dll` and `MSVCP140.dll`.
The API sets forward to `ucrtbase.dll`; the 32-bit `ucrtbase.dll` on the build machine
(SysWOW64, 10.0.26100.9711) exports all 33 names below. Results therefore depend on the
installed `ucrtbase.dll`, not on code in the exe.

`api-ms-win-crt-math-l1-1-0.dll` imports (33): `_libm_sse2_{sin,cos,tan,asin,acos,atan,
log,log10,exp,pow,sqrt}_precise`, `_CIatan2`, `_CIacos`, `_CIfmod`, `_ftol`, `floor`, `ceil`,
`round`, `roundf`, `lroundf`, `ldexp`, `frexp`, `nan`, `_finite`, `_isnan`, `_dclass`,
`_fdclass`, `_ldclass`, `_dsign`, `_fdsign`, `_ldsign`, `_fdopen`, `__setusermatherr`.
There is no `_libm_sse2_atan2`, `_CIsin`, `_CIcos`, `_CIpow`, `_CIsqrt`, `_CIexp` or
`_CIlog` import; `sinf`/`cosf`/`powf` etc. compile to the `_libm_sse2_*_precise` calls.

Direct call sites to math helpers, counted two ways. "Sim sources" is the 298 `/FA` listings
(before linker dedup), "whole exe" is the linked disassembly:

| Target | Sim sources | Whole exe | Notes |
|---|---|---|---|
| `__libm_sse2_sqrt_precise` | 432 (59 files) | 286 | `sqrtf`/`sqrt` |
| `__libm_sse2_sin_precise` / `_cos_` | 101 / 95 | 124 / 125 | AIGroup, FloatUpdate, matrix3d, wwmath.cpp, ... |
| `__libm_sse2_pow_precise` | 14 | 26 | PartitionManager.cpp, vp.cpp |
| `__libm_sse2_acos_` / `asin_` | 12 / 6 | 11 / 6 | quat.cpp, vehiclecurve.cpp, wwmath.cpp |
| `__libm_sse2_tan/atan/exp/log/log10_precise` | 3 each | 13 / 2 / 2 / 9 / 4 | in the sim sources only `SimulationMathCrc.cpp` (not linked, see below); the exe's calls come from other code |
| `__CIatan2` | 66 (14 files) | 28 | x87-stack-argument form; PhysicsUpdate, Locomotor, JetAIUpdate, matrix3d, euler, vehiclecurve, ... |
| `__CIsinh` / `__CIcosh` / `__CItanh` | 3 each | not found | only `SimulationMathCrc.cpp` (not linked) |
| `__CIfmod`, `__CIacos` | none | 11, 2 | not in the sim sources scanned |
| `floor` / `ceil` (double) | 60 (gridcull.cpp) / 32 | 53 / 56 | direct calls |
| `__ftol3` | 54 (16 files) | 285 | float to 64-bit int, statically linked CRT helper |
| `__ftol2_sse`, `__ftol2`, `__ftol` | 7, 1, 0 | 6, 5, 2 | double to int helpers |
| `__dtol3` | none | 36 | double to 64-bit int |

`SimulationMathCrc.cpp` is not in the linked exe: its name appears 0 times in the link map and
in the disassembly, so `/OPT:REF` dropped it (nothing in the shipped build references it). That
is why `__CIsinh`, `__CIcosh`, `__CItanh` and the single `tan`/`atan`/`exp`/`log`/`log10` sites
exist only in the object listings. In that file the targets are `tanf`, `atanf`, `expf`,
`logf`, `log10f` to the matching `__libm_sse2_*_precise`, `atan2f` to `__CIatan2` and
`sinhf`, `coshf`, `tanhf` to `__CIsinh`, `__CIcosh`, `__CItanh`.

No call to `_CIsin`, `_CIcos` or `__libm_sse2_atan2` appears in the exe or the listings.
Each `__libm_sse2_*` / `__CI*` name in the exe is a one-instruction thunk
(`jmp dword ptr [__imp_...]`) into the import table.

`__ftol3` and the matching `__dtoul3` (statically linked from the CRT, 299 AVX instructions in
total) dispatch at run time on `___isa_inverted` bit 0x20: on CPUs with AVX-512DQ they use
`vcvttps2qq` / `vcvttpd2uqq`, otherwise a scalar `cvttss2si` plus integer-shift path. Both
paths truncate toward zero. The exe contains 39 reads of `___isa_available`, 19 of
`___isa_inverted`, 2 of `___favor` (CRT memory and conversion helpers).

### d. FMA3

No reference. The exe, its link map and its import table contain no `_set_FMA3_enable`,
`__use_fma3_lib` or other `fma3` symbol, and there is no FMA instruction (`vfmadd*` etc.) in
the exe or in any of the 298 simulation listings. The system 32-bit `ucrtbase.dll` (the library
the math thunks resolve into) does not export `_set_FMA3_enable`; it contains 3 FMA
instructions in total, which sit inside the explicit `fma`, `fmaf` and `fmal` functions. I did
not trace the `_libm_sse2_*_precise` internals beyond that.

## Caveats

- Counts are static instruction counts, not execution counts.
- Whole-exe numbers come from a linear disassembly and can include data-as-code noise
  (d3dx8's 3DNow! code, jump tables). They agreed exactly with `/FA` for the three objects
  checked. One 118,992-instruction tail attributed to `volatileaccessu` has zero FP instructions
  and is an unattributed end-of-section stretch.
- The 298-file `/FA` set covers GameLogic and WWMath only, not Common, GameClient or the
  W3D device code.
- The build directory contains `GeneralsMD/Relink_/` (a same-length-path relink used to get a
  link map). It is not the shipped exe and can be deleted.

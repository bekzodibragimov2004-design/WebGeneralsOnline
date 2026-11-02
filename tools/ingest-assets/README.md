# ingest-assets

Copies the files the game needs from an owner-supplied Generals / Zero Hour install into a
server-side asset directory outside the repo, and writes `manifest.json` (format in
`docs/WEB_CONTRACT.md`). No dependencies. Node 22 or newer.

```
node tools/ingest-assets/ingest.mjs --game-dir <path> --out <dir> [--generals-dir <path>] [--version <string>] [--dry-run]
```

- `--game-dir` is the Zero Hour folder (the one the game runs from). If omitted, `GAME_DIR` is read
  from the `.env` at the repo root, and only that one value is printed. There is no default path.
- `--generals-dir` is the base Generals folder. See "What the game needs".
- `--out` must be outside the git repo, and must not overlap either game folder. It must be empty
  or an earlier output of this tool (it holds a `.wgo-asset-dir` marker or a `manifest.json`),
  because everything in it that is not in the manifest is deleted.
- `--version` defaults to the first 16 hex characters of a SHA-256 over the sorted
  `path, size, sha256` of every file, so it changes only when content changes.
- `--dry-run` hashes and compares but writes nothing, not even `--out`.

Run it with the same flags every time: a run without `--generals-dir` removes the `Generals/`
files an earlier run put in `--out`.

## How it copies

A file is skipped when its size and streaming SHA-256 already match. Otherwise it is streamed to
`<name>.wgo-tmp-*` next to its final name, flushed, and renamed into place, so an interruption never
leaves a partial file at a real name. Leftover temp files are removed on the next run. Files that
are not part of the new manifest are removed and reported. The manifest is written last, atomically,
and is byte-identical for identical input apart from `generatedAt`. Do not run two copies at once.

## What the game needs (from the engine source)

The decisions and the source line behind each are in `rules.mjs`.

- **Archives.** `Win32BIGFileSystem::init` loads every `*.big` below the working folder, recursively
  (`Win32BIGFileSystem.cpp:60`, `:243-246`). Among duplicate files the alphabetically first archive
  wins, so names and sub-folders are kept as they are.
- **Base Generals files are needed too.** For Zero Hour builds, `init` then loads every `*.big` from
  the base Generals `InstallPath` (`Win32BIGFileSystem.cpp:62-70`, registry key in `registry.cpp:122-134`).
  Only archives are read from there, so only `*.big` is taken from `--generals-dir`, and it is stored under
  `Generals/` in the asset directory and the manifest. Zero Hour and Generals archives never collide
  that way. If both games are installed into one folder, pass just `--game-dir`.
- **Loose files.** `FileSystem::openFile` tries the disk before the archives (`FileSystem.cpp:175-216`),
  so loose `Data/`, `Art/`, `Maps/`, `Window/` and `GeneralsOnlineGameData/` files under the Zero Hour
  folder are copied if present. Most installs have none.
- **Left out.** `*.bik` and the movie folders (cinematics are out of scope), `*.exe`, `*.dll`, `*.msi`,
  `*.cab`, `Install_Final.bmp`, and everything else not listed above.
- **`Data/INI/INIZH.big` is excluded on purpose.** Some SKUs ship a second copy there; the engine
  skips it to avoid CRC mismatches (`Win32BIGFileSystem.cpp:251-259`). The copy in the folder root is the real one.

Things to know:

- Every `*.big` in the install folder is loaded by the engine, mods and patches included, and so is
  ingested here. Use a clean install if multiplayer compatibility matters.
- The Generals Online community patch (`500_900_CommunityPatch_CoreINI.big`) is read from the
  user-data folder (`<UserData>/GeneralsOnlineGameData/`, `ArchiveFileSystem.cpp:241`), not from the
  game folder, so this tool does not see it. How the web build gets it is still open.
- Symbolic links and junctions are not followed. Paths that differ only by case are an error.

## Tests

```
node --test "tools/ingest-assets/*.test.mjs"
```

They build small synthetic trees under `os.tmpdir()`, including a hard-killed child process for
the interruption case, and never touch a real install or the real `.env`.

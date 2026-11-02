// Which files of an owner-supplied install the web build needs, worked out from the
// engine source in this repo. Paths are relative to an install root, use forward
// slashes and match case-insensitively (the engine treats game paths that way).
//
// Two roots exist because Zero Hour is not standalone. Win32BIGFileSystem.cpp:60 loads
// every *.big under the Zero Hour folder, and for Zero Hour builds lines 62-70 then load
// every *.big under the base Generals InstallPath as well:
//   ROOT_ZERO_HOUR  the folder the game runs from (--game-dir)
//   ROOT_GENERALS   the base Generals folder (--generals-dir), archives only
//
// Explicit excludes are checked first and always win. A file that no include rule
// matches is simply not needed. Source references below are relative to the repo root.

export const ROOT_ZERO_HOUR = 'zerohour';
export const ROOT_GENERALS = 'generals';

// Base Generals archives are stored under this folder, in the asset directory and in the
// manifest, so they can never collide with a Zero Hour file of the same name.
export const GENERALS_PREFIX = 'Generals';

export const EXCLUDE_RULES = [
  {
    id: 'bink-video',
    pattern: '**/*.bik',
    why: 'Bink movies: cinematics are out of scope.',
    source: 'Core/GameEngineDevice/Source/VideoDevice/FFmpeg/FFmpegVideoPlayer.cpp:67 and Bink/BinkVideoPlayer.cpp:67 (VIDEO_EXT "bik" is the only video type the engine plays)',
  },
  {
    id: 'movie-folders',
    pattern: 'Data/Movies/**',
    why: 'Movie folder, cinematics are out of scope.',
    source: 'Core/GameEngineDevice/Source/VideoDevice/FFmpeg/FFmpegVideoPlayer.cpp:65-66 (VIDEO_PATH "Data\\Movies")',
  },
  {
    id: 'localized-movie-folders',
    pattern: 'Data/*/Movies/**',
    why: 'Localized movie folder, cinematics are out of scope.',
    source: 'Core/GameEngineDevice/Source/VideoDevice/FFmpeg/FFmpegVideoPlayer.cpp:65 (VIDEO_LANG_PATH_FORMAT "Data/%s/Movies/%s.%s")',
  },
  {
    id: 'duplicate-inizh',
    pattern: '**/Data/INI/INIZH.big',
    why: 'Second copy of INIZH.big that the engine refuses to load (it would cause CRC mismatches). The copy in the folder root is the real one.',
    source: 'Core/GameEngineDevice/Source/Win32Device/Common/Win32BIGFileSystem.cpp:251-259 (same in StdDevice/Common/StdBIGFileSystem.cpp:219-227)',
  },
  {
    id: 'executables',
    pattern: '**/*.exe',
    why: 'Game executables and installers: the engine is ours.',
    source: 'GeneralsMD/Code/Main/WinMain.cpp:929-934 (the engine runs from its own executable and loads data relative to it)',
  },
  {
    id: 'libraries',
    pattern: '**/*.dll',
    why: 'Native libraries: the engine is ours.',
    source: 'GeneralsMD/Code/Main/VCRuntimeCheck.cpp:38-47 (DLLs are runtime code, never read through the game file system)',
  },
  {
    id: 'installer-packages',
    pattern: '**/*.msi',
    why: 'Installer package.',
    source: 'GeneralsMD/Code/Main/WinMain.cpp:957-972 (Install_Final.bmp is the only installer artifact the engine touches)',
  },
  {
    id: 'installer-cabinets',
    pattern: '**/*.cab',
    why: 'Installer cabinet.',
    source: 'GeneralsMD/Code/Main/WinMain.cpp:957-972 (nothing in the engine reads cabinets)',
  },
  {
    id: 'install-splash',
    pattern: '**/Install_Final.bmp',
    why: 'Splash bitmap for the Windows launcher window, which the web build does not have.',
    source: 'GeneralsMD/Code/Main/WinMain.cpp:957-972',
  },
];

export const INCLUDE_RULES = [
  {
    id: 'archives',
    pattern: '**/*.big',
    roots: [ROOT_ZERO_HOUR, ROOT_GENERALS],
    why: 'Archives at any depth, from both roots. The engine scans for *.big recursively, and the scan order decides which archive wins, so names and folders are kept as they are. Zero Hour loads only *.big from the Generals folder, so nothing else is taken from that root.',
    source: 'Core/GameEngineDevice/Source/Win32Device/Common/Win32BIGFileSystem.cpp:60 (loadBigFilesFromDirectory("", "*.big")), :243-246 (searchSubdirectories is TRUE), :62-70 (#if RTS_ZEROHOUR: loadBigFilesFromDirectory(installPath, "*.big") for base Generals); Win32LocalFileSystem.cpp:158-183 (the recursion); GeneralsMD/Code/GameEngine/Source/Common/System/registry.cpp:122-134 (InstallPath under SOFTWARE\\Electronic Arts\\EA Games\\Generals); Core/GameEngine/Source/Common/System/ArchiveFileSystem.cpp:172 (the alphabetically first archive wins)',
  },
  {
    id: 'loose-data',
    pattern: 'Data/**',
    roots: [ROOT_ZERO_HOUR],
    why: 'Loose INI, scripts, strings, audio and localized art. The file system tries the disk before the archives, so loose files override archived ones.',
    source: 'Core/GameEngine/Source/Common/System/FileSystem.cpp:175-216 (local file system first, then archives); GeneralsMD/Code/GameEngine/Source/Common/GameEngine.cpp:518-710 (Data\\INI\\*); GeneralsMD/Code/GameEngine/Source/Common/GlobalData.cpp:1416 and :1427 (Data\\Scripts\\*.scb); Core/GameEngine/Source/GameClient/GameText.cpp:290 with GeneralsMD/Code/Main/WinMain.cpp:83 (data\\<language>\\Generals.csf); Core/GameEngine/Source/Common/Audio/GameMusic.cpp:65 (Data\\Audio\\Tracks); GeneralsMD/Code/GameEngineDevice/Source/W3DDevice/GameClient/W3DFileSystem.cpp:174 and :182 (Data/<language>/Art/W3D and Art/Textures)',
  },
  {
    id: 'loose-art',
    pattern: 'Art/**',
    roots: [ROOT_ZERO_HOUR],
    why: 'Loose models and textures, looked up before the archives.',
    source: 'Core/GameEngine/Include/Common/FileSystem.h:76-78 (W3D_DIR_PATH, TGA_DIR_PATH, TERRAIN_TGA_DIR_PATH); GeneralsMD/Code/GameEngineDevice/Source/W3DDevice/GameClient/W3DFileSystem.cpp:196-215',
  },
  {
    id: 'loose-maps',
    pattern: 'Maps/**',
    roots: [ROOT_ZERO_HOUR],
    why: 'Loose maps and MapCache.ini. The map list is built by scanning Maps through the file system.',
    source: 'Core/GameEngine/Source/GameClient/MapUtil.cpp:316-321 (MapCache.ini, getMapDir() is "Maps"), :527 and :552-557 (scan of Maps\\*.map); GeneralsMD/Code/GameEngine/Source/Common/GlobalData.cpp:1067 (Maps\\ShellMap1\\ShellMap1.map)',
  },
  {
    id: 'loose-window',
    pattern: 'Window/**',
    roots: [ROOT_ZERO_HOUR],
    why: 'Loose UI layout scripts (.wnd).',
    source: 'GeneralsMD/Code/GameEngine/Source/GameClient/GUI/GameWindowManagerScript.cpp:2705 and :2725 ("Window\\<file>")',
  },
  {
    id: 'generals-online-ui',
    pattern: 'GeneralsOnlineGameData/**',
    roots: [ROOT_ZERO_HOUR],
    why: 'Generals Online UI overrides, tried before the game archives. Only present when the Generals Online client was installed into the folder.',
    source: 'GeneralsMD/Code/GameEngine/Source/GameClient/GUI/GameWindowManagerScript.cpp:2729-2747',
  },
];

// Glob syntax: "**/" is any number of folders (including none), "**" any text, "*" any text
// except "/", "?" one character except "/". Case-insensitive.
export function globToRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
}

const compile = (rule) => ({ ...rule, regex: globToRegExp(rule.pattern) });
const excludes = EXCLUDE_RULES.map(compile);
const includes = INCLUDE_RULES.map(compile);

// Decides what happens to one file. `path` is relative to its install root.
// Returns { action: 'exclude' | 'include' | 'ignore', rule: <rule id or undefined> }.
export function classify(path, root) {
  for (const rule of excludes) {
    if (rule.regex.test(path)) return { action: 'exclude', rule: rule.id };
  }
  for (const rule of includes) {
    if (rule.roots.includes(root) && rule.regex.test(path)) return { action: 'include', rule: rule.id };
  }
  return { action: 'ignore', rule: undefined };
}

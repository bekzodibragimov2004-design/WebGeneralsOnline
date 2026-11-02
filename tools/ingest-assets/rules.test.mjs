import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXCLUDE_RULES, GENERALS_PREFIX, INCLUDE_RULES, ROOT_GENERALS, ROOT_ZERO_HOUR, classify, globToRegExp } from './rules.mjs';

const action = (path, root = ROOT_ZERO_HOUR) => classify(path, root).action;

test('glob: ** crosses folders, * and ? do not, matching ignores case', () => {
  const big = globToRegExp('**/*.big');
  assert.ok(big.test('a.big'));
  assert.ok(big.test('Data/INI/a.BIG'));
  assert.ok(!big.test('a.big.txt'));
  const data = globToRegExp('Data/**');
  assert.ok(data.test('data/INI/x.ini'));
  assert.ok(data.test('Data/x'));
  assert.ok(!data.test('Database/x'));
  assert.ok(!data.test('Other/Data/x'));
  const movies = globToRegExp('Data/*/Movies/**');
  assert.ok(movies.test('Data/English/Movies/a.bik'));
  assert.ok(!movies.test('Data/Movies/a.bik'));
  assert.ok(!movies.test('Data/A/B/Movies/a.bik'));
  assert.ok(globToRegExp('a?c').test('abc'));
  assert.ok(!globToRegExp('a?c').test('a/c'));
  assert.ok(globToRegExp('a.b+c').test('a.b+c'));
  assert.ok(!globToRegExp('a.b').test('axb'));
});

test('include: archives at any depth, from either root, in any letter case', () => {
  for (const path of ['INIZH.big', 'EnglishZH.BIG', 'Sub/Folder/Extra.big']) {
    assert.equal(action(path, ROOT_ZERO_HOUR), 'include', path);
    assert.equal(action(path, ROOT_GENERALS), 'include', path);
  }
});

test('include: loose data folders of the Zero Hour root', () => {
  for (const path of [
    'Data/INI/Object/Extra.ini',
    'data/english/generals.csf',
    'Data/Audio/Tracks/Song.mp3',
    'Art/W3D/Tank.w3d',
    'Art/Textures/Tank.tga',
    'Maps/Alpha/Alpha.map',
    'Maps/MapCache.ini',
    'Window/Menu.wnd',
    'GeneralsOnlineGameData/Menu.wnd',
  ]) {
    assert.equal(action(path), 'include', path);
  }
});

test('include: only archives are taken from the base Generals root', () => {
  assert.equal(action('Data/INI/Object/Extra.ini', ROOT_GENERALS), 'ignore');
  assert.equal(action('Art/Textures/Tank.tga', ROOT_GENERALS), 'ignore');
  assert.equal(action('Maps/Alpha/Alpha.map', ROOT_GENERALS), 'ignore');
  assert.equal(action('INI.big', ROOT_GENERALS), 'include');
});

test('exclude: Bink movies, movie folders, executables, libraries and installers', () => {
  for (const [path, rule] of [
    ['Data/Movies/Intro.bik', 'bink-video'],
    ['Data/English/Movies/Outro.BIK', 'bink-video'],
    ['loose.bik', 'bink-video'],
    ['Data/Movies/readme.txt', 'movie-folders'],
    ['Data/English/Movies/readme.txt', 'localized-movie-folders'],
    ['generals.exe', 'executables'],
    ['Data/Tools/Helper.EXE', 'executables'],
    ['binkw32.dll', 'libraries'],
    ['Data/Tools/lib.dll', 'libraries'],
    ['Support/Setup.msi', 'installer-packages'],
    ['Support/Data1.cab', 'installer-cabinets'],
    ['Install_Final.bmp', 'install-splash'],
    ['Data/English/Install_Final.bmp', 'install-splash'],
  ]) {
    assert.deepEqual(classify(path, ROOT_ZERO_HOUR), { action: 'exclude', rule }, path);
  }
});

test('exclude: the second INIZH.big that the engine skips, but not the one in the folder root', () => {
  assert.deepEqual(classify('Data/INI/INIZH.big', ROOT_ZERO_HOUR), { action: 'exclude', rule: 'duplicate-inizh' });
  assert.deepEqual(classify('data/ini/inizh.BIG', ROOT_ZERO_HOUR), { action: 'exclude', rule: 'duplicate-inizh' });
  assert.deepEqual(classify(`${GENERALS_PREFIX}/Data/INI/INIZH.big`, ROOT_ZERO_HOUR), { action: 'exclude', rule: 'duplicate-inizh' });
  assert.equal(action('INIZH.big'), 'include');
  assert.equal(action('Data/INI/Other.big'), 'include');
});

test('excludes win over includes, even inside included folders', () => {
  assert.equal(action('Data/Movies/Intro.bik'), 'exclude');
  assert.equal(action('Data/x.dll'), 'exclude');
  assert.equal(action('Maps/Alpha/tool.exe'), 'exclude');
  assert.equal(action('Dir/Archive.bik'), 'exclude');
});

test('everything else is ignored', () => {
  for (const path of ['readme.txt', 'Support/notes.pdf', 'Data.txt', 'Mss/mp3dec.asi', 'steam_appid.txt', 'Options.ini']) {
    assert.equal(action(path), 'ignore', path);
  }
});

test('every rule has an id, a pattern, a reason and a source location', () => {
  const ids = new Set();
  for (const rule of [...EXCLUDE_RULES, ...INCLUDE_RULES]) {
    assert.ok(rule.id && rule.pattern && rule.why && rule.source, rule.id);
    assert.match(rule.source, /\.(cpp|h):\d+/, `${rule.id} must cite a source line`);
    assert.ok(!ids.has(rule.id), `duplicate rule id ${rule.id}`);
    ids.add(rule.id);
  }
  for (const rule of INCLUDE_RULES) assert.ok(rule.roots.length > 0, rule.id);
});

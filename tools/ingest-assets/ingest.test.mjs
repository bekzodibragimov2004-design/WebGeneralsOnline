import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MANIFEST_NAME, MARKER_NAME, TEMP_MARK,
  assertNoCollisions, assertSafePath, contentVersion, formatBytes, ingest, parseArgs, readEnvValue, run,
} from './ingest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'ingest.mjs');
const repoRoot = resolve(here, '..', '..');
const CHUNK = 1024;

const sha = (data) => createHash('sha256').update(data).digest('hex');
const quiet = () => {};

// Everything lives in a fresh folder under os.tmpdir(); file names that look like game data
// exist only there, only while a test runs.
function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'wgo-ingest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    tree(name, files = {}) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      for (const [rel, content] of Object.entries(files)) put(dir, rel, content);
      return dir;
    },
  };
}

function put(dir, rel, content) {
  const file = join(dir, ...rel.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const manifestText = (out) => readFileSync(join(out, MANIFEST_NAME), 'utf8');
const manifestOf = (out) => JSON.parse(manifestText(out));
const withoutTimestamp = (text) => text.replace(/"generatedAt": "[^"]*"/, '"generatedAt": ""');

function filesUnder(dir, prefix = '') {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...filesUnder(join(dir, entry.name), rel));
    else found.push(rel);
  }
  return found.sort();
}

const go = (options, ctx = {}) => ingest(options, { stdout: quiet, chunkSize: CHUNK, ...ctx });

async function exec(argv, ctx = {}) {
  const out = [];
  const err = [];
  const code = await run(argv, { stdout: (line) => out.push(line), stderr: (line) => err.push(line), chunkSize: CHUNK, ...ctx });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const ZERO_HOUR = {
  'INIZH.big': 'ini archive',
  'EnglishZH.big': 'english archive',
  'Empty.big': '',
  'Data/INI/INIZH.big': 'second copy the engine skips',
  'Data/INI/Object/Extra.ini': 'loose ini',
  'Data/Movies/Intro.bik': 'movie',
  'Data/English/Movies/Outro.bik': 'movie',
  'Maps/Alpha/Alpha.map': 'map',
  'Art/Textures/Tank.tga': 'texture',
  'Window/Menu.wnd': 'window',
  'generalszh.exe': 'executable',
  'binkw32.dll': 'library',
  'Install_Final.bmp': 'splash',
  'readme.txt': 'not needed',
  'Support/Setup.msi': 'installer',
};
const GENERALS = {
  'INI.big': 'base ini',
  'Textures.big': 'base textures',
  'Data/Loose.ini': 'not read from the base folder',
  'generals.exe': 'executable',
};
const NEEDED = [
  'Art/Textures/Tank.tga',
  'Data/INI/Object/Extra.ini',
  'Empty.big',
  'EnglishZH.big',
  'Generals/INI.big',
  'Generals/Textures.big',
  'INIZH.big',
  'Maps/Alpha/Alpha.map',
  'Window/Menu.wnd',
];

test('copies only the needed files and writes the contract manifest', async (t) => {
  const s = sandbox(t);
  const gameDir = s.tree('zh', ZERO_HOUR);
  const generalsDir = s.tree('generals', GENERALS);
  const out = join(s.root, 'assets');

  const summary = await go({ gameDir, generalsDir, out }, { now: () => new Date('2026-11-03T12:34:56.789Z') });

  assert.deepEqual(filesUnder(out).filter((name) => name !== MARKER_NAME), [...NEEDED, MANIFEST_NAME].sort());
  const manifest = manifestOf(out);
  assert.deepEqual(Object.keys(manifest), ['schema', 'version', 'generatedAt', 'totalBytes', 'files']);
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.generatedAt, '2026-11-03T12:34:56Z');
  assert.match(manifest.version, /^[0-9a-f]{16}$/);
  assert.deepEqual(manifest.files.map((file) => file.path), NEEDED);
  for (const file of manifest.files) {
    assert.deepEqual(Object.keys(file), ['path', 'size', 'sha256']);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!file.path.includes('\\') && !file.path.split('/').includes('..') && !file.path.startsWith('/'));
    const bytes = readFileSync(join(out, ...file.path.split('/')));
    assert.equal(file.size, bytes.length);
    assert.equal(file.sha256, sha(bytes));
  }
  assert.equal(manifest.totalBytes, manifest.files.reduce((sum, file) => sum + file.size, 0));
  assert.equal(manifest.files.find((file) => file.path === 'Empty.big').sha256, sha(''));
  assert.equal(manifest.files.find((file) => file.path === 'Generals/INI.big').size, 'base ini'.length);

  assert.equal(summary.files, NEEDED.length);
  assert.equal(summary.copied, NEEDED.length);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.totalBytes, manifest.totalBytes);
  // excluded: INIZH duplicate, 2 movies, 2 executables, 1 library, splash, installer; not needed: readme, base Data/Loose.ini
  assert.equal(summary.excluded, 8);
  assert.equal(summary.ignored, 2);
  assert.ok(manifestText(out).endsWith('}\n'));
});

test('manifest files are sorted by path, compared byte by byte', async (t) => {
  const s = sandbox(t);
  const gameDir = s.tree('zh', {
    'c.big': '1', 'a/b.big': '2', 'a.big': '3', '_x.big': '4', 'Z/a.big': '5',
    'B.big': '6', '9.big': '7', '10.big': '8', 'é.big': '9', 'Data/a b.ini': '10',
  });
  const out = join(s.root, 'assets');
  await go({ gameDir, out });
  // Not what localeCompare or a case-folding sort would give: 'B' < 'Z' < '_' < 'a', and '.' < '/'.
  assert.deepEqual(manifestOf(out).files.map((file) => file.path), [
    '10.big', '9.big', 'B.big', 'Data/a b.ini', 'Z/a.big', '_x.big', 'a.big', 'a/b.big', 'c.big', 'é.big',
  ]);
});

test('file larger than the read chunk is hashed and copied by streaming', async (t) => {
  const s = sandbox(t);
  const data = Buffer.alloc(CHUNK * 10 + 17);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 8)) & 0xff;
  const gameDir = s.tree('zh', { 'Large.big': data });
  const out = join(s.root, 'assets');
  await go({ gameDir, out });
  assert.deepEqual(manifestOf(out).files, [{ path: 'Large.big', size: data.length, sha256: sha(data) }]);
  assert.ok(readFileSync(join(out, 'Large.big')).equals(data));
});

test('second run skips everything and copies no bytes', async (t) => {
  const s = sandbox(t);
  const gameDir = s.tree('zh', ZERO_HOUR);
  const generalsDir = s.tree('generals', GENERALS);
  const out = join(s.root, 'assets');

  await go({ gameDir, generalsDir, out });
  const modified = statSync(join(out, 'INIZH.big')).mtimeMs;
  let chunks = 0;
  const summary = await go({ gameDir, generalsDir, out }, { hooks: { afterChunk: () => { chunks += 1; } } });

  assert.equal(chunks, 0, 'no file may be read for copying on a repeat run');
  assert.equal(summary.copied, 0);
  assert.equal(summary.skipped, NEEDED.length);
  assert.equal(summary.removed, 0);
  assert.equal(statSync(join(out, 'INIZH.big')).mtimeMs, modified);
});

test('a changed source file is detected, including a change that keeps the size', async (t) => {
  const s = sandbox(t);
  const gameDir = s.tree('zh', { 'A.big': 'aaaa', 'B.big': 'bbbb', 'C.big': 'cccc' });
  const out = join(s.root, 'assets');
  await go({ gameDir, out });
  const before = manifestOf(out);

  put(gameDir, 'B.big', 'BBBB');
  let summary = await go({ gameDir, out });
  assert.equal(summary.copied, 1);
  assert.equal(summary.skipped, 2);
  assert.equal(readFileSync(join(out, 'B.big'), 'utf8'), 'BBBB');
  const after = manifestOf(out);
  assert.equal(after.files.find((file) => file.path === 'B.big').sha256, sha('BBBB'));
  assert.notEqual(after.version, before.version);

  put(gameDir, 'C.big', 'a much longer replacement');
  summary = await go({ gameDir, out });
  assert.equal(summary.copied, 1);
  assert.equal(readFileSync(join(out, 'C.big'), 'utf8'), 'a much longer replacement');
  assert.equal(manifestOf(out).totalBytes, 4 + 4 + 'a much longer replacement'.length);
});

test('a damaged copy in the asset directory is replaced', async (t) => {
  const s = sandbox(t);
  const gameDir = s.tree('zh', { 'A.big': 'aaaa', 'B.big': 'bbbb' });
  const out = join(s.root, 'assets');
  await go({ gameDir, out });
  writeFileSync(join(out, 'A.big'), 'xxxx');
  const summary = await go({ gameDir, out });
  assert.equal(summary.copied, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(readFileSync(join(out, 'A.big'), 'utf8'), 'aaaa');
});

test('files that no longer belong are removed and reported', async (t) => {
  const s = sandbox(t);
  const gameDir = s.tree('zh', { 'Keep.big': 'keep', 'Old.big': 'old', 'Data/Gone/x.ini': 'x', 'Data/Stay/y.ini': 'y' });
  const out = join(s.root, 'assets');
  await go({ gameDir, out });
  put(out, 'Stray/notes.txt', 'someone left this');
  put(out, 'Keep.big.wgo-tmp-1-deadbeef', 'half a file from an interrupted run');

  rmSync(join(gameDir, 'Old.big'));
  rmSync(join(gameDir, 'Data', 'Gone'), { recursive: true });
  const lines = [];
  const summary = await go({ gameDir, out }, { stdout: (line) => lines.push(line) });

  assert.equal(summary.removed, 4);
  for (const path of ['Old.big', 'Data/Gone/x.ini', 'Stray/notes.txt', 'Keep.big.wgo-tmp-1-deadbeef']) {
    assert.ok(lines.includes(`remove ${path}`), `report names ${path}`);
  }
  assert.deepEqual(filesUnder(out), ['Data/Stay/y.ini', 'Keep.big', MARKER_NAME, MANIFEST_NAME].sort());
  assert.ok(!existsSync(join(out, 'Stray')), 'empty folders are cleaned up');
  assert.ok(!existsSync(join(out, 'Data', 'Gone')));
  assert.deepEqual(manifestOf(out).files.map((file) => file.path), ['Data/Stay/y.ini', 'Keep.big']);
});

test('refuses an --out inside the git repo, before touching anything', async (t) => {
  const s = sandbox(t);
  const gameDir = s.tree('zh', { 'A.big': 'a' });

  // the real repo this tool lives in
  const inRepo = join(repoRoot, 'wgo-ingest-test-must-not-exist');
  t.after(() => rmSync(inRepo, { recursive: true, force: true }));
  let result = await exec(['--game-dir', gameDir, '--out', inRepo]);
  assert.equal(result.code, 1);
  assert.match(result.err, /inside the git repo/);
  assert.ok(!existsSync(inRepo));
  result = await exec(['--game-dir', gameDir, '--out', join(repoRoot, 'tools', 'ingest-assets', 'out')]);
  assert.equal(result.code, 1);
  assert.match(result.err, /inside the git repo/);

  // a stand-in repo, including its root, a deep path and a ".." segment that lands inside it
  const repo = s.tree('repo');
  for (const out of [repo, join(repo, 'assets'), join(repo, 'a', 'b', 'c'), `${repo}/x/../assets`]) {
    result = await exec(['--game-dir', gameDir, '--out', out], { repoRoot: repo });
    assert.equal(result.code, 1, out);
    assert.match(result.err, /inside the git repo/, out);
  }
  assert.deepEqual(readdirSync(repo), []);

  // a sibling whose name only starts like the repo's is fine
  const sibling = join(s.root, 'repo-assets');
  result = await exec(['--game-dir', gameDir, '--out', sibling], { repoRoot: repo });
  assert.equal(result.code, 0, result.err);
  assert.ok(existsSync(join(sibling, MANIFEST_NAME)));
});

test('refuses an --out that contains the repo, or overlaps a game folder', async (t) => {
  const s = sandbox(t);
  const holder = s.tree('holder');
  const repo = s.tree('holder/repo');
  const other = sandbox(t);
  const gameDir = other.tree('zh', { 'A.big': 'a' });
  let result = await exec(['--game-dir', gameDir, '--out', holder], { repoRoot: repo });
  assert.equal(result.code, 1);
  assert.match(result.err, /contains the git repo/);

  const fakeRepo = s.tree('fakerepo');
  const generalsDir = other.tree('generals', { 'INI.big': 'i' });
  for (const [out, pattern] of [
    [join(gameDir, 'assets'), /overlaps --game-dir/],
    [other.root, /overlaps --game-dir/],
    [gameDir, /overlaps --game-dir/],
  ]) {
    result = await exec(['--game-dir', gameDir, '--out', out], { repoRoot: fakeRepo });
    assert.equal(result.code, 1, out);
    assert.match(result.err, pattern, out);
  }
  result = await exec(['--game-dir', gameDir, '--generals-dir', generalsDir, '--out', join(generalsDir, 'assets')], { repoRoot: fakeRepo });
  assert.equal(result.code, 1);
  assert.match(result.err, /overlaps --generals-dir/);
  mkdirSync(join(gameDir, 'Generals'));
  result = await exec(['--game-dir', gameDir, '--generals-dir', join(gameDir, 'Generals'), '--out', join(s.root, 'elsewhere')], { repoRoot: fakeRepo });
  assert.equal(result.code, 1);
  assert.match(result.err, /--game-dir and --generals-dir overlap/);
  assert.deepEqual(readdirSync(gameDir).sort(), ['A.big', 'Generals']);
  assert.ok(!existsSync(join(s.root, 'elsewhere')));
});

test('refuses a non-empty --out that this tool did not create, and deletes nothing there', async (t) => {
  const s = sandbox(t);
  const gameDir = s.tree('zh', { 'A.big': 'a' });
  const out = s.tree('precious', { 'photos/me.jpg': 'irreplaceable' });
  const result = await exec(['--game-dir', gameDir, '--out', out]);
  assert.equal(result.code, 1);
  assert.match(result.err, /not empty and was not created by this tool/);
  assert.deepEqual(filesUnder(out), ['photos/me.jpg']);

  const empty = s.tree('empty-out');
  assert.equal((await exec(['--game-dir', gameDir, '--out', empty])).code, 0);
});

test('works with spaces and an ampersand in every path, from the command line', (t) => {
  const s = sandbox(t);
  const gameDir = s.tree('Command & Conquer Generals - Zero Hour', {
    'INIZH.big': 'ini',
    'Data/My Maps & More/a b.ini': 'spaced',
  });
  const generalsDir = s.tree('Command & Conquer Generals', { 'INI.big': 'base' });
  const out = join(s.root, 'asset out & stuff', 'v 1');

  const result = spawnSync(process.execPath, [script, '--game-dir', gameDir, '--generals-dir', generalsDir, '--out', out], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /Command & Conquer Generals - Zero Hour/);
  assert.deepEqual(manifestOf(out).files.map((file) => file.path), ['Data/My Maps & More/a b.ini', 'Generals/INI.big', 'INIZH.big']);
  assert.equal(readFileSync(join(out, 'Data', 'My Maps & More', 'a b.ini'), 'utf8'), 'spaced');
  assert.match(result.stdout, /files: +3/);
  assert.match(result.stdout, /copied: +3/);
  assert.match(result.stdout, /skipped: +0/);

  const again = spawnSync(process.execPath, [script, '--game-dir', gameDir, '--generals-dir', generalsDir, '--out', out], { encoding: 'utf8' });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /copied: +0/);
  assert.match(again.stdout, /skipped: +3/);
});

test('same input gives the same manifest apart from generatedAt', async (t) => {
  const s = sandbox(t);
  const names = Object.keys(ZERO_HOUR);
  const forward = Object.fromEntries(names.map((name) => [name, ZERO_HOUR[name]]));
  const backward = Object.fromEntries([...names].reverse().map((name) => [name, ZERO_HOUR[name]]));
  const first = s.tree('zh1', forward);
  const second = s.tree('zh2', backward);
  const outA = join(s.root, 'a');
  const outB = join(s.root, 'b');

  await go({ gameDir: first, out: outA }, { now: () => new Date('2026-01-01T00:00:00Z') });
  await go({ gameDir: second, out: outB }, { now: () => new Date('2027-06-06T06:06:06Z') });
  assert.notEqual(manifestText(outA), manifestText(outB));
  assert.equal(withoutTimestamp(manifestText(outA)), withoutTimestamp(manifestText(outB)));

  // an incremental run over the same folder is the same too
  await go({ gameDir: first, out: outA }, { now: () => new Date('2030-02-02T02:02:02Z') });
  assert.equal(withoutTimestamp(manifestText(outA)), withoutTimestamp(manifestText(outB)));
  assert.match(manifestText(outA), /"generatedAt": "2030-02-02T02:02:02Z"/);
});

test('default version follows the content, --version overrides it', async (t) => {
  const s = sandbox(t);
  const gameDir = s.tree('zh', { 'A.big': 'one', 'B.big': 'two' });
  const outA = join(s.root, 'a');
  const outB = join(s.root, 'b');
  const outC = join(s.root, 'c');

  const first = await go({ gameDir, out: outA });
  const same = await go({ gameDir, out: outB });
  assert.equal(first.version, same.version);

  const later = new Date(Date.now() + 3600_000);
  utimesSync(join(gameDir, 'A.big'), later, later);
  assert.equal((await go({ gameDir, out: outA })).version, first.version, 'a new timestamp is not new content');

  put(gameDir, 'A.big', 'ONE');
  const changed = await go({ gameDir, out: outA });
  assert.notEqual(changed.version, first.version);
  put(gameDir, 'C.big', 'three');
  const added = await go({ gameDir, out: outA });
  assert.notEqual(added.version, changed.version);
  rmSync(join(gameDir, 'C.big'));
  assert.equal((await go({ gameDir, out: outA })).version, changed.version, 'back to the same content, back to the same version');

  const custom = await go({ gameDir, out: outC, version: '2026.11.03-1' });
  assert.equal(custom.version, '2026.11.03-1');
  assert.equal(manifestOf(outC).version, '2026.11.03-1');

  assert.equal(contentVersion([{ path: 'a', size: 1, sha256: 'x' }]), contentVersion([{ path: 'a', size: 1, sha256: 'x' }]));
  assert.notEqual(contentVersion([{ path: 'a', size: 1, sha256: 'x' }]), contentVersion([{ path: 'b', size: 1, sha256: 'x' }]));
  for (const bad of ['', 'has space', '../x', 'a'.repeat(65), '-lead']) {
    const result = await exec(['--game-dir', gameDir, '--out', join(s.root, 'never'), '--version', bad]);
    assert.equal(result.code, 2, JSON.stringify(bad));
  }
  assert.ok(!existsSync(join(s.root, 'never')));
});

test('a process killed in the middle of a copy leaves no partial file, and the next run recovers', async (t) => {
  const s = sandbox(t);
  const oldData = Buffer.alloc(300_000, 1);
  const newData = Buffer.alloc(300_000, 2);
  const gameDir = s.tree('zh', { 'Big.big': oldData, 'Other.big': 'other' });
  const out = join(s.root, 'assets');
  await go({ gameDir, out }, { chunkSize: 65536 });
  const manifestBefore = manifestText(out);

  const killedRun = (outDir) => {
    const code = `
      import { run } from ${JSON.stringify(pathToFileURL(script).href)};
      const status = await run(${JSON.stringify(['--game-dir', gameDir, '--out', outDir])}, {
        chunkSize: 65536, stdout() {}, stderr() {},
        hooks: { afterChunk() { process.exit(9); } },
      });
      process.exit(status);
    `;
    return spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  };

  // update interrupted: the old complete file stays at the real name, the old manifest stays
  put(gameDir, 'Big.big', newData);
  let killed = killedRun(out);
  assert.equal(killed.status, 9, killed.stderr);
  assert.ok(readFileSync(join(out, 'Big.big')).equals(oldData), 'real name still holds the old, complete file');
  assert.equal(manifestText(out), manifestBefore);
  const temps = readdirSync(out).filter((name) => name.includes(TEMP_MARK));
  assert.equal(temps.length, 1);
  assert.equal(statSync(join(out, temps[0])).size, 65536, 'only the temp file is partial');

  const lines = [];
  await go({ gameDir, out }, { chunkSize: 65536, stdout: (line) => lines.push(line) });
  assert.ok(readFileSync(join(out, 'Big.big')).equals(newData));
  assert.deepEqual(readdirSync(out).filter((name) => name.includes(TEMP_MARK)), []);
  assert.ok(lines.includes(`remove ${temps[0]}`), 'leftover temp file is reported');
  assert.equal(manifestOf(out).files.find((file) => file.path === 'Big.big').sha256, sha(newData));

  // first run interrupted: no file and no manifest at real names, and the folder can be resumed
  const fresh = join(s.root, 'fresh');
  killed = killedRun(fresh);
  assert.equal(killed.status, 9, killed.stderr);
  assert.ok(!existsSync(join(fresh, 'Big.big')));
  assert.ok(!existsSync(join(fresh, MANIFEST_NAME)));
  const resumed = await exec(['--game-dir', gameDir, '--out', fresh], { chunkSize: 65536 });
  assert.equal(resumed.code, 0, resumed.err);
  assert.ok(readFileSync(join(fresh, 'Big.big')).equals(newData));
  assert.deepEqual(readdirSync(fresh).filter((name) => name.includes(TEMP_MARK)), []);
  assert.equal(manifestOf(fresh).files.length, 2);
});

test('an error in the middle of a copy cleans up its temp file and writes no manifest', async (t) => {
  const s = sandbox(t);
  const gameDir = s.tree('zh', { 'Big.big': Buffer.alloc(5000, 7) });
  const out = join(s.root, 'assets');
  const failing = { afterChunk: ({ bytes }) => { if (bytes >= 2 * CHUNK) throw new Error('disk on fire'); } };

  const result = await exec(['--game-dir', gameDir, '--out', out], { hooks: failing });

  assert.equal(result.code, 1);
  assert.match(result.err, /disk on fire/);
  assert.deepEqual(filesUnder(out), [MARKER_NAME]);

  assert.equal((await exec(['--game-dir', gameDir, '--out', out])).code, 0);
  assert.deepEqual(filesUnder(out), ['Big.big', MARKER_NAME, MANIFEST_NAME].sort());
});

test('a source that changes while it is copied is rejected', async (t) => {
  const s = sandbox(t);
  const gameDir = s.tree('zh', { 'Big.big': Buffer.alloc(5000, 7) });
  const out = join(s.root, 'assets');
  const growing = { afterChunk: ({ bytes }) => { if (bytes === CHUNK) writeFileSync(join(gameDir, 'Big.big'), Buffer.alloc(9000, 7)); } };
  const result = await exec(['--game-dir', gameDir, '--out', out], { hooks: growing });
  assert.equal(result.code, 1);
  assert.match(result.err, /changed while it was being copied/);
  assert.ok(!existsSync(join(out, 'Big.big')));
  assert.ok(!existsSync(join(out, MANIFEST_NAME)));
});

test('GAME_DIR comes from .env when --game-dir is missing, and no other .env value is printed', async (t) => {
  const s = sandbox(t);
  const gameDir = s.tree('Zero Hour & Co', { 'INIZH.big': 'ini' });
  const repo = s.tree('repo');
  writeFileSync(join(repo, '.env'), `SITE_PASSWORD=hunter2-site-secret\nGAME_DIR=${gameDir}   # steam copy\nGO_ACCOUNT_1_PASS="go-pass-secret"\n`);
  const out = join(s.root, 'assets');

  const result = await exec(['--out', out], { repoRoot: repo });

  assert.equal(result.code, 0, result.err);
  assert.ok(result.out.includes(`game dir: ${gameDir} (GAME_DIR from .env)`));
  assert.doesNotMatch(result.out + result.err, /hunter2|go-pass-secret|steam copy/);
  assert.deepEqual(manifestOf(out).files.map((file) => file.path), ['INIZH.big']);

  // a quoted value, and a flag that wins over the file
  writeFileSync(join(repo, '.env'), `GAME_DIR="${gameDir}"\n`);
  assert.equal((await exec(['--out', join(s.root, 'again')], { repoRoot: repo })).code, 0);
  writeFileSync(join(repo, '.env'), 'GAME_DIR=Z:\\does\\not\\exist\n');
  const flagged = await exec(['--game-dir', gameDir, '--out', join(s.root, 'flagged')], { repoRoot: repo });
  assert.equal(flagged.code, 0, flagged.err);
  assert.doesNotMatch(flagged.out, /does.not.exist/);
});

test('no --game-dir and no GAME_DIR is a clear error, never a guess', async (t) => {
  const s = sandbox(t);
  const repo = s.tree('repo');
  const out = join(s.root, 'assets');

  let result = await exec(['--out', out], { repoRoot: repo });
  assert.equal(result.code, 2);
  assert.match(result.err, /--game-dir.*GAME_DIR/);

  for (const body of ['GAME_DIR=\n', 'GAME_DIR=   # fill in\n', 'OTHER=1\n', '# GAME_DIR=C:\\x\n', '']) {
    writeFileSync(join(repo, '.env'), body);
    result = await exec(['--out', out], { repoRoot: repo });
    assert.equal(result.code, 2, JSON.stringify(body));
    assert.match(result.err, /GAME_DIR/);
  }
  assert.ok(!existsSync(out));

  assert.equal(readEnvValue('A=1\nGAME_DIR = "C:\\Program Files (x86)\\ZH & Co"  # x\n', 'GAME_DIR'), 'C:\\Program Files (x86)\\ZH & Co');
  assert.equal(readEnvValue('\uFEFFGAME_DIR=D:\\Games\\ZH\r\nB=2\r\n', 'GAME_DIR'), 'D:\\Games\\ZH');
  assert.equal(readEnvValue('GAME_DIR=\n', 'GAME_DIR'), '');
  assert.equal(readEnvValue('MY_GAME_DIR=x\n', 'GAME_DIR'), '');
});

test('a game folder that does not exist or has nothing needed is an error', async (t) => {
  const s = sandbox(t);
  const out = join(s.root, 'assets');
  let result = await exec(['--game-dir', join(s.root, 'missing'), '--out', out]);
  assert.equal(result.code, 1);
  assert.match(result.err, /--game-dir does not exist/);

  const nothing = s.tree('nothing', { 'readme.txt': 'x', 'game.exe': 'x', 'Data/Movies/a.bik': 'x' });
  result = await exec(['--game-dir', nothing, '--out', out]);
  assert.equal(result.code, 1);
  assert.match(result.err, /no game files found/);
  assert.ok(!existsSync(out));
});

test('--dry-run reports what would happen and writes nothing', async (t) => {
  const s = sandbox(t);
  const gameDir = s.tree('zh', { 'A.big': 'aaaa', 'B.big': 'bbbb', 'Data/Movies/c.bik': 'movie' });
  const out = join(s.root, 'assets');

  let result = await exec(['--game-dir', gameDir, '--out', out, '--dry-run']);
  assert.equal(result.code, 0, result.err);
  assert.ok(!existsSync(out), 'a dry run does not even create --out');
  assert.match(result.out, /would copy A\.big/);
  assert.match(result.out, /exclude Data\/Movies\/c\.bik \(bink-video\)/);
  assert.match(result.out, /dry run, nothing was written/);
  assert.match(result.out, /manifest: \(not written\)/);

  await go({ gameDir, out });
  put(out, 'stray.txt', 'stray');
  put(gameDir, 'A.big', 'AAAA');
  const before = { files: filesUnder(out), manifest: manifestText(out), a: readFileSync(join(out, 'A.big'), 'utf8') };
  result = await exec(['--game-dir', gameDir, '--out', out, '--dry-run']);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /would copy A\.big/);
  assert.match(result.out, /would remove stray\.txt/);
  assert.match(result.out, /copied: +1/);
  assert.match(result.out, /skipped: +1/);
  assert.deepEqual({ files: filesUnder(out), manifest: manifestText(out), a: readFileSync(join(out, 'A.big'), 'utf8') }, before);
});

test('symbolic links are not followed', async (t) => {
  const s = sandbox(t);
  const gameDir = s.tree('zh', { 'A.big': 'aaaa' });
  const secret = s.tree('elsewhere', { 'Secret.big': 'not part of the install' });
  try {
    // 'junction' needs no privilege on Windows and is ignored elsewhere; "Data" would be included if it were followed
    symlinkSync(secret, join(gameDir, 'Data'), 'junction');
  } catch (error) {
    t.skip(`cannot create links here: ${error.code}`);
    return;
  }
  try {
    symlinkSync(join(secret, 'Secret.big'), join(gameDir, 'Link.big'), 'file');
  } catch {
    // file links may need a privilege on Windows; the folder link above already covers the behavior
  }
  const lines = [];
  await go({ gameDir, out: join(s.root, 'assets') }, { stdout: (line) => lines.push(line) });
  assert.deepEqual(manifestOf(join(s.root, 'assets')).files.map((file) => file.path), ['A.big']);
  assert.ok(lines.some((line) => line === 'warning: symbolic link not followed: Data'));
});

test('command line: usage errors exit 2, help exits 0', () => {
  const cli = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  let result = cli('--bogus');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument: --bogus/);
  result = cli('--game-dir', 'x');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--out/);
  result = cli('--game-dir');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--game-dir needs a value/);
  result = cli('--game-dir', '--out', 'x');
  assert.equal(result.status, 2);
  result = cli('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /usage: node tools\/ingest-assets\/ingest\.mjs/);
});

test('argument parsing', () => {
  assert.deepEqual(parseArgs(['--game-dir=C:\\a b', '--out', 'o', '--version', 'v1', '--dry-run', '--generals-dir', 'g']), {
    gameDir: 'C:\\a b', generalsDir: 'g', out: 'o', version: 'v1', dryRun: true, help: false,
  });
  assert.throws(() => parseArgs(['--dry-run=yes']), /unknown argument/);
});

test('path safety and collision helpers', () => {
  for (const good of ['a.big', 'Data/INI/a b & c.ini', 'Generals/INI.big', 'é.big']) assert.doesNotThrow(() => assertSafePath(good), good);
  for (const bad of ['', '/abs.big', 'C:/x.big', 'a/../b.big', '../b.big', 'a//b.big', './a.big', 'a\\b.big', 'a/b.big/', 'dir /a.big', 'a:b.big', 'a\u0001.big']) {
    assert.throws(() => assertSafePath(bad), /cannot be stored/, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => assertNoCollisions(['a.big', 'b.big']));
  assert.throws(() => assertNoCollisions(['Data/A.big', 'data/a.BIG']), /same path/);
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GiB');
});

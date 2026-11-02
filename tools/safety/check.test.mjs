import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEnvValues } from './check.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check.mjs');

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'safety-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  git('add', '.');
  git('commit', '-qm', 'seed');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, SAFETY_ENV_VALUES: '' },
  });
  return { dir, git, run, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('clean staged file passes', () => {
  const s = sandbox();
  writeFileSync(join(s.dir, 'ok.cpp'), 'int x;\n');
  s.git('add', '.');
  assert.equal(s.run('--staged').status, 0);
  s.done();
});

test('forbidden extension is blocked', () => {
  const s = sandbox();
  writeFileSync(join(s.dir, 'INI.BIG'), 'data');
  s.git('add', '-f', '.');
  const result = s.run('--staged');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /forbidden file type/);
  s.done();
});

test('allowlist needs the exact content', () => {
  const s = sandbox();
  mkdirSync(join(s.dir, 'tools', 'safety'), { recursive: true });
  writeFileSync(join(s.dir, 'a.tga'), 'one');
  s.git('add', '-f', 'a.tga');
  const sha = s.git('rev-parse', ':a.tga');
  writeFileSync(join(s.dir, 'tools', 'safety', 'allowlist.txt'), `# comment\n${sha} a.tga\n`);
  assert.equal(s.run('--staged').status, 0);
  writeFileSync(join(s.dir, 'a.tga'), 'two');
  s.git('add', '-f', 'a.tga');
  assert.equal(s.run('--staged').status, 1);
  s.done();
});

test('file over 5 MB is blocked', () => {
  const s = sandbox();
  writeFileSync(join(s.dir, 'big.bin'), Buffer.alloc(5 * 1024 * 1024 + 1));
  s.git('add', '.');
  const result = s.run('--staged');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /larger than 5 MB/);
  s.done();
});

test('.env is blocked and .env.example is allowed', () => {
  const s = sandbox();
  writeFileSync(join(s.dir, '.env.example'), 'KEY=\n');
  s.git('add', '.');
  assert.equal(s.run('--staged').status, 0);
  writeFileSync(join(s.dir, '.env.local'), 'KEY=x\n');
  s.git('add', '-f', '.env.local');
  assert.equal(s.run('--staged').status, 1);
  s.done();
});

test('secret value is blocked and never printed', () => {
  const s = sandbox();
  writeFileSync(join(s.dir, '.env'), 'SITE_PASSWORD=hunter2hunter2\n');
  writeFileSync(join(s.dir, 'notes.md'), 'the password is hunter2hunter2\n');
  s.git('add', 'notes.md');
  const result = s.run('--staged');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /contains the value of SITE_PASSWORD/);
  assert.doesNotMatch(result.stderr + result.stdout, /hunter2/);
  s.done();
});

test('--range catches a file added and later deleted', () => {
  const s = sandbox();
  const base = s.git('rev-parse', 'HEAD');
  writeFileSync(join(s.dir, 'x.w3d'), 'mesh');
  s.git('add', '-f', '.');
  s.git('commit', '-qm', 'add');
  s.git('rm', '-q', 'x.w3d');
  s.git('commit', '-qm', 'remove');
  assert.equal(s.run('--all').status, 0);
  assert.equal(s.run('--range', `${base}..HEAD`).status, 1);
  s.done();
});

test('parseEnvValues skips empty values and comments', () => {
  const parsed = parseEnvValues('A=\nB=   # note\nC="quoted value"\n# D=nope\nE=abc\nF=C:\\Games\\ZH\n');
  assert.deepEqual(parsed.map((entry) => entry.key), ['C', 'F', 'F']);
  assert.equal(parsed[0].value, 'quoted value');
  assert.equal(parsed[2].value, 'C:/Games/ZH');
});

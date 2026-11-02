import { describe, expect, it } from 'vitest';
import { assertWritableRoot } from '../paths';
import {
  ManifestError,
  diffManifest,
  findStalePaths,
  manifestsEqual,
  parseManifest,
  pathProblem,
  type Manifest,
} from './manifest';

const sha = (char: string) => char.repeat(64);

function manifest(files: [string, number, string][], version = '1'): Manifest {
  return {
    schema: 1,
    version,
    generatedAt: '',
    totalBytes: files.reduce((sum, [, size]) => sum + size, 0),
    files: files.map(([path, size, hash]) => ({ path, size, sha256: sha(hash) })),
  };
}

describe('parseManifest', () => {
  const valid = {
    schema: 1,
    version: '2026.11.03-1',
    generatedAt: '2026-11-03T00:00:00Z',
    totalBytes: 30,
    files: [
      { path: 'Data/a.dat', size: 10, sha256: sha('a') },
      { path: 'Data/b.dat', size: 20, sha256: sha('b') },
    ],
  };

  it('accepts a contract manifest', () => {
    const parsed = parseManifest(valid);
    expect(parsed.version).toBe('2026.11.03-1');
    expect(parsed.files).toHaveLength(2);
    expect(parsed.totalBytes).toBe(30);
  });

  it('computes totalBytes from the files rather than trusting the field', () => {
    expect(parseManifest({ ...valid, totalBytes: 999 }).totalBytes).toBe(30);
  });

  it('accepts an empty file list', () => {
    expect(parseManifest({ ...valid, files: [], totalBytes: 0 }).files).toEqual([]);
  });

  it.each([
    ['wrong schema', { ...valid, schema: 2 }, /schema/],
    ['missing version', { ...valid, version: '' }, /version/],
    ['files not an array', { ...valid, files: {} }, /files/],
    ['not an object', [], /object/],
    ['duplicate path', { ...valid, files: [valid.files[0], valid.files[0]] }, /duplicate/],
    ['negative size', { ...valid, files: [{ path: 'a', size: -1, sha256: sha('a') }] }, /size/],
    ['fractional size', { ...valid, files: [{ path: 'a', size: 1.5, sha256: sha('a') }] }, /size/],
    ['uppercase hash', { ...valid, files: [{ path: 'a', size: 1, sha256: 'A'.repeat(64) }] }, /sha256/],
    ['short hash', { ...valid, files: [{ path: 'a', size: 1, sha256: 'ab' }] }, /sha256/],
    ['parent segment', { ...valid, files: [{ path: 'a/../b', size: 1, sha256: sha('a') }] }, /\.\./],
    ['file and directory clash', { ...valid, files: [{ path: 'a', size: 1, sha256: sha('a') }, { path: 'a/b', size: 1, sha256: sha('b') }] }, /file and as a directory/],
  ])('rejects %s', (_name, input, message) => {
    expect(() => parseManifest(input)).toThrow(ManifestError);
    expect(() => parseManifest(input)).toThrow(message);
  });
});

describe('pathProblem', () => {
  it.each(['Data/INI/x.dat', 'a', 'Dir with space/File (1).bin', 'Ünïcode/ok.bin'])('accepts %s', (path) => {
    expect(pathProblem(path)).toBeNull();
  });

  it.each([
    ['', 'empty'],
    ['/abs/path', 'absolute'],
    ['C:/win', 'drive letter'],
    ['a\\b', 'backslash'],
    ['a//b', 'empty segment'],
    ['a/./b', 'dot segment'],
    ['../escape', 'parent segment'],
    ['a/..', 'trailing parent'],
    ['a\u0000b', 'NUL'],
    ['manifest.json', 'installed manifest name'],
    ['x'.repeat(600), 'too long'],
  ])('rejects %j (%s)', (path) => {
    expect(pathProblem(path)).not.toBeNull();
  });

  it('allows manifest.json below a directory', () => {
    expect(pathProblem('Data/manifest.json')).toBeNull();
  });
});

describe('diffManifest', () => {
  const installed = manifest([
    ['a', 10, 'a'],
    ['b', 20, 'b'],
    ['gone', 5, 'g'],
  ]);

  it('downloads everything when nothing is installed', () => {
    const remote = manifest([['a', 10, 'a'], ['b', 20, 'b']]);
    const diff = diffManifest(null, remote);
    expect(diff.download.map((e) => [e.file.path, e.reason])).toEqual([['a', 'new'], ['b', 'new']]);
    expect(diff.bytesToDownload).toBe(30);
    expect(diff.remove).toEqual([]);
  });

  it('downloads only new and changed files', () => {
    const remote = manifest([
      ['a', 10, 'a'], // same
      ['b', 20, 'x'], // content changed
      ['c', 7, 'c'], // new
    ]);
    const diff = diffManifest(installed, remote);
    expect(diff.download.map((e) => [e.file.path, e.reason])).toEqual([['b', 'changed'], ['c', 'new']]);
    expect(diff.unchanged.map((f) => f.path)).toEqual(['a']);
    expect(diff.bytesToDownload).toBe(27);
  });

  it('treats a size change with the same hash as changed', () => {
    const remote = manifest([['a', 11, 'a']]);
    expect(diffManifest(installed, remote).download[0]?.reason).toBe('changed');
  });

  it('lists files that left the manifest for removal', () => {
    const remote = manifest([['a', 10, 'a'], ['b', 20, 'b']]);
    expect(diffManifest(installed, remote).remove).toEqual(['gone']);
  });

  it('downloads nothing when the manifests match', () => {
    const diff = diffManifest(installed, installed);
    expect(diff.download).toEqual([]);
    expect(diff.bytesToDownload).toBe(0);
    expect(diff.unchanged).toHaveLength(3);
  });

  it('re-downloads files that are missing or the wrong size on disk', () => {
    const remote = manifest([['a', 10, 'a'], ['b', 20, 'b']]);
    const onDisk = new Map([['a', 9]]); // a is truncated, b is absent
    const diff = diffManifest(installed, remote, onDisk);
    expect(diff.download.map((e) => [e.file.path, e.reason])).toEqual([['a', 'size-mismatch'], ['b', 'missing']]);
  });

  it('trusts the installed manifest when sizes on disk match', () => {
    const remote = manifest([['a', 10, 'a']]);
    expect(diffManifest(installed, remote, new Map([['a', 10]])).download).toEqual([]);
  });

  it('keeps the manifest order of the download list', () => {
    const remote = manifest([['z', 1, 'z'], ['m', 1, 'm'], ['a', 1, 'q']]);
    expect(diffManifest(null, remote).download.map((e) => e.file.path)).toEqual(['z', 'm', 'a']);
  });
});

describe('findStalePaths', () => {
  const remote = manifest([['keep/a', 1, 'a']]);

  it('finds files the manifest no longer lists, including ones the installed manifest never knew', () => {
    expect(findStalePaths(['keep/a', 'old/b', 'orphan.bin'], remote)).toEqual(['old/b', 'orphan.bin']);
  });

  it('never reports the installed manifest file itself', () => {
    expect(findStalePaths(['manifest.json', 'keep/a'], remote)).toEqual([]);
  });

  it('is case sensitive, like the manifest', () => {
    expect(findStalePaths(['Keep/A'], remote)).toEqual(['Keep/A']);
  });
});

describe('manifestsEqual', () => {
  it('compares version and every file', () => {
    expect(manifestsEqual(manifest([['a', 1, 'a']]), manifest([['a', 1, 'a']]))).toBe(true);
    expect(manifestsEqual(manifest([['a', 1, 'a']], '1'), manifest([['a', 1, 'a']], '2'))).toBe(false);
    expect(manifestsEqual(manifest([['a', 1, 'a']]), manifest([['a', 1, 'b']]))).toBe(false);
    expect(manifestsEqual(manifest([['a', 1, 'a']]), manifest([]))).toBe(false);
  });
});

describe('player data protection', () => {
  it('only game and partial can be modified, never player', () => {
    expect(() => assertWritableRoot('game')).not.toThrow();
    expect(() => assertWritableRoot('partial')).not.toThrow();
    expect(() => assertWritableRoot('player')).toThrow(/player/);
    expect(() => assertWritableRoot('')).toThrow();
  });
});

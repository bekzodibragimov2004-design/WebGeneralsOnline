#!/usr/bin/env node
// Copies the files WebGeneralsOnline needs from an owner-supplied Generals / Zero Hour
// install into a server-side asset directory outside the repo, then writes manifest.json
// (format in docs/WEB_CONTRACT.md). rules.mjs decides which files are needed.
//
//   --game-dir <path>      Zero Hour folder; defaults to GAME_DIR in the .env at the repo root
//   --generals-dir <path>  base Generals folder (Zero Hour also loads its archives)
//   --out <dir>            asset directory; must be outside the git repo
//   --version <string>     manifest version; defaults to a hash of the content
//   --dry-run              report what would happen, write nothing
//
// A file is skipped when its size and SHA-256 already match. Copies go to a temp name and
// are renamed into place, so an interruption never leaves a partial file at a real name.
// The manifest is written last, atomically. Files in --out that no longer belong are removed.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, open, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERALS_PREFIX, ROOT_GENERALS, ROOT_ZERO_HOUR, classify } from './rules.mjs';

export const MANIFEST_NAME = 'manifest.json';
// Written into --out on the first run. Lets a run that was interrupted before the manifest
// existed be resumed, while a non-empty folder that is not ours is refused (we delete
// everything in --out that is not part of the manifest).
export const MARKER_NAME = '.wgo-asset-dir';
export const TEMP_MARK = '.wgo-tmp-';
const SCHEMA = 1;
const DEFAULT_CHUNK = 4 * 1024 * 1024;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const USAGE = `usage: node tools/ingest-assets/ingest.mjs --game-dir <path> --out <dir> [--generals-dir <path>] [--version <string>] [--dry-run]
  --game-dir      Zero Hour folder (default: GAME_DIR from the .env at the repo root)
  --generals-dir  base Generals folder; Zero Hour also loads its archives
  --out           asset directory, outside the git repo
  --version       manifest version (default: derived from the content hash)
  --dry-run       report only, write nothing`;

class UsageError extends Error {}

export function parseArgs(argv) {
  const options = { gameDir: undefined, generalsDir: undefined, out: undefined, version: undefined, dryRun: false, help: false };
  const valued = { '--game-dir': 'gameDir', '--generals-dir': 'generalsDir', '--out': 'out', '--version': 'version' };
  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i];
    let inline;
    const equals = flag.indexOf('=');
    if (flag.startsWith('--') && equals > 0) {
      inline = flag.slice(equals + 1);
      flag = flag.slice(0, equals);
    }
    if (flag === '--dry-run' && inline === undefined) options.dryRun = true;
    else if ((flag === '--help' || flag === '-h') && inline === undefined) options.help = true;
    else if (Object.hasOwn(valued, flag)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value === '' || (inline === undefined && value.startsWith('--'))) {
        throw new UsageError(`${flag} needs a value`);
      }
      options[valued[flag]] = value;
    } else throw new UsageError(`unknown argument: ${argv[i]}`);
  }
  return options;
}

export function assertVersion(version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new UsageError('--version must be 1-64 characters: letters, digits, ".", "_", "+" or "-", starting with a letter or digit');
  }
}

// Reads one key from .env text and nothing else, so other values are never held or printed.
export function readEnvValue(text, key) {
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || match[1] !== key) continue;
    const body = match[2].trim();
    const quoted = body.match(/^(['"])(.*?)\1/);
    return quoted ? quoted[2] : body.replace(/(^|\s+)#.*$/, '').trim();
  }
  return '';
}

export function readGameDirFromEnv(repoRoot) {
  const file = join(repoRoot, '.env');
  if (!existsSync(file)) return '';
  return readEnvValue(readFileSync(file, 'utf8'), 'GAME_DIR');
}

// Resolves symlinks and 8.3 names of the part that exists, so folders compare reliably.
function realResolve(path) {
  const absolute = resolve(path);
  const tail = [];
  let current = absolute;
  for (;;) {
    try {
      return join(realpathSync.native(current), ...tail.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) return absolute;
      tail.push(basename(current));
      current = parent;
    }
  }
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function requireDirectory(path, flag) {
  let info;
  try {
    info = statSync(path);
  } catch {
    throw new Error(`${flag} does not exist: ${path}`);
  }
  if (!info.isDirectory()) throw new Error(`${flag} is not a folder: ${path}`);
}

export function assertLayout({ gameDir, generalsDir, out, repoRoot }) {
  requireDirectory(gameDir, '--game-dir');
  if (generalsDir) requireDirectory(generalsDir, '--generals-dir');

  const realOut = realResolve(out);
  const realRepo = realResolve(repoRoot);
  if (isInside(realOut, realRepo)) {
    throw new Error(`refusing --out ${realOut}: it is inside the git repo (${realRepo}) and game data must never be near the repo`);
  }
  if (isInside(realRepo, realOut)) {
    throw new Error(`refusing --out ${realOut}: it contains the git repo (${realRepo})`);
  }
  const sources = [['--game-dir', gameDir], ['--generals-dir', generalsDir]].filter(([, dir]) => dir);
  for (const [flag, dir] of sources) {
    const real = realResolve(dir);
    if (isInside(realOut, real) || isInside(real, realOut)) {
      throw new Error(`refusing --out ${realOut}: it overlaps ${flag} (${real}), and pruning --out would delete game files`);
    }
  }
  if (generalsDir) {
    const a = realResolve(gameDir);
    const b = realResolve(generalsDir);
    if (isInside(a, b) || isInside(b, a)) {
      throw new Error(`--game-dir and --generals-dir overlap (${a}, ${b}); pass the two install folders separately`);
    }
  }
}

export function assertSafePath(path) {
  const segments = path.split('/');
  const unsafe = path === ''
    || path.startsWith('/')
    || /^[A-Za-z]:/.test(path)
    || /[\\\u0000-\u001f:*?"<>|]/.test(path)
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..' || /[. ]$/.test(segment));
  if (unsafe) throw new Error(`file name cannot be stored as a manifest path: ${JSON.stringify(path)}`);
}

export function assertNoCollisions(paths) {
  const seen = new Map();
  for (const path of paths) {
    const key = path.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`two files map to the same path when case is ignored (the engine ignores case): ${JSON.stringify(seen.get(key))} and ${JSON.stringify(path)}`);
    }
    seen.set(key, path);
  }
}

export function compareBytes(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}

async function statOrNull(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

// Lists regular files below `root`. Symlinks and junctions are not followed.
async function listFiles(root, links) {
  const files = [];
  async function visit(dir, prefix) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) links.push(rel);
      else if (entry.isDirectory()) await visit(abs, rel);
      else if (entry.isFile()) files.push({ rel, abs, size: (await stat(abs)).size });
    }
  }
  await visit(root, '');
  return files;
}

async function collect(dir, root, prefix, links) {
  const selected = [];
  const excluded = [];
  let ignored = 0;
  for (const file of await listFiles(dir, links)) {
    const path = prefix ? `${prefix}/${file.rel}` : file.rel;
    const verdict = classify(file.rel, root);
    if (verdict.action === 'include') selected.push({ path, abs: file.abs, size: file.size, rule: verdict.rule });
    else if (verdict.action === 'exclude') excluded.push({ path, rule: verdict.rule });
    else ignored += 1;
  }
  return { selected, excluded, ignored };
}

async function readChunks(handle, chunkSize, onChunk) {
  const buffer = Buffer.allocUnsafe(chunkSize);
  let total = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, chunkSize, null);
    if (bytesRead === 0) return total;
    total += bytesRead;
    await onChunk(buffer.subarray(0, bytesRead), total);
  }
}

async function hashFile(path, chunkSize) {
  const hash = createHash('sha256');
  const handle = await open(path, 'r');
  try {
    const bytes = await readChunks(handle, chunkSize, (chunk) => { hash.update(chunk); });
    return { sha256: hash.digest('hex'), bytes };
  } finally {
    await handle.close();
  }
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    offset += bytesWritten;
  }
}

function tempName(path) {
  return `${path}${TEMP_MARK}${process.pid}-${randomBytes(4).toString('hex')}`;
}

// Windows can refuse a rename for a moment while a virus scanner or indexer has the new file open.
async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await new Promise((done) => setTimeout(done, 50 * attempt));
    }
  }
}

// Streams src to a temp file next to dst while hashing, then renames it into place.
// On any failure the temp file is removed and dst is untouched. A hard kill leaves only the
// temp file, which the next run removes.
async function copyAtomic(file, dst, { chunkSize, hooks }) {
  await mkdir(dirname(dst), { recursive: true });
  const temp = tempName(dst);
  const hash = createHash('sha256');
  const input = await open(file.abs, 'r');
  let output;
  let placed = false;
  try {
    output = await open(temp, 'wx');
    const bytes = await readChunks(input, chunkSize, async (chunk, total) => {
      hash.update(chunk);
      await writeAll(output, chunk);
      if (hooks.afterChunk) await hooks.afterChunk({ path: file.path, bytes: total });
    });
    if (bytes !== file.size) throw new Error(`${file.abs} changed while it was being copied (expected ${file.size} bytes, read ${bytes})`);
    await output.sync();
    await output.close();
    output = undefined;
    await renameWithRetry(temp, dst);
    placed = true;
    return { sha256: hash.digest('hex'), bytes };
  } finally {
    await input.close();
    if (output) await output.close().catch(() => {});
    if (!placed) await rm(temp, { force: true });
  }
}

async function processFile(file, out, { dryRun, chunkSize, hooks }) {
  const dst = join(out, ...file.path.split('/'));
  const existing = await statOrNull(dst);
  if (existing && !existing.isFile()) throw new Error(`${dst} exists and is not a file`);

  let source;
  if (existing && existing.size === file.size) {
    source = await hashFile(file.abs, chunkSize);
    if (source.bytes !== file.size) throw new Error(`${file.abs} changed while it was being read`);
    if (source.sha256 === (await hashFile(dst, chunkSize)).sha256) return { sha256: source.sha256, copied: false };
  }
  if (dryRun) {
    source ??= await hashFile(file.abs, chunkSize);
    if (source.bytes !== file.size) throw new Error(`${file.abs} changed while it was being read`);
    return { sha256: source.sha256, copied: true };
  }
  const copy = await copyAtomic(file, dst, { chunkSize, hooks });
  if (source && source.sha256 !== copy.sha256) throw new Error(`${file.abs} changed while it was being copied`);
  return { sha256: copy.sha256, copied: true };
}

async function assertOutUsable(out) {
  const info = await statOrNull(out);
  if (!info) return;
  if (!info.isDirectory()) throw new Error(`--out is not a folder: ${out}`);
  const names = await readdir(out);
  if (names.length === 0 || names.includes(MARKER_NAME) || names.includes(MANIFEST_NAME)) return;
  throw new Error(`--out ${out} is not empty and was not created by this tool (no ${MARKER_NAME} or ${MANIFEST_NAME}); refusing to use it, because files that are not in the manifest get deleted`);
}

// Removes everything in `out` that is not a manifest file, the marker, or a file we just placed.
// Returns the removed paths (what would be removed, for a dry run).
async function pruneOut(out, entries, dryRun) {
  if (!(await statOrNull(out))) return [];
  const fold = (path) => (FOLD_CASE ? path.toLowerCase() : path);
  const keep = new Set([...entries.map((entry) => entry.path), MANIFEST_NAME, MARKER_NAME].map(fold));
  const removed = [];
  const dirs = [];
  async function visit(dir, prefix) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        dirs.push(abs);
        await visit(abs, rel);
      } else if (!keep.has(fold(rel))) {
        removed.push(rel);
        if (!dryRun) await rm(abs, { force: true });
      }
    }
  }
  await visit(out, '');
  if (!dryRun) {
    for (const dir of dirs.reverse()) {
      // Cosmetic: a folder that still holds files (or is busy) just stays.
      await rmdir(dir).catch(() => {});
    }
  }
  return removed.sort(compareBytes);
}

export function contentVersion(files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
  return hash.digest('hex').slice(0, 16);
}

export function formatManifest({ version, generatedAt, totalBytes, files }) {
  const lines = [
    '{',
    `  "schema": ${SCHEMA},`,
    `  "version": ${JSON.stringify(version)},`,
    `  "generatedAt": ${JSON.stringify(generatedAt)},`,
    `  "totalBytes": ${totalBytes},`,
  ];
  if (files.length === 0) lines.push('  "files": []');
  else {
    lines.push('  "files": [');
    files.forEach((file, index) => {
      const comma = index < files.length - 1 ? ',' : '';
      lines.push(`    { "path": ${JSON.stringify(file.path)}, "size": ${file.size}, "sha256": "${file.sha256}" }${comma}`);
    });
    lines.push('  ]');
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

async function writeFileAtomic(path, text) {
  const temp = tempName(path);
  let handle;
  let placed = false;
  try {
    handle = await open(temp, 'wx');
    await writeAll(handle, Buffer.from(text, 'utf8'));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(temp, path);
    placed = true;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (!placed) await rm(temp, { force: true });
  }
}

function isoSeconds(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// options: { gameDir, generalsDir?, out, version?, dryRun? }, all folders already absolute.
// ctx: { repoRoot, stdout, now, chunkSize, hooks } (the last three are test seams).
export async function ingest(options, ctx = {}) {
  const { gameDir, generalsDir, out, dryRun = false } = options;
  const log = ctx.stdout ?? (() => {});
  const chunkSize = ctx.chunkSize ?? DEFAULT_CHUNK;
  const now = ctx.now ?? (() => new Date());
  const hooks = ctx.hooks ?? {};
  if (options.version !== undefined) assertVersion(options.version);

  assertLayout({ gameDir, generalsDir, out, repoRoot: ctx.repoRoot ?? REPO_ROOT });

  const links = [];
  const zeroHour = await collect(gameDir, ROOT_ZERO_HOUR, '', links);
  const base = generalsDir ? await collect(generalsDir, ROOT_GENERALS, GENERALS_PREFIX, links) : { selected: [], excluded: [], ignored: 0 };
  const selected = [...zeroHour.selected, ...base.selected];
  const excluded = [...zeroHour.excluded, ...base.excluded];
  const ignored = zeroHour.ignored + base.ignored;
  for (const link of links) log(`warning: symbolic link not followed: ${link}`);

  if (selected.length === 0) {
    throw new Error(`no game files found under ${gameDir}; --game-dir must be the Zero Hour folder (the one with the *.big archives)`);
  }
  for (const file of selected) assertSafePath(file.path);
  assertNoCollisions(selected.map((file) => file.path));
  selected.sort((a, b) => compareBytes(a.path, b.path));
  if (dryRun) for (const file of excluded.sort((a, b) => compareBytes(a.path, b.path))) log(`exclude ${file.path} (${file.rule})`);

  await assertOutUsable(out);
  if (!dryRun) {
    await mkdir(out, { recursive: true });
    if (!existsSync(join(out, MARKER_NAME))) {
      await writeFileAtomic(join(out, MARKER_NAME), 'WebGeneralsOnline asset directory, written by tools/ingest-assets.\nFiles that are not listed in manifest.json are removed on the next run.\n');
    }
  }

  const entries = [];
  let copied = 0;
  let copiedBytes = 0;
  let skipped = 0;
  for (const file of selected) {
    const result = await processFile(file, out, { dryRun, chunkSize, hooks });
    entries.push({ path: file.path, size: file.size, sha256: result.sha256 });
    if (result.copied) {
      copied += 1;
      copiedBytes += file.size;
      log(`${dryRun ? 'would copy' : 'copy'} ${file.path} (${formatBytes(file.size)})`);
    } else skipped += 1;
  }

  const removed = await pruneOut(out, entries, dryRun);
  for (const path of removed) log(`${dryRun ? 'would remove' : 'remove'} ${path}`);

  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  const version = options.version ?? contentVersion(entries);
  const manifestPath = join(out, MANIFEST_NAME);
  if (!dryRun) {
    const text = formatManifest({ version, generatedAt: isoSeconds(now()), totalBytes, files: entries });
    await writeFileAtomic(manifestPath, text);
  }

  const summary = { files: entries.length, totalBytes, copied, copiedBytes, skipped, removed: removed.length, excluded: excluded.length, ignored, version, manifest: dryRun ? null : manifestPath };
  log('');
  log(dryRun ? 'summary (dry run, nothing was written)' : 'summary');
  log(`  files:    ${summary.files}`);
  log(`  bytes:    ${summary.totalBytes} (${formatBytes(summary.totalBytes)})`);
  log(`  copied:   ${summary.copied} (${formatBytes(summary.copiedBytes)})`);
  log(`  skipped:  ${summary.skipped} (already up to date)`);
  log(`  removed:  ${summary.removed}`);
  log(`  left out: ${summary.excluded} excluded by rule, ${summary.ignored} not needed by the game`);
  log(`  version:  ${summary.version}`);
  log(`  manifest: ${summary.manifest ?? '(not written)'}`);
  return summary;
}

export async function run(argv, ctx = {}) {
  const stdout = ctx.stdout ?? ((line) => console.log(line));
  const stderr = ctx.stderr ?? ((line) => console.error(line));
  const repoRoot = ctx.repoRoot ?? REPO_ROOT;
  try {
    const args = parseArgs(argv);
    if (args.help) {
      stdout(USAGE);
      return 0;
    }
    if (args.version !== undefined) assertVersion(args.version);

    let gameDir;
    if (args.gameDir) {
      gameDir = resolve(args.gameDir);
      stdout(`game dir: ${gameDir}`);
    } else {
      const fromEnv = readGameDirFromEnv(repoRoot);
      if (!fromEnv) throw new UsageError('no game folder: pass --game-dir <path>, or set GAME_DIR in the .env file at the repo root');
      gameDir = resolve(repoRoot, fromEnv);
      stdout(`game dir: ${gameDir} (GAME_DIR from .env)`);
    }
    if (!args.out) throw new UsageError('--out <dir> is required');

    const generalsDir = args.generalsDir ? resolve(args.generalsDir) : undefined;
    if (generalsDir) stdout(`generals dir: ${generalsDir}`);
    else stdout('note: no --generals-dir given. Zero Hour also loads the base Generals archives; see the README. Ignore this if both are installed in the one folder.');

    await ingest({ gameDir, generalsDir, out: resolve(args.out), version: args.version, dryRun: args.dryRun }, { ...ctx, stdout, repoRoot });
    return 0;
  } catch (error) {
    stderr(`ingest: ${error.message}`);
    if (error instanceof UsageError) {
      stderr(USAGE);
      return 2;
    }
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2));
}

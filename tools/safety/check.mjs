#!/usr/bin/env node
// Blocks EA game data, oversized files and secrets from entering the repo.
//
//   --staged       files in the index that differ from HEAD (pre-commit hook)
//   --all          every file tracked at HEAD (CI)
//   --range A..B   files added or changed by non-merge, first-parent commits (CI)
//
// Secret values come from .env at the repo root and from the SAFETY_ENV_VALUES
// environment variable (.env-formatted text, set from a CI secret). Reports name
// the key and the file, never the value.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORBIDDEN_EXTENSIONS = new Set([
  '.big', '.bik', '.csf', '.dds', '.map', '.mp3', '.tga', '.w3d', '.wav',
]);
export const MAX_BYTES = 5 * 1024 * 1024;
const MIN_SECRET_LENGTH = 4;
const GITLINK_MODE = '160000';

function git(args, options = {}) {
  const result = spawnSync('git', args, { maxBuffer: Infinity, ...options });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

function splitNul(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function stagedEntries() {
  const changed = new Set(splitNul(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])));
  const entries = [];
  for (const record of splitNul(git(['ls-files', '-s', '-z']))) {
    const [meta, path] = record.split('\t');
    const [mode, sha] = meta.split(' ');
    if (changed.has(path)) entries.push({ mode, sha, path });
  }
  return entries;
}

function headEntries() {
  const entries = [];
  for (const record of splitNul(git(['ls-tree', '-r', '-z', 'HEAD']))) {
    const [meta, path] = record.split('\t');
    const [mode, , sha] = meta.split(' ');
    entries.push({ mode, sha, path });
  }
  return entries;
}

function rangeEntries(range) {
  const commits = git(['rev-list', '--first-parent', '--no-merges', range]).toString('utf8').split('\n').filter(Boolean);
  const entries = new Map();
  for (const commit of commits) {
    const fields = splitNul(git(['diff-tree', '--no-commit-id', '--root', '-r', '-z', '--no-renames', '--diff-filter=ACM', commit]));
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const [, mode, , sha] = fields[i].split(' ');
      const path = fields[i + 1];
      entries.set(`${sha} ${path}`, { mode, sha, path });
    }
  }
  return [...entries.values()];
}

export function parseEnvValues(text) {
  const values = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const body = match[2].trim();
    const quoted = body.match(/^(['"])(.*?)\1/);
    const raw = quoted ? quoted[2] : body.replace(/(^|\s+)#.*$/, '').trim();
    if (raw.length < MIN_SECRET_LENGTH) continue;
    values.push({ key: match[1], value: raw });
    if (raw.includes('\\')) values.push({ key: match[1], value: raw.replaceAll('\\', '/') });
  }
  return values;
}

function loadSecrets(root) {
  const secrets = [];
  const envFile = join(root, '.env');
  if (existsSync(envFile)) secrets.push(...parseEnvValues(readFileSync(envFile, 'utf8')));
  if (process.env.SAFETY_ENV_VALUES) secrets.push(...parseEnvValues(process.env.SAFETY_ENV_VALUES));
  return secrets;
}

function loadAllowlist(root) {
  const file = join(root, 'tools', 'safety', 'allowlist.txt');
  const allowed = new Set();
  if (!existsSync(file)) return allowed;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf(' ');
    allowed.add(`${trimmed.slice(0, separator)} ${trimmed.slice(separator + 1).trim()}`);
  }
  return allowed;
}

function blobSizes(shas) {
  const unique = [...new Set(shas)];
  if (unique.length === 0) return new Map();
  const output = git(['cat-file', '--batch-check=%(objectname) %(objectsize)'], { input: unique.join('\n') + '\n' });
  const sizes = new Map();
  for (const line of output.toString('utf8').split('\n')) {
    const [sha, size] = line.split(' ');
    if (sha && size) sizes.set(sha, Number(size));
  }
  return sizes;
}

function blobContents(shas) {
  const unique = [...new Set(shas)];
  if (unique.length === 0) return new Map();
  const output = git(['cat-file', '--batch'], { input: unique.join('\n') + '\n' });
  const contents = new Map();
  let offset = 0;
  while (offset < output.length) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) break;
    const [sha, , size] = output.subarray(offset, newline).toString('utf8').split(' ');
    const length = Number(size);
    contents.set(sha, output.subarray(newline + 1, newline + 1 + length));
    offset = newline + 1 + length + 1;
  }
  return contents;
}

function isForbiddenEnvFile(path) {
  const name = posix.basename(path).toLowerCase();
  return name !== '.env.example' && (name === '.env' || name.startsWith('.env.'));
}

export function findProblems(entries, { allowlist, secrets }) {
  const problems = [];
  const files = entries.filter((entry) => entry.mode !== GITLINK_MODE);
  const sizes = blobSizes(files.map((entry) => entry.sha));

  for (const { sha, path } of files) {
    const allowed = allowlist.has(`${sha} ${path}`);
    if (isForbiddenEnvFile(path)) problems.push(`${path}: secrets file must not be committed`);
    if (FORBIDDEN_EXTENSIONS.has(posix.extname(path).toLowerCase()) && !allowed) {
      problems.push(`${path}: forbidden file type (not on the allowlist with this exact content)`);
    }
    if ((sizes.get(sha) ?? 0) > MAX_BYTES && !allowed) {
      problems.push(`${path}: larger than ${MAX_BYTES / (1024 * 1024)} MB`);
    }
  }

  if (secrets.length > 0) {
    const contents = blobContents(files.map((entry) => entry.sha));
    for (const { sha, path } of files) {
      const blob = contents.get(sha);
      if (!blob) continue;
      const hits = new Set(secrets.filter(({ value }) => blob.includes(value)).map(({ key }) => key));
      for (const key of hits) problems.push(`${path}: contains the value of ${key}`);
    }
    for (const { path } of files) {
      for (const key of new Set(secrets.filter(({ value }) => path.includes(value)).map(({ key }) => key))) {
        problems.push(`${path}: file name contains the value of ${key}`);
      }
    }
  }
  return problems;
}

function main(argv) {
  const root = git(['rev-parse', '--show-toplevel']).toString('utf8').trim();
  const [mode, value] = argv;
  let entries;
  if (mode === '--staged') entries = stagedEntries();
  else if (mode === '--all') entries = headEntries();
  else if (mode === '--range' && value) entries = rangeEntries(value);
  else {
    console.error('usage: check.mjs --staged | --all | --range A..B');
    return 2;
  }

  const secrets = loadSecrets(root);
  const problems = findProblems(entries, { allowlist: loadAllowlist(root), secrets });
  console.log(`safety: scanned ${entries.length} files, ${secrets.length > 0 ? 'with' : 'WITHOUT'} secret values to compare`);
  if (problems.length === 0) return 0;
  console.error('safety: BLOCKED');
  for (const problem of problems) console.error(`  ${problem}`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}

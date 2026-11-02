/** Manifest format from docs/WEB_CONTRACT.md. */
export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface Manifest {
  schema: 1;
  version: string;
  generatedAt: string;
  totalBytes: number;
  files: ManifestFile[];
}

export class ManifestError extends Error {
  override name = 'ManifestError';
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_PATH_LENGTH = 512;

/** Name of the installed-manifest file inside /game. A game file may not use it. */
export const INSTALLED_MANIFEST_NAME = 'manifest.json';

/** Returns a problem description, or null when the path is acceptable. */
export function pathProblem(path: unknown): string | null {
  if (typeof path !== 'string' || path.length === 0) return 'path must be a non-empty string';
  if (path.length > MAX_PATH_LENGTH) return 'path is too long';
  if (CONTROL_CHARACTERS.test(path)) return 'path contains control characters';
  if (path.includes('\\')) return 'path must use forward slashes';
  if (path.startsWith('/')) return 'path must be relative';
  if (/^[A-Za-z]:/.test(path)) return 'path must not start with a drive letter';
  for (const segment of path.split('/')) {
    if (segment === '') return 'path has an empty segment';
    if (segment === '.' || segment === '..') return 'path must not contain . or .. segments';
  }
  if (path === INSTALLED_MANIFEST_NAME) return `path collides with the installed manifest (${INSTALLED_MANIFEST_NAME})`;
  return null;
}

function fail(message: string): never {
  throw new ManifestError(message);
}

/** Validates untrusted JSON and returns a typed manifest. Throws ManifestError. */
export function parseManifest(input: unknown): Manifest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail('manifest is not an object');
  const raw = input as Record<string, unknown>;
  if (raw.schema !== 1) fail(`unsupported manifest schema ${String(raw.schema)}; this shell understands schema 1`);
  if (typeof raw.version !== 'string' || raw.version === '') fail('manifest has no version');
  if (!Array.isArray(raw.files)) fail('manifest has no files array');

  const seen = new Set<string>();
  const directories = new Set<string>();
  const files: ManifestFile[] = [];
  let total = 0;
  for (const [index, item] of raw.files.entries()) {
    if (typeof item !== 'object' || item === null) fail(`files[${index}] is not an object`);
    const entry = item as Record<string, unknown>;
    const problem = pathProblem(entry.path);
    if (problem) fail(`files[${index}]: ${problem}`);
    const path = entry.path as string;
    if (seen.has(path)) fail(`duplicate path ${path}`);
    seen.add(path);
    const size = entry.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) fail(`${path}: size must be a non-negative integer`);
    const sha256 = entry.sha256;
    if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) fail(`${path}: sha256 must be 64 lowercase hex characters`);
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i += 1) directories.add(segments.slice(0, i).join('/'));
    files.push({ path, size, sha256 });
    total += size;
  }
  for (const path of seen) {
    if (directories.has(path)) fail(`${path} is used both as a file and as a directory`);
  }

  // The sum of the file sizes is authoritative; totalBytes in the file is only informational.
  return {
    schema: 1,
    version: raw.version,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
    totalBytes: total,
    files,
  };
}

export type DiffReason = 'new' | 'changed' | 'missing' | 'size-mismatch';

export interface DiffEntry {
  file: ManifestFile;
  reason: DiffReason;
}

export interface ManifestDiff {
  /** Files to fetch, in manifest order. */
  download: DiffEntry[];
  /** Paths listed in the installed manifest but not in the new one. */
  remove: string[];
  /** Files that are already installed and need nothing. */
  unchanged: ManifestFile[];
  bytesToDownload: number;
}

/**
 * Compares the installed manifest with the server manifest.
 *
 * `onDisk` maps path -> size for files actually present in /game. When given, a file the installed
 * manifest vouches for is still re-downloaded if it is missing or has the wrong size, which covers
 * evicted or damaged storage. Without it the installed manifest is trusted as is.
 */
export function diffManifest(
  installed: Manifest | null,
  remote: Manifest,
  onDisk?: ReadonlyMap<string, number>,
): ManifestDiff {
  const installedByPath = new Map<string, ManifestFile>();
  for (const file of installed?.files ?? []) installedByPath.set(file.path, file);

  const download: DiffEntry[] = [];
  const unchanged: ManifestFile[] = [];
  let bytesToDownload = 0;

  for (const file of remote.files) {
    const known = installedByPath.get(file.path);
    let reason: DiffReason | null = null;
    if (!known) reason = 'new';
    else if (known.sha256 !== file.sha256 || known.size !== file.size) reason = 'changed';
    else if (onDisk) {
      const size = onDisk.get(file.path);
      if (size === undefined) reason = 'missing';
      else if (size !== file.size) reason = 'size-mismatch';
    }
    if (reason) {
      download.push({ file, reason });
      bytesToDownload += file.size;
    } else {
      unchanged.push(file);
    }
  }

  const remotePaths = new Set(remote.files.map((file) => file.path));
  const remove = [...installedByPath.keys()].filter((path) => !remotePaths.has(path));
  return { download, remove, unchanged, bytesToDownload };
}

/** True when both manifests describe exactly the same files. */
export function manifestsEqual(a: Manifest, b: Manifest): boolean {
  if (a.version !== b.version || a.files.length !== b.files.length) return false;
  return a.files.every((file, i) => {
    const other = b.files[i];
    return other !== undefined && other.path === file.path && other.size === file.size && other.sha256 === file.sha256;
  });
}

/**
 * Paths present in /game that the new manifest does not list. This also catches leftovers from
 * an interrupted install, which the installed manifest never knew about. The installed manifest
 * file itself is never reported.
 */
export function findStalePaths(present: Iterable<string>, remote: Manifest): string[] {
  const keep = new Set(remote.files.map((file) => file.path));
  const stale: string[] = [];
  for (const path of present) {
    if (path === INSTALLED_MANIFEST_NAME) continue;
    if (!keep.has(path)) stale.push(path);
  }
  return stale;
}

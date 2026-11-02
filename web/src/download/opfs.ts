/**
 * Origin private file system helpers for the download worker.
 *
 * Layout (docs/WEB_CONTRACT.md, plus the staging area this shell adds):
 *   /game/<path>            verified game files
 *   /game/manifest.json     installed manifest, written last
 *   /partial/data/<path>    downloads in progress
 *   /partial/meta/<path>.json  ETag and expected hash of each partial file
 *   /player/                player data. Never opened by this code.
 */

import { assertWritableRoot, basenameOf, dirnameOf, splitPath, type WritableRoot } from '../paths';

export async function openRoot(name: WritableRoot): Promise<FileSystemDirectoryHandle> {
  assertWritableRoot(name);
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create: true });
}

export function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError');
}

export function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'QuotaExceededError';
}

export async function getDir(
  root: FileSystemDirectoryHandle,
  dirPath: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  let dir = root;
  if (dirPath === '') return dir;
  for (const segment of splitPath(dirPath)) {
    try {
      dir = await dir.getDirectoryHandle(segment, { create });
    } catch (error) {
      if (!create && isNotFound(error)) return null;
      throw error;
    }
  }
  return dir;
}

export async function getFile(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<FileSystemFileHandle | null> {
  const dir = await getDir(root, dirnameOf(path), create);
  if (!dir) return null;
  try {
    return await dir.getFileHandle(basenameOf(path), { create });
  } catch (error) {
    if (!create && isNotFound(error)) return null;
    throw error;
  }
}

/** Size in bytes, or null if the file does not exist. */
export async function statFile(root: FileSystemDirectoryHandle, path: string): Promise<number | null> {
  const handle = await getFile(root, path, false);
  if (!handle) return null;
  return (await handle.getFile()).size;
}

export async function readText(root: FileSystemDirectoryHandle, path: string): Promise<string | null> {
  const handle = await getFile(root, path, false);
  if (!handle) return null;
  return (await handle.getFile()).text();
}

/** Replaces a file in one step: readers see the old content or the new content, never half. */
export async function writeTextAtomic(root: FileSystemDirectoryHandle, path: string, text: string): Promise<void> {
  const handle = await getFile(root, path, true);
  if (!handle) throw new Error(`could not create ${path}`);
  const writable = await handle.createWritable();
  try {
    await writable.write(text);
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
  await writable.close();
}

export async function removeFile(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  const dir = await getDir(root, dirnameOf(path), false);
  if (!dir) return;
  try {
    await dir.removeEntry(basenameOf(path));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/** All files below `root`, as relative paths. */
export async function listFiles(root: FileSystemDirectoryHandle, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for await (const [name, handle] of root.entries()) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (handle.kind === 'directory') found.push(...(await listFiles(handle as FileSystemDirectoryHandle, path)));
    else found.push(path);
  }
  return found;
}

/** Removes directories left empty by deletions. Never removes `root` itself. */
export async function pruneEmptyDirs(root: FileSystemDirectoryHandle): Promise<void> {
  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== 'directory') continue;
    const dir = handle as FileSystemDirectoryHandle;
    await pruneEmptyDirs(dir);
    let empty = true;
    for await (const _ of dir.entries()) {
      empty = false;
      break;
    }
    if (empty) await root.removeEntry(name);
  }
}

/** Moves a closed file into `destRoot/destPath`, replacing whatever is there. */
export async function moveInto(
  source: FileSystemFileHandle,
  destRoot: FileSystemDirectoryHandle,
  destPath: string,
): Promise<void> {
  const dir = await getDir(destRoot, dirnameOf(destPath), true);
  if (!dir) throw new Error(`could not create directory for ${destPath}`);
  const name = basenameOf(destPath);
  try {
    await dir.removeEntry(name);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await source.move(dir, name);
}

/**
 * Download worker. Fetches the server manifest, compares it with the installed one in OPFS,
 * downloads what is missing or changed (resuming partial files), verifies SHA-256, removes files
 * the manifest no longer lists, and writes the installed manifest last.
 *
 * The installed manifest only appears once every file has verified, so a closed tab always
 * resumes: partial files stay in /partial, verified files are already in /game, and the next run
 * re-checks anything the old manifest does not vouch for.
 */

import { createSHA256 } from 'hash-wasm';
import { assetFileUrl } from '../paths';
import {
  INSTALLED_MANIFEST_NAME,
  diffManifest,
  findStalePaths,
  manifestsEqual,
  parseManifest,
  type Manifest,
  type ManifestFile,
} from './manifest';
import {
  getFile,
  isQuotaError,
  listFiles,
  moveInto,
  openRoot,
  pruneEmptyDirs,
  readText,
  removeFile,
  statFile,
  writeTextAtomic,
} from './opfs';
import type { FromWorker, LimitOverride, ProgressMessage, ToWorker, WorkerError, WorkerErrorCode } from './protocol';
import {
  MAX_STALLED_ATTEMPTS,
  MAX_VERIFY_FAILURES,
  interpretResponse,
  planResume,
  retryDelayMs,
  usableEtag,
  type PartialMeta,
  type ResponseAction,
} from './resume';
import { MIB, chooseLimits, pickNext, sortForDispatch, type PoolLimits } from './schedule';

interface WorkerScope {
  postMessage(message: FromWorker): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
}
const scope = self as unknown as WorkerScope;

const LOCK_NAME = 'wgo-installer';
const HANDLE_RETRIES = 5;
const HASH_BLOCK = 4 * MIB;
const FLUSH_EVERY = 16 * MIB;
const PROGRESS_INTERVAL_MS = 100;
const MANIFEST_ATTEMPTS = 3;

function post(message: FromWorker): void {
  scope.postMessage(message);
}

function log(level: 'info' | 'warn' | 'error', text: string): void {
  post({ type: 'log', level, text });
}

class InstallFailure extends Error {
  constructor(readonly info: WorkerError) {
    super(info.message);
    this.name = 'InstallFailure';
  }
}

/** Trouble that is worth another attempt: dropped connection, 5xx, short body. */
class RetryableError extends Error {
  override name = 'RetryableError';
}

function failure(code: WorkerErrorCode, message: string, extra: Partial<WorkerError> = {}): InstallFailure {
  return new InstallFailure({ code, message, ...extra });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// --- progress -------------------------------------------------------------------------------

class Progress {
  received = 0;
  filesDone = 0;
  private readonly counted = new Map<string, number>();
  private readonly active: string[] = [];
  private readonly hashing = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly totalBytes: number,
    readonly filesTotal: number,
  ) {}

  setCounted(path: string, bytes: number): void {
    this.received += bytes - (this.counted.get(path) ?? 0);
    this.counted.set(path, bytes);
  }

  add(path: string, bytes: number): void {
    this.setCounted(path, (this.counted.get(path) ?? 0) + bytes);
  }

  begin(path: string): void {
    this.active.unshift(path);
  }

  end(path: string, done: boolean): void {
    const index = this.active.indexOf(path);
    if (index >= 0) this.active.splice(index, 1);
    this.hashing.delete(path);
    if (done) this.filesDone += 1;
  }

  setHashing(path: string, on: boolean): void {
    if (on) this.hashing.add(path);
    else this.hashing.delete(path);
  }

  snapshot(): ProgressMessage {
    return {
      type: 'progress',
      receivedBytes: this.received,
      totalBytes: this.totalBytes,
      filesDone: this.filesDone,
      filesTotal: this.filesTotal,
      active: this.active.slice(0, 4),
      verifying: this.active.length > 0 && this.active.every((path) => this.hashing.has(path)),
    };
  }

  start(): void {
    this.stop();
    post(this.snapshot());
    this.timer = setInterval(() => post(this.snapshot()), PROGRESS_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

// --- hashing --------------------------------------------------------------------------------

async function hashAccess(access: FileSystemSyncAccessHandle, size: number, signal: AbortSignal): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  const block = new Uint8Array(HASH_BLOCK);
  let position = 0;
  let lastYield = performance.now();
  while (position < size) {
    signal.throwIfAborted();
    const wanted = Math.min(HASH_BLOCK, size - position);
    const read = access.read(block.subarray(0, wanted), { at: position });
    if (read === 0) break;
    hasher.update(block.subarray(0, read));
    position += read;
    // Let the progress timer and other downloads run while a big file is being hashed.
    if (performance.now() - lastYield > 40) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }
  return hasher.digest('hex');
}

async function fileMatches(game: FileSystemDirectoryHandle, file: ManifestFile, signal: AbortSignal): Promise<boolean> {
  const handle = await getFile(game, file.path, false);
  if (!handle) return false;
  const access = await handle.createSyncAccessHandle();
  try {
    if (access.getSize() !== file.size) return false;
    return (await hashAccess(access, file.size, signal)) === file.sha256;
  } finally {
    access.close();
  }
}

// --- storage --------------------------------------------------------------------------------

async function storageSnapshot(): Promise<{ quota: number; usage: number } | null> {
  try {
    const estimate = await navigator.storage.estimate();
    if (typeof estimate.quota !== 'number') return null;
    return { quota: estimate.quota, usage: estimate.usage ?? 0 };
  } catch {
    return null;
  }
}

function storageFailure(needed: number, snapshot: { quota: number; usage: number } | null, refused = false): InstallFailure {
  const available = snapshot ? Math.max(0, snapshot.quota - snapshot.usage) : 0;
  return failure('storage', 'Not enough storage space for the game files.', { needed, available, refused });
}

/** Progress of the install in flight, so a refused write can say how much was still needed. */
let activeProgress: Progress | null = null;

// --- partial-file bookkeeping ----------------------------------------------------------------

interface Context {
  signal: AbortSignal;
  progress: Progress;
  game: FileSystemDirectoryHandle;
  partialData: FileSystemDirectoryHandle;
  partialMeta: FileSystemDirectoryHandle;
}

const metaPath = (path: string) => `${path}.json`;

async function readMeta(ctx: Context, path: string): Promise<PartialMeta | null> {
  try {
    const text = await readText(ctx.partialMeta, metaPath(path));
    if (text === null) return null;
    const raw = JSON.parse(text) as Partial<PartialMeta>;
    if (typeof raw.sha256 !== 'string' || typeof raw.size !== 'number') return null;
    return { sha256: raw.sha256, size: raw.size, etag: typeof raw.etag === 'string' ? raw.etag : null };
  } catch {
    return null;
  }
}

async function writeMeta(ctx: Context, path: string, meta: PartialMeta): Promise<void> {
  await writeTextAtomic(ctx.partialMeta, metaPath(path), JSON.stringify(meta));
}

// --- one file -------------------------------------------------------------------------------

/** Opens the exclusive handle, waiting briefly if a dead tab's handle has not been released yet. */
async function openAccess(handle: FileSystemFileHandle, path: string, signal: AbortSignal): Promise<FileSystemSyncAccessHandle> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await handle.createSyncAccessHandle();
    } catch (error) {
      const busy = error instanceof DOMException && error.name === 'NoModificationAllowedError';
      if (!busy) throw error;
      if (attempt >= HANDLE_RETRIES) throw failure('locked', 'Another tab or window is using the game files.', { path });
      await sleep(1000, signal);
    }
  }
}

type Resume = { offset: number; etag: string } | null;

function failureFor(action: Extract<ResponseAction, { action: 'fail' }>, path: string): InstallFailure {
  switch (action.code) {
    case 'auth':
      return failure('auth', 'The session is no longer valid.', { status: action.status, path });
    case 'missing':
      return failure('server', `The server does not have ${path} (HTTP ${action.status}).`, { status: action.status, path });
    case 'changed':
      return failure('integrity', 'The file on the server no longer matches the manifest. Retrying fetches the new manifest.', { path });
    default:
      return failure('server', `Unexpected HTTP ${action.status} for ${path}.`, { status: action.status, path });
  }
}

/** Fetches one file (or the rest of it) into the open partial file. */
async function transfer(
  file: ManifestFile,
  access: FileSystemSyncAccessHandle,
  resume: Resume,
  ctx: Context,
): Promise<'complete' | 'restart'> {
  const offset = resume?.offset ?? 0;
  const headers = new Headers();
  if (resume) {
    headers.set('Range', `bytes=${offset}-`);
    headers.set('If-Range', resume.etag);
  }
  const response = await fetch(assetFileUrl(file.path), {
    headers,
    signal: ctx.signal,
    cache: 'no-store',
    credentials: 'same-origin',
  });
  const lengthHeader = response.headers.get('Content-Length');
  const action = interpretResponse({
    status: response.status,
    contentRange: response.headers.get('Content-Range'),
    contentLength: lengthHeader === null ? null : Number(lengthHeader),
    requestedOffset: offset,
    expectedSize: file.size,
  });

  let position = offset;
  switch (action.action) {
    case 'fail':
      await response.body?.cancel();
      throw failureFor(action, file.path);
    case 'retry':
      await response.body?.cancel();
      throw new RetryableError(action.reason);
    case 'restart':
      await response.body?.cancel();
      return 'restart';
    case 'replace':
      // The server sent the whole file: either a fresh download, or it ignored/failed If-Range.
      if (offset > 0) {
        access.truncate(0);
        ctx.progress.setCounted(file.path, 0);
      }
      position = 0;
      await writeMeta(ctx, file.path, {
        sha256: file.sha256,
        size: file.size,
        etag: usableEtag(response.headers.get('ETag')),
      });
      break;
    case 'append':
      break;
  }

  if (!response.body) throw new RetryableError('the response had no body');
  const reader = response.body.getReader();
  let flushedAt = position;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (position + value.byteLength > file.size) {
        throw failure('integrity', 'The server sent more data than the manifest lists. Retrying fetches the new manifest.', { path: file.path });
      }
      let written = 0;
      while (written < value.byteLength) {
        const count = access.write(value.subarray(written), { at: position + written });
        if (count === 0) throw new DOMException('write made no progress', 'QuotaExceededError');
        written += count;
      }
      position += value.byteLength;
      ctx.progress.add(file.path, value.byteLength);
      if (position - flushedAt >= FLUSH_EVERY) {
        access.flush();
        flushedAt = position;
      }
    }
  } catch (error) {
    reader.cancel().catch(() => undefined);
    throw error;
  }
  access.flush();
  if (position < file.size) throw new RetryableError('the connection closed before the file was complete');
  return 'complete';
}

async function downloadFile(file: ManifestFile, ctx: Context): Promise<void> {
  let stalled = 0;
  let verifyFailures = 0;
  let finished = false;
  ctx.progress.begin(file.path);
  try {
    for (;;) {
      ctx.signal.throwIfAborted();
      const handle = await getFile(ctx.partialData, file.path, true);
      if (!handle) throw failure('unknown', `could not create a partial file for ${file.path}`);
      const access = await openAccess(handle, file.path, ctx.signal);
      let open = true;
      const closeAccess = () => {
        if (!open) return;
        open = false;
        try {
          access.flush();
        } finally {
          access.close();
        }
      };

      try {
        let decision = planResume({
          expectedSize: file.size,
          expectedSha256: file.sha256,
          partialSize: access.getSize(),
          meta: await readMeta(ctx, file.path),
        });
        if (decision.action === 'restart') {
          log('info', `${file.path}: discarding partial data (${decision.reason})`);
          access.truncate(0);
          await removeFile(ctx.partialMeta, metaPath(file.path));
          decision = { action: 'fresh' };
        }
        ctx.progress.setCounted(
          file.path,
          decision.action === 'resume' ? decision.offset : decision.action === 'verify' ? file.size : 0,
        );
        if (decision.action === 'resume') log('info', `${file.path}: resuming at byte ${decision.offset}`);

        if (decision.action !== 'verify') {
          const sizeBefore = access.getSize();
          let outcome: 'complete' | 'restart';
          try {
            outcome = await transfer(file, access, decision.action === 'resume' ? decision : null, ctx);
          } catch (error) {
            if (error instanceof InstallFailure || ctx.signal.aborted || isQuotaError(error)) throw error;
            // Dropped connection or server hiccup: keep what we have and ask for the rest.
            stalled = access.getSize() > sizeBefore ? 1 : stalled + 1;
            if (stalled >= MAX_STALLED_ATTEMPTS) {
              throw failure('network', `The connection to the server keeps failing (${messageOf(error)}).`, { path: file.path });
            }
            log('warn', `${file.path}: ${messageOf(error)}; retrying`);
            closeAccess();
            await sleep(retryDelayMs(stalled - 1), ctx.signal);
            continue;
          }
          if (outcome === 'restart') {
            log('info', `${file.path}: server could not continue the range; starting over`);
            access.truncate(0);
            await removeFile(ctx.partialMeta, metaPath(file.path));
            ctx.progress.setCounted(file.path, 0);
            continue;
          }
        }

        ctx.progress.setHashing(file.path, true);
        const digest = await hashAccess(access, file.size, ctx.signal);
        ctx.progress.setHashing(file.path, false);
        closeAccess();

        if (digest === file.sha256) {
          await moveInto(handle, ctx.game, file.path);
          await removeFile(ctx.partialMeta, metaPath(file.path));
          finished = true;
          return;
        }

        verifyFailures += 1;
        log('warn', `${file.path}: SHA-256 mismatch (${verifyFailures} of ${MAX_VERIFY_FAILURES + 1})`);
        if (verifyFailures > MAX_VERIFY_FAILURES) {
          throw failure('integrity', 'The downloaded data does not match its SHA-256 even after downloading again.', { path: file.path });
        }
        await removeFile(ctx.partialData, file.path);
        await removeFile(ctx.partialMeta, metaPath(file.path));
        ctx.progress.setCounted(file.path, 0);
      } finally {
        closeAccess();
      }
    }
  } finally {
    ctx.progress.end(file.path, finished);
  }
}

// --- pool -----------------------------------------------------------------------------------

async function runPool(
  files: ManifestFile[],
  limits: PoolLimits,
  work: (file: ManifestFile) => Promise<void>,
  controller: AbortController,
): Promise<void> {
  const queue = sortForDispatch(files);
  const running = new Set<Promise<void>>();
  const active = { total: 0, big: 0 };
  let firstError: unknown = null;
  let hasError = false;

  const launch = (file: ManifestFile) => {
    const big = file.size >= limits.bigThreshold;
    active.total += 1;
    if (big) active.big += 1;
    const task: Promise<void> = work(file)
      .catch((error: unknown) => {
        if (!hasError) {
          hasError = true;
          firstError = error;
          controller.abort(error);
        }
      })
      .finally(() => {
        active.total -= 1;
        if (big) active.big -= 1;
        running.delete(task);
      });
    running.add(task);
  };

  for (;;) {
    while (!hasError) {
      const index = pickNext(
        queue.map((file) => file.size),
        active,
        limits,
      );
      if (index < 0) break;
      const [next] = queue.splice(index, 1);
      if (next) launch(next);
    }
    if (running.size === 0) break;
    await Promise.race(running);
  }
  if (hasError) throw firstError;
}

// --- whole install --------------------------------------------------------------------------

async function fetchManifestText(signal: AbortSignal): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MANIFEST_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch('/assets/manifest.json', { cache: 'no-store', credentials: 'same-origin', signal });
      if (response.status === 401 || response.status === 403) throw failure('auth', 'The session is no longer valid.', { status: response.status });
      if (response.status >= 500) throw new RetryableError(`HTTP ${response.status}`);
      if (!response.ok) throw failure('server', `The manifest request failed (HTTP ${response.status}).`, { status: response.status });
      return await response.text();
    } catch (error) {
      if (error instanceof InstallFailure || signal.aborted) throw error;
      lastError = error;
      if (attempt < MANIFEST_ATTEMPTS - 1) await sleep(retryDelayMs(attempt), signal);
    }
  }
  throw failure('network', `Could not download the manifest (${messageOf(lastError)}).`);
}

async function loadInstalled(game: FileSystemDirectoryHandle): Promise<Manifest | null> {
  try {
    const text = await readText(game, INSTALLED_MANIFEST_NAME);
    return text === null ? null : parseManifest(JSON.parse(text));
  } catch {
    log('warn', 'installed manifest is unreadable; checking every file');
    return null;
  }
}

async function statAll(game: FileSystemDirectoryHandle, files: ManifestFile[], signal: AbortSignal): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  const BATCH = 16;
  for (let i = 0; i < files.length; i += BATCH) {
    signal.throwIfAborted();
    await Promise.all(
      files.slice(i, i + BATCH).map(async (file) => {
        const size = await statFile(game, file.path);
        if (size !== null) sizes.set(file.path, size);
      }),
    );
  }
  return sizes;
}

async function install(controller: AbortController, limitOverride: LimitOverride): Promise<void> {
  const { signal } = controller;
  post({ type: 'phase', phase: 'checking' });

  const remoteText = await fetchManifestText(signal);
  let remote: Manifest;
  try {
    remote = parseManifest(JSON.parse(remoteText));
  } catch (error) {
    throw failure('manifest', `The server's manifest is not valid: ${error instanceof Error ? error.message : String(error)}`);
  }

  const game = await openRoot('game');
  const partialRoot = await openRoot('partial');
  const partialData = await partialRoot.getDirectoryHandle('data', { create: true });
  const partialMeta = await partialRoot.getDirectoryHandle('meta', { create: true });

  const installed = await loadInstalled(game);
  const onDisk = await statAll(game, remote.files, signal);
  const diff = diffManifest(installed, remote, onDisk);

  // A file may already be right on disk even though the installed manifest does not say so (the
  // tab closed after the file was verified but before the manifest was written). Hash those
  // instead of downloading them again.
  const candidates = diff.download.filter((entry) => onDisk.get(entry.file.path) === entry.file.size);
  if (candidates.length > 0) post({ type: 'phase', phase: 'reconciling' });
  const alreadyCorrect = new Set<string>();
  for (const { file } of candidates) {
    if (await fileMatches(game, file, signal)) alreadyCorrect.add(file.path);
  }
  const toFetch = diff.download.map((entry) => entry.file).filter((file) => !alreadyCorrect.has(file.path));

  const ctx: Context = {
    signal,
    progress: new Progress(
      toFetch.reduce((sum, file) => sum + file.size, 0),
      toFetch.length,
    ),
    game,
    partialData,
    partialMeta,
  };

  activeProgress = ctx.progress;

  // What partial data is already usable, so storage need and progress are honest.
  let alreadyHave = 0;
  for (const file of toFetch) {
    const size = (await statFile(partialData, file.path)) ?? 0;
    const decision = planResume({
      expectedSize: file.size,
      expectedSha256: file.sha256,
      partialSize: size,
      meta: await readMeta(ctx, file.path),
    });
    const have = decision.action === 'resume' ? decision.offset : decision.action === 'verify' ? file.size : 0;
    ctx.progress.setCounted(file.path, have);
    alreadyHave += have;
  }

  const nothingChanged = toFetch.length === 0 && installed !== null && manifestsEqual(installed, remote);
  const stale = findStalePaths(await listFiles(game), remote);
  post({
    type: 'plan',
    version: remote.version,
    filesTotal: toFetch.length,
    totalBytes: ctx.progress.totalBytes,
    removeCount: stale.length,
    upToDate: nothingChanged && stale.length === 0,
  });

  let persisted: boolean | null = null;
  if (toFetch.length > 0) {
    try {
      persisted = await navigator.storage.persist();
    } catch {
      persisted = null;
    }
    const needed = ctx.progress.totalBytes - alreadyHave;
    const snapshot = await storageSnapshot();
    const margin = Math.max(MIB, Math.ceil(needed * 0.01));
    if (snapshot && needed + margin > snapshot.quota - snapshot.usage) throw storageFailure(needed + margin, snapshot);
    log('info', `downloading ${toFetch.length} files, ${needed} bytes still needed`);

    post({ type: 'phase', phase: 'downloading' });
    ctx.progress.start();
    try {
      await runPool(toFetch, chooseLimits(toFetch.map((file) => file.size), limitOverride), (file) => downloadFile(file, ctx), controller);
    } finally {
      ctx.progress.stop();
    }
    post(ctx.progress.snapshot());
  }

  post({ type: 'phase', phase: 'finalizing' });
  // Everything verified. Drop files the manifest no longer lists (this includes leftovers from
  // interrupted installs), then leftover partial data, then record the new install.
  const removed = findStalePaths(await listFiles(game), remote);
  for (const path of removed) await removeFile(game, path);
  await pruneEmptyDirs(game);
  const keep = new Set(toFetch.map((file) => file.path));
  for (const path of await listFiles(partialData)) if (!keep.has(path)) await removeFile(partialData, path);
  for (const path of await listFiles(partialMeta)) if (!keep.has(path.replace(/\.json$/, ''))) await removeFile(partialMeta, path);
  await pruneEmptyDirs(partialRoot);

  if (!(nothingChanged && removed.length === 0)) await writeTextAtomic(game, INSTALLED_MANIFEST_NAME, remoteText);

  post({
    type: 'done',
    version: remote.version,
    downloadedFiles: ctx.progress.filesDone,
    downloadedBytes: ctx.progress.totalBytes - alreadyHave,
    removedFiles: removed.length,
    persisted,
  });
}

async function toWorkerError(error: unknown): Promise<WorkerError> {
  if (error instanceof InstallFailure) return error.info;
  if (error instanceof DOMException && error.name === 'AbortError') return { code: 'cancelled', message: 'Cancelled.' };
  if (isQuotaError(error)) {
    const remaining = activeProgress ? Math.max(0, activeProgress.totalBytes - activeProgress.received) : 0;
    return storageFailure(remaining, await storageSnapshot(), true).info;
  }
  if (error instanceof RetryableError || error instanceof TypeError) {
    return { code: 'network', message: `Could not reach the server (${messageOf(error)}).` };
  }
  return { code: 'unknown', message: messageOf(error) };
}

let current: AbortController | null = null;

async function start(message: Extract<ToWorker, { type: 'start' }>): Promise<void> {
  if (current) return;
  const controller = new AbortController();
  current = controller;
  try {
    const run = () => install(controller, message.limits ?? {});
    if (navigator.locks) {
      // One installer at a time. Chrome keeps the locks and file handles of a closed or reloaded tab
      // for up to about 30 seconds, so a quick reload has to wait here rather than fail.
      const ran = await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
        if (!lock) return false;
        await run();
        return true;
      });
      if (!ran) {
        post({ type: 'phase', phase: 'waiting' });
        log('info', 'another installer holds the lock; waiting for it');
        await navigator.locks.request(LOCK_NAME, { signal: controller.signal }, run);
      }
    } else {
      await run();
    }
  } catch (error) {
    post({ type: 'error', error: await toWorkerError(error) });
  } finally {
    current = null;
    activeProgress = null;
  }
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'start') void start(message);
  else if (message.type === 'cancel') current?.abort(new DOMException('Cancelled', 'AbortError'));
};

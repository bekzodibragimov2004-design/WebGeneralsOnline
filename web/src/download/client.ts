/** Page side of the download worker. */

import { log } from '../log';
import { ProgressTracker, type DownloadViewState } from './progress-state';
import type { FromWorker, InstallResult, LimitOverride, ToWorker, WorkerError } from './protocol';

export class InstallError extends Error {
  constructor(readonly info: WorkerError) {
    super(info.message);
    this.name = 'InstallError';
  }
}

export interface Installation {
  result: Promise<InstallResult>;
  cancel(): void;
}

/**
 * Starts the worker. `onState` is called with what the download screen should show, about ten
 * times a second while files are coming in. `limits` is a test hook for the connection pool.
 */
export function installGame(onState: (state: DownloadViewState) => void, limits?: LimitOverride): Installation {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const tracker = new ProgressTracker();
  const send = (message: ToWorker) => worker.postMessage(message);

  const result = new Promise<InstallResult>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      switch (message.type) {
        case 'phase':
          tracker.setPhase(message.phase);
          log('info', `install phase: ${message.phase}`);
          onState(tracker.state());
          break;
        case 'plan':
          log('info', `install plan: version ${message.version}, ${message.filesTotal} files, ${message.totalBytes} bytes, ${message.removeCount} to remove`);
          if (message.upToDate) tracker.setUpToDate();
          onState(tracker.state());
          break;
        case 'progress':
          tracker.update(message, performance.now());
          onState(tracker.state());
          break;
        case 'log':
          log(message.level === 'info' ? 'info' : message.level, `[download] ${message.text}`);
          break;
        case 'error':
          log('error', `install failed: ${message.error.code}: ${message.error.message}`);
          reject(new InstallError(message.error));
          break;
        case 'done':
          log('info', `install done: ${message.downloadedFiles} files, ${message.downloadedBytes} bytes, ${message.removedFiles} removed, persisted=${String(message.persisted)}`);
          resolve(message);
          break;
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      reject(new InstallError({ code: 'unknown', message: event.message || 'The download worker crashed.' }));
    };
    send(limits ? { type: 'start', limits } : { type: 'start' });
  }).finally(() => worker.terminate());

  return { result, cancel: () => send({ type: 'cancel' }) };
}

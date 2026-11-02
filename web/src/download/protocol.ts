/** Messages between the page and the download worker. */

export interface LimitOverride {
  maxActive?: number;
  maxBigActive?: number;
  bigThreshold?: number;
}

export type ToWorker =
  | {
      type: 'start';
      /** Test hook: overrides for the connection pool. */
      limits?: LimitOverride;
    }
  | { type: 'cancel' };

/** 'waiting': another installer (an open tab, or a closed one Chrome has not cleaned up yet) holds the files. */
export type InstallPhase = 'waiting' | 'checking' | 'reconciling' | 'downloading' | 'finalizing';

export type WorkerErrorCode =
  /** 401: the session cookie is gone or was never set. */
  | 'auth'
  /** The server could not be reached, or kept dropping the connection. */
  | 'network'
  /** The server answered but not with what the contract promises. */
  | 'server'
  | 'storage'
  /** SHA-256 kept failing, or a file changed size under us. */
  | 'integrity'
  | 'manifest'
  /** Another tab holds the installer lock. */
  | 'locked'
  | 'cancelled'
  | 'unknown';

export interface WorkerError {
  code: WorkerErrorCode;
  message: string;
  /** For 'storage'. */
  needed?: number;
  available?: number;
  /** For 'storage': Chrome refused a write although its estimate showed enough room. */
  refused?: boolean;
  path?: string;
  status?: number;
}

export interface ProgressMessage {
  type: 'progress';
  /** Bytes in place for the files being downloaded, counting what resumed partial files already had. */
  receivedBytes: number;
  totalBytes: number;
  filesDone: number;
  filesTotal: number;
  /** Paths being fetched or verified right now, newest first. */
  active: string[];
  verifying: boolean;
}

export type FromWorker =
  | { type: 'phase'; phase: InstallPhase }
  | {
      type: 'plan';
      version: string;
      filesTotal: number;
      totalBytes: number;
      removeCount: number;
      upToDate: boolean;
    }
  | ProgressMessage
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'error'; error: WorkerError }
  | {
      type: 'done';
      version: string;
      downloadedFiles: number;
      downloadedBytes: number;
      removedFiles: number;
      persisted: boolean | null;
    };

export interface InstallResult {
  version: string;
  downloadedFiles: number;
  downloadedBytes: number;
  removedFiles: number;
  persisted: boolean | null;
}

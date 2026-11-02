/**
 * Which error screen to show, and what it says. Pure data in, pure data out: the DOM code in
 * ui/views.ts only draws what this file decides.
 */

import { formatBytes, formatWait } from './format';
import type { UnsupportedReason } from './capabilities';
import type { WorkerError } from './download/protocol';

export type ErrorScreenKind =
  | 'unsupported-browser'
  | 'insufficient-storage'
  | 'server-unreachable'
  | 'go-login-failed'
  | 'download-failed'
  | 'crash';

export type GoLoginFailureReason = 'bad-credentials' | 'rate-limited' | 'service-unavailable' | 'unknown';

/** What the engine tells the shell when Generals Online refuses the login. Never holds credentials. */
export interface GoLoginFailure {
  reason: GoLoginFailureReason;
  /** Short text from GO or the engine, shown as a detail line. */
  message?: string;
  /** For 'rate-limited', how long GO asked us to wait. */
  retryAfterSeconds?: number;
}

export type ErrorSignal =
  | { type: 'unsupported'; reasons: UnsupportedReason[] }
  | { type: 'storage'; needed: number; available: number; refused?: boolean }
  | { type: 'network'; detail?: string }
  | { type: 'go-login'; failure: GoLoginFailure }
  | { type: 'download'; message: string }
  | { type: 'crash'; message: string; reported: boolean | null };

const PRIORITY: Record<ErrorSignal['type'], number> = {
  unsupported: 0,
  storage: 1,
  network: 2,
  'go-login': 3,
  download: 4,
  crash: 5,
};

export function screenKindFor(signal: ErrorSignal): ErrorScreenKind {
  switch (signal.type) {
    case 'unsupported':
      return 'unsupported-browser';
    case 'storage':
      return 'insufficient-storage';
    case 'network':
      return 'server-unreachable';
    case 'go-login':
      return 'go-login-failed';
    case 'download':
      return 'download-failed';
    case 'crash':
      return 'crash';
  }
}

/**
 * When several things went wrong at once, show the one the person can act on first. A browser
 * that cannot run the game explains every later error, and a full disk explains a failed write.
 * A crash is only shown when nothing more specific applies.
 */
export function chooseErrorScreen(signals: readonly (ErrorSignal | null | undefined)[]): ErrorSignal | null {
  let best: ErrorSignal | null = null;
  for (const signal of signals) {
    if (!signal) continue;
    if (best === null || PRIORITY[signal.type] < PRIORITY[best.type]) best = signal;
  }
  return best;
}

export type WorkerFailure = { kind: 'reauth' } | { kind: 'signal'; signal: ErrorSignal };

/** Maps a download worker failure to what the page should do. */
export function classifyWorkerError(error: WorkerError): WorkerFailure {
  switch (error.code) {
    case 'auth':
      return { kind: 'reauth' };
    case 'storage':
      return {
        kind: 'signal',
        signal: { type: 'storage', needed: error.needed ?? 0, available: error.available ?? 0, ...(error.refused ? { refused: true } : {}) },
      };
    case 'network':
      return { kind: 'signal', signal: { type: 'network', detail: error.message } };
    case 'integrity':
      return {
        kind: 'signal',
        signal: { type: 'download', message: `A downloaded file failed its integrity check${error.path ? ` (${error.path})` : ''}. ${error.message}` },
      };
    case 'locked':
      return { kind: 'signal', signal: { type: 'download', message: 'Another tab or window is already downloading the game files. Close it, then retry.' } };
    default:
      return { kind: 'signal', signal: { type: 'download', message: error.message } };
  }
}

export type ActionId = 'retry' | 'reload' | 'get-chrome' | 'go-retry';

export interface ErrorScreenModel {
  kind: ErrorScreenKind;
  title: string;
  /** One or two sentences saying what happened. */
  summary: string;
  /** Facts worth showing: what was found, how much is needed. */
  facts: string[];
  /** What the person should do next. */
  steps: string[];
  actions: { id: ActionId; label: string }[];
}

const REASON_FACTS: Record<UnsupportedReason, string> = {
  'not-chrome': 'This is not Google Chrome.',
  mobile: 'This is a phone or tablet browser; the game needs a desktop.',
  'chrome-too-old': 'This version of Chrome is too old.',
  'no-webgpu': 'WebGPU is not available in this browser.',
  'no-gpu-adapter': 'Chrome has WebGPU but found no usable graphics adapter.',
  'no-shared-array-buffer': 'SharedArrayBuffer is not available.',
  'not-cross-origin-isolated': 'The page is not cross-origin isolated (the server must send COOP and COEP headers).',
  'no-opfs': 'This browser cannot store game files (origin private file system or workers missing).',
};

function unsupportedModel(reasons: UnsupportedReason[]): ErrorScreenModel {
  const steps: string[] = [];
  const has = (reason: UnsupportedReason) => reasons.includes(reason);
  if (has('not-chrome') || has('mobile') || has('chrome-too-old') || has('no-opfs')) {
    steps.push('Open this page in the current desktop version of Google Chrome on Windows or macOS.');
  }
  if (has('no-webgpu') || has('no-gpu-adapter')) {
    steps.push('In Chrome, turn on "Use graphics acceleration when available" in Settings, System, update your graphics driver, then restart Chrome. chrome://gpu shows what Chrome sees.');
  }
  if (has('no-shared-array-buffer') || has('not-cross-origin-isolated')) {
    steps.push('If you are already using desktop Chrome, the server is missing its cross-origin isolation headers. Tell whoever runs this server.');
  }
  return {
    kind: 'unsupported-browser',
    title: 'This browser cannot run the game',
    summary: 'WebGeneralsOnline needs desktop Google Chrome with WebGPU, shared memory and local file storage.',
    facts: reasons.map((reason) => REASON_FACTS[reason]),
    steps,
    actions: [
      { id: 'get-chrome', label: 'Get Google Chrome' },
      { id: 'reload', label: 'Check again' },
    ],
  };
}

function storageModel(needed: number, available: number, refused: boolean): ErrorScreenModel {
  const missing = Math.max(0, needed - available);
  // Chrome sometimes stops accepting data while its own estimate still shows room (a nearly full disk).
  const contradicts = refused && missing === 0;
  return {
    kind: 'insufficient-storage',
    title: 'Not enough storage space',
    summary: 'Chrome will not let this site store the game files with the space it has left.',
    facts: contradicts
      ? [`Still needed: ${formatBytes(needed)}`, `Chrome reports ${formatBytes(available)} free but refused to store more data.`]
      : [
          `Needed: ${formatBytes(needed)}`,
          `Available: ${formatBytes(available)}`,
          ...(missing > 0 ? [`Short by: ${formatBytes(missing)}`] : []),
        ],
    steps: [
      'Free up disk space on the drive that holds your Chrome profile, then press Retry.',
      'Do not use a private or guest window: Chrome gives those very little storage.',
      'Downloaded files are kept, so a retry continues where it stopped.',
    ],
    actions: [{ id: 'retry', label: 'Retry' }],
  };
}

function networkModel(detail?: string): ErrorScreenModel {
  return {
    kind: 'server-unreachable',
    title: 'Cannot reach the server',
    summary: 'The game server did not answer, or the connection kept dropping.',
    facts: detail ? [detail] : [],
    steps: [
      'Check your internet connection.',
      'If you use a VPN or a proxy, try without it.',
      'If this keeps happening, the server may be down. Try again in a few minutes.',
      'Downloaded files are kept, so a retry continues where it stopped.',
    ],
    actions: [{ id: 'retry', label: 'Retry' }],
  };
}

function goLoginModel(failure: GoLoginFailure): ErrorScreenModel {
  const facts: string[] = [];
  let summary: string;
  const steps: string[] = [];
  switch (failure.reason) {
    case 'bad-credentials':
      summary = 'Generals Online did not accept the account name or password.';
      steps.push('Check the account name and password, then try again.');
      steps.push('This is separate from the site password you entered earlier.');
      break;
    case 'rate-limited':
      summary = 'Generals Online has temporarily blocked sign-in attempts from this connection.';
      steps.push(
        failure.retryAfterSeconds
          ? `Wait about ${formatWait(failure.retryAfterSeconds)}, then try again.`
          : 'Wait a few minutes, then try again.',
      );
      break;
    case 'service-unavailable':
      summary = 'The Generals Online service did not answer.';
      steps.push('Try again in a few minutes. If it keeps failing, the service may be down.');
      break;
    default:
      summary = 'Signing in to Generals Online failed.';
      steps.push('Try again. If it keeps failing, reload the page.');
  }
  if (failure.message) facts.push(failure.message);
  return {
    kind: 'go-login-failed',
    title: 'Generals Online sign-in failed',
    summary,
    facts,
    steps,
    actions: [
      { id: 'go-retry', label: 'Try again' },
      { id: 'reload', label: 'Reload page' },
    ],
  };
}

function downloadModel(message: string): ErrorScreenModel {
  return {
    kind: 'download-failed',
    title: 'Game files could not be installed',
    summary: message,
    facts: [],
    steps: ['Press Retry. Files that were already verified are kept.', 'If it fails again, reload the page and tell the server owner.'],
    actions: [
      { id: 'retry', label: 'Retry' },
      { id: 'reload', label: 'Reload page' },
    ],
  };
}

function crashModel(message: string, reported: boolean | null): ErrorScreenModel {
  return {
    kind: 'crash',
    title: 'Something went wrong',
    summary: 'The game shell hit an unexpected error and stopped.',
    facts: [
      message,
      reported === true
        ? 'A crash report was sent to the server.'
        : reported === false
          ? 'The crash report could not be sent.'
          : 'Sending a crash report...',
    ],
    steps: ['Reload the page. Your downloaded game files and saved data are not affected.'],
    actions: [{ id: 'reload', label: 'Reload' }],
  };
}

export function describeErrorScreen(signal: ErrorSignal): ErrorScreenModel {
  switch (signal.type) {
    case 'unsupported':
      return unsupportedModel(signal.reasons);
    case 'storage':
      return storageModel(signal.needed, signal.available, signal.refused === true);
    case 'network':
      return networkModel(signal.detail);
    case 'go-login':
      return goLoginModel(signal.failure);
    case 'download':
      return downloadModel(signal.message);
    case 'crash':
      return crashModel(signal.message, signal.reported);
  }
}

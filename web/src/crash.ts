/**
 * Crash handling. Catches window errors and unhandled rejections, sends a redacted report to
 * /api/crash, and tells the page to show the recovery screen.
 */

import { sendCrashReport } from './api';
import {
  buildCrashReport,
  classifyThrown,
  describeThrown,
  redact,
  type CrashKind,
  type CrashPhase,
} from './crash-report';
import type { ErrorSignal } from './error-screens';
import { log, ring } from './log';

type CrashSignal = Extract<ErrorSignal, { type: 'crash' }>;

const MAX_REPORTS = 5;
const IGNORED_MESSAGES = [/ResizeObserver loop/i];

let phase: CrashPhase = 'download';
let show: ((signal: CrashSignal) => void) | null = null;
let sent = 0;
const seen = new Set<string>();

/** The engine calls this as it moves through menu, lobby, match and replay. */
export function setCrashPhase(next: CrashPhase): void {
  phase = next;
  log('info', `phase: ${next}`);
}

/**
 * Reports a crash and shows the recovery screen. The shell calls it for window errors; the engine
 * can call it for aborts, out-of-memory and WebGPU failures. Resolves with whether the server got
 * the report.
 */
export async function reportCrash(kind: CrashKind, error: unknown): Promise<boolean> {
  try {
    const { message, stack } = describeThrown(error);
    const key = `${kind}|${message}|${stack.split('\n')[1] ?? ''}`;
    log('error', `${kind}: ${message}`);
    if (seen.has(key) || sent >= MAX_REPORTS) return false;
    seen.add(key);
    sent += 1;

    const shownMessage = redact(message);
    show?.({ type: 'crash', message: shownMessage, reported: null });
    const report = buildCrashReport({
      buildHash: __BUILD_HASH__,
      phase,
      kind,
      message,
      stack,
      log: ring.lines(),
    });
    const ok = await sendCrashReport(report);
    show?.({ type: 'crash', message: shownMessage, reported: ok });
    return ok;
  } catch {
    // A failure while reporting a failure must never raise another one.
    return false;
  }
}

/** `showScreen` draws the recovery screen. */
export function installCrashHandlers(showScreen: (signal: CrashSignal) => void): void {
  show = showScreen;
  window.addEventListener('error', (event) => {
    if (IGNORED_MESSAGES.some((pattern) => pattern.test(event.message))) return;
    const where = event.filename ? `\n    at ${event.filename}:${event.lineno}:${event.colno}` : '';
    const error = event.error instanceof Error ? event.error : new Error(event.message || 'Unknown script error');
    if (!(event.error instanceof Error)) error.stack = `${error.name}: ${error.message}${where}`;
    void reportCrash(classifyThrown(error.message), error);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    const { message } = describeThrown(reason);
    void reportCrash(classifyThrown(message), reason);
  });
}

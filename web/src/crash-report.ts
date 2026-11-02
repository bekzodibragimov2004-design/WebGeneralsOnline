/** Crash report format from docs/WEB_CONTRACT.md, plus redaction and size limits. Pure functions. */

export type CrashPhase = 'download' | 'menu' | 'lobby' | 'match' | 'replay';
export type CrashKind = 'abort' | 'exception' | 'oom' | 'webgpu';

export interface CrashReport {
  buildHash: string;
  phase: CrashPhase;
  kind: CrashKind;
  message: string;
  stack: string;
  log: string[];
}

export const LOG_LINES = 200;
/** The server accepts at most 256 KB; stay clear of it. */
export const MAX_REPORT_BYTES = 200 * 1024;
const MAX_MESSAGE = 2_000;
const MAX_STACK = 16_000;
const MAX_LINE = 500;

const REDACTED = '[redacted]';

// A key that names a secret, followed by : or =, followed by its value (quoted or bare).
// The prefix and suffix are bounded so a long run of ordinary characters cannot make the match slow.
const SECRET_KEY = String.raw`[\w.-]{0,40}(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|session[_-]?(?:id|token|key)|credentials?|authorization)[\w.-]{0,40}`;
// Not matching an already-redacted value keeps redact() idempotent.
const KEY_VALUE = new RegExp(String.raw`(["']?)(${SECRET_KEY})\1(\s*[:=]\s*)(?!\[redacted\])("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;&}\])]+)`, 'gi');

const RULES: { pattern: RegExp; replace: string | ((...args: string[]) => string) }[] = [
  // Whole Cookie / Set-Cookie header lines.
  { pattern: /\b((?:set-)?cookie)\s*:[^\r\n]*/gi, replace: (_m, name = '') => `${name}: ${REDACTED}` },
  // The session cookie by name, wherever it turns up.
  { pattern: /\bwgo_session\s*=\s*[^;\s,"']+/gi, replace: `wgo_session=${REDACTED}` },
  // Authorization headers and bare bearer tokens.
  { pattern: /\bauthorization\s*:[^\r\n]*/gi, replace: `authorization: ${REDACTED}` },
  { pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: `Bearer ${REDACTED}` },
  // password=..., "token": "...", api_key: ...
  { pattern: KEY_VALUE, replace: (_m, quote = '', key = '', separator = '') => `${quote}${key}${quote}${separator}${REDACTED}` },
  // user:password@host in URLs.
  { pattern: /(\/\/)[^\s/@:]+:[^\s/@]+@/g, replace: `$1${REDACTED}@` },
  // JSON web tokens.
  { pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, replace: REDACTED },
  // Any other long opaque run that mixes letters and digits looks like a token.
  { pattern: /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g, replace: REDACTED },
];

/** Input longer than this is cut before the patterns run, which keeps redaction fast. */
const MAX_REDACT_INPUT = 64_000;

export function redact(text: string): string {
  let out = text.length > MAX_REDACT_INPUT ? text.slice(0, MAX_REDACT_INPUT) : text;
  for (const { pattern, replace } of RULES) {
    pattern.lastIndex = 0;
    out = typeof replace === 'string' ? out.replace(pattern, replace) : out.replace(pattern, replace);
  }
  return out;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

/** Fixed-size log of recent lines. Lines are redacted on the way in. */
export class RingLog {
  private readonly buffer: string[] = [];

  constructor(private readonly capacity = LOG_LINES) {}

  push(line: string): void {
    this.buffer.push(clip(redact(line.slice(0, MAX_LINE * 4)), MAX_LINE));
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity);
  }

  lines(): string[] {
    return [...this.buffer];
  }

  get size(): number {
    return this.buffer.length;
  }
}

export interface ReportInput {
  buildHash: string;
  phase: CrashPhase;
  kind: CrashKind;
  message: string;
  stack?: string;
  log: readonly string[];
}

function byteLength(report: CrashReport): number {
  return new TextEncoder().encode(JSON.stringify(report)).length;
}

/** Builds a report with everything redacted and capped so it fits in MAX_REPORT_BYTES. */
export function buildCrashReport(input: ReportInput): CrashReport {
  const report: CrashReport = {
    buildHash: input.buildHash,
    phase: input.phase,
    kind: input.kind,
    message: clip(redact(input.message.slice(0, MAX_MESSAGE * 4)), MAX_MESSAGE),
    stack: clip(redact((input.stack ?? '').slice(0, MAX_STACK * 4)), MAX_STACK),
    log: input.log.slice(-LOG_LINES).map((line) => clip(redact(line.slice(0, MAX_LINE * 4)), MAX_LINE)),
  };
  // Drop the oldest log lines first, then shorten the stack, until it fits.
  while (byteLength(report) > MAX_REPORT_BYTES && report.log.length > 0) {
    report.log.splice(0, Math.max(1, Math.ceil(report.log.length / 4)));
  }
  if (byteLength(report) > MAX_REPORT_BYTES) report.stack = report.stack.slice(0, 2_000);
  if (byteLength(report) > MAX_REPORT_BYTES) report.message = report.message.slice(0, 500);
  return report;
}

/** Best guess at the contract's `kind` from an error message. */
export function classifyThrown(message: string): CrashKind {
  if (/out of memory|memory access out of bounds|allocation failed|\bOOM\b|Cannot enlarge memory/i.test(message)) return 'oom';
  if (/webgpu|GPUDevice|GPUAdapter|device (was )?lost/i.test(message)) return 'webgpu';
  if (/^Aborted\(|\babort\(/i.test(message)) return 'abort';
  return 'exception';
}

/** Turns anything that was thrown into message and stack text. */
export function describeThrown(value: unknown): { message: string; stack: string } {
  if (value instanceof Error) return { message: `${value.name}: ${value.message}`, stack: value.stack ?? '' };
  if (typeof value === 'string') return { message: value, stack: '' };
  try {
    return { message: JSON.stringify(value) ?? String(value), stack: '' };
  } catch {
    return { message: String(value), stack: '' };
  }
}

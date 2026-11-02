const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** 1024-based, matching what file managers show. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatSpeed(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond)) return '-';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** m:ss, or h:mm:ss for an hour or more. null (unknown) shows as a dash. */
export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '-';
  const total = Math.ceil(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function percent(done: number, total: number): number {
  if (total <= 0) return 100;
  return Math.max(0, Math.min(100, (done / total) * 100));
}

/**
 * Speed over a sliding window of recent samples. Samples carry cumulative byte counts, so a
 * counter that jumps down (a file restarted) just lowers the reading instead of breaking it.
 */
export class SpeedMeter {
  private samples: { time: number; bytes: number }[] = [];

  constructor(private readonly windowMs = 5000) {}

  add(time: number, bytes: number): void {
    this.samples.push({ time, bytes });
    const cutoff = time - this.windowMs;
    while (this.samples.length > 2 && (this.samples[0] as { time: number }).time < cutoff) this.samples.shift();
  }

  /** Bytes per second, or null until two samples a moment apart exist. */
  bytesPerSecond(): number | null {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last.time - first.time < 250) return null;
    const rate = ((last.bytes - first.bytes) * 1000) / (last.time - first.time);
    return rate > 0 ? rate : 0;
  }

  /** Seconds left at the current speed, or null when unknown or stalled. */
  etaSeconds(remainingBytes: number): number | null {
    const rate = this.bytesPerSecond();
    if (rate === null || rate <= 0) return null;
    return remainingBytes / rate;
  }

  reset(): void {
    this.samples = [];
  }
}

const DEFAULT_RETRY_AFTER_SECONDS = 30;
const MAX_RETRY_AFTER_SECONDS = 3600;

/** Retry-After as whole seconds. Accepts a number of seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number {
  if (header === null || header.trim() === '') return DEFAULT_RETRY_AFTER_SECONDS;
  const trimmed = header.trim();
  let seconds: number;
  if (/^\d+$/.test(trimmed)) {
    seconds = Number(trimmed);
  } else {
    const date = Date.parse(trimmed);
    if (Number.isNaN(date)) return DEFAULT_RETRY_AFTER_SECONDS;
    seconds = Math.ceil((date - now) / 1000);
  }
  return Math.max(1, Math.min(MAX_RETRY_AFTER_SECONDS, seconds));
}

export function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} minute${minutes === 1 ? '' : 's'}` : `${minutes} min ${rest} s`;
}

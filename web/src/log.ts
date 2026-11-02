import { RingLog } from './crash-report';

/** The last 200 log lines. Crash reports carry a copy. */
export const ring = new RingLog();

type Level = 'debug' | 'info' | 'warn' | 'error';

const original = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  log: console.log.bind(console),
};

function formatArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function record(level: string, args: unknown[]): void {
  ring.push(`${new Date().toISOString()} ${level.toUpperCase()} ${args.map(formatArg).join(' ')}`);
}

/** Shell logging: goes to the ring buffer and the console. */
export function log(level: Level, ...args: unknown[]): void {
  record(level, args);
  original[level](...args);
}

/** Also keeps whatever other code (the engine, libraries) prints with console.*. */
export function installConsoleCapture(): void {
  for (const level of ['log', 'debug', 'info', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      record(level, args);
      original[level](...args);
    };
  }
}

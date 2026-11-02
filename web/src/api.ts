/** Calls to the server's /api routes (docs/WEB_CONTRACT.md). */

import { parseRetryAfter } from './format';
import type { CrashReport } from './crash-report';

/** The server did not answer, answered with a 5xx, or answered with something the contract does not allow. */
export class ServerUnreachableError extends Error {
  override name = 'ServerUnreachableError';
}

const TIMEOUT_MS = 15_000;
/** fetch() with keepalive may not carry more than 64 KB. */
const KEEPALIVE_LIMIT = 60 * 1024;

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...init,
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    throw new ServerUnreachableError(timedOut ? `${path} timed out` : `${path} could not be reached`);
  }
}

function unexpected(path: string, status: number): never {
  throw new ServerUnreachableError(`${path} answered with HTTP ${status}`);
}

/** True if the session cookie is valid. */
export async function getSession(): Promise<boolean> {
  const response = await request('/api/session');
  if (response.status === 204) return true;
  if (response.status === 401) return false;
  return unexpected('/api/session', response.status);
}

export type LoginResult =
  | { kind: 'ok' }
  | { kind: 'wrong-password' }
  | { kind: 'rate-limited'; retryAfterSeconds: number };

export async function login(password: string): Promise<LoginResult> {
  const response = await request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (response.status === 204) return { kind: 'ok' };
  if (response.status === 401) return { kind: 'wrong-password' };
  if (response.status === 429) {
    return { kind: 'rate-limited', retryAfterSeconds: parseRetryAfter(response.headers.get('Retry-After')) };
  }
  return unexpected('/api/login', response.status);
}

/** Sends a crash report. Returns whether the server accepted it; never throws. */
export async function sendCrashReport(report: CrashReport): Promise<boolean> {
  try {
    const body = JSON.stringify(report);
    const response = await fetch('/api/crash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      credentials: 'same-origin',
      keepalive: body.length < KEEPALIVE_LIMIT,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

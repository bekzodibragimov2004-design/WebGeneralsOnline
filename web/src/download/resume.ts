/**
 * Pure decision logic for resuming a partial download. The worker does the I/O; this file only
 * decides what to do, so it can be tested without a browser.
 */

/** Sidecar record stored next to each partial file. */
export interface PartialMeta {
  sha256: string;
  size: number;
  /** Strong ETag the partial bytes came from, or null if the server sent none. */
  etag: string | null;
}

export interface ResumeInput {
  expectedSize: number;
  expectedSha256: string;
  /** Bytes already in the partial file. */
  partialSize: number;
  meta: PartialMeta | null;
}

export type RestartReason = 'no-meta' | 'meta-mismatch' | 'oversize' | 'no-validator';

export type ResumeDecision =
  | { action: 'fresh' }
  | { action: 'resume'; offset: number; etag: string }
  | { action: 'verify' }
  | { action: 'restart'; reason: RestartReason };

/** A strong validator can be used with If-Range. Weak ETags (W/"...") cannot. */
export function usableEtag(etag: string | null | undefined): string | null {
  if (!etag) return null;
  const trimmed = etag.trim();
  if (trimmed === '' || trimmed.startsWith('W/')) return null;
  return trimmed;
}

export function planResume(input: ResumeInput): ResumeDecision {
  const { expectedSize, expectedSha256, partialSize, meta } = input;
  if (expectedSize === 0) return partialSize === 0 ? { action: 'verify' } : { action: 'restart', reason: 'oversize' };
  if (partialSize === 0) return { action: 'fresh' };
  if (!meta) return { action: 'restart', reason: 'no-meta' };
  if (meta.sha256 !== expectedSha256 || meta.size !== expectedSize) return { action: 'restart', reason: 'meta-mismatch' };
  if (partialSize > expectedSize) return { action: 'restart', reason: 'oversize' };
  if (partialSize === expectedSize) return { action: 'verify' };
  const etag = usableEtag(meta.etag);
  if (!etag) return { action: 'restart', reason: 'no-validator' };
  return { action: 'resume', offset: partialSize, etag };
}

export interface ContentRange {
  start: number;
  end: number;
  /** null when the server sent `*` for the total length. */
  total: number | null;
}

export function parseContentRange(header: string | null): ContentRange | null {
  if (!header) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (end < start) return null;
  return { start, end, total: match[3] === '*' ? null : Number(match[3]) };
}

export interface ResponseInfo {
  status: number;
  contentRange: string | null;
  /** Content-Length of the response, if present. */
  contentLength: number | null;
  /** Offset asked for with the Range header; 0 when no Range was sent. */
  requestedOffset: number;
  expectedSize: number;
}

export type ResponseAction =
  /** Body continues the partial file at requestedOffset. */
  | { action: 'append' }
  /** Body is the whole file; discard what is on disk and write from 0. */
  | { action: 'replace' }
  /** The range could not be honoured. Discard the partial file and ask again from 0. */
  | { action: 'restart' }
  /** Temporary trouble; back off and ask again. */
  | { action: 'retry'; reason: string }
  | { action: 'fail'; code: 'auth' | 'missing' | 'changed' | 'http'; status: number };

export function interpretResponse(info: ResponseInfo): ResponseAction {
  const { status, requestedOffset, expectedSize } = info;
  if (status === 401 || status === 403) return { action: 'fail', code: 'auth', status };
  if (status === 404 || status === 410) return { action: 'fail', code: 'missing', status };
  if (status === 408 || status === 425 || status === 429 || status >= 500) return { action: 'retry', reason: `HTTP ${status}` };
  if (status === 416) {
    return requestedOffset > 0 ? { action: 'restart' } : { action: 'fail', code: 'http', status };
  }
  if (status === 200) {
    if (info.contentLength !== null && info.contentLength !== expectedSize) return { action: 'fail', code: 'changed', status };
    return { action: 'replace' };
  }
  if (status === 206) {
    const range = parseContentRange(info.contentRange);
    if (!range) return { action: 'restart' };
    if (range.total !== null && range.total !== expectedSize) return { action: 'fail', code: 'changed', status };
    if (range.end + 1 !== (range.total ?? expectedSize)) return { action: 'restart' };
    if (range.start === requestedOffset) return requestedOffset === 0 ? { action: 'replace' } : { action: 'append' };
    return { action: 'restart' };
  }
  return { action: 'fail', code: 'http', status };
}

/** Delay before retry number `attempt` (0-based): 0.5 s, 1 s, 2 s, 4 s, then 8 s. */
export function retryDelayMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** Math.max(0, attempt));
}

/** Network failures with no progress in between before the worker gives up. */
export const MAX_STALLED_ATTEMPTS = 6;
/** Full re-downloads after a SHA-256 mismatch before the worker gives up. */
export const MAX_VERIFY_FAILURES = 2;

import { describe, expect, it } from 'vitest';
import {
  interpretResponse,
  parseContentRange,
  planResume,
  retryDelayMs,
  usableEtag,
  type PartialMeta,
  type ResponseInfo,
} from './resume';
import { MIB, chooseLimits, pickNext, sortForDispatch } from './schedule';

const SHA = 'a'.repeat(64);
const meta = (over: Partial<PartialMeta> = {}): PartialMeta => ({ sha256: SHA, size: 1000, etag: '"v1"', ...over });
const input = (over: Partial<Parameters<typeof planResume>[0]> = {}) => ({
  expectedSize: 1000,
  expectedSha256: SHA,
  partialSize: 400,
  meta: meta(),
  ...over,
});

describe('planResume', () => {
  it('starts fresh when there is no partial data', () => {
    expect(planResume(input({ partialSize: 0, meta: null }))).toEqual({ action: 'fresh' });
  });

  it('resumes from the partial size with the stored ETag', () => {
    expect(planResume(input())).toEqual({ action: 'resume', offset: 400, etag: '"v1"' });
  });

  it('verifies when the partial file is already full size', () => {
    expect(planResume(input({ partialSize: 1000 }))).toEqual({ action: 'verify' });
  });

  it('restarts when partial data has no metadata', () => {
    expect(planResume(input({ meta: null }))).toEqual({ action: 'restart', reason: 'no-meta' });
  });

  it('restarts when the file changed in the manifest since the partial was started', () => {
    expect(planResume(input({ meta: meta({ sha256: 'b'.repeat(64) }) }))).toEqual({ action: 'restart', reason: 'meta-mismatch' });
    expect(planResume(input({ meta: meta({ size: 999 }) }))).toEqual({ action: 'restart', reason: 'meta-mismatch' });
  });

  it('restarts when the partial file is bigger than the file should be', () => {
    expect(planResume(input({ partialSize: 1001 }))).toEqual({ action: 'restart', reason: 'oversize' });
  });

  it('cannot resume without a strong validator', () => {
    expect(planResume(input({ meta: meta({ etag: null }) }))).toEqual({ action: 'restart', reason: 'no-validator' });
    expect(planResume(input({ meta: meta({ etag: 'W/"weak"' }) }))).toEqual({ action: 'restart', reason: 'no-validator' });
  });

  it('handles empty files without a request', () => {
    expect(planResume(input({ expectedSize: 0, partialSize: 0, meta: null }))).toEqual({ action: 'verify' });
    expect(planResume(input({ expectedSize: 0, partialSize: 5 }))).toEqual({ action: 'restart', reason: 'oversize' });
  });
});

describe('usableEtag', () => {
  it('accepts strong tags only', () => {
    expect(usableEtag('"abc"')).toBe('"abc"');
    expect(usableEtag('W/"abc"')).toBeNull();
    expect(usableEtag('')).toBeNull();
    expect(usableEtag(null)).toBeNull();
  });
});

describe('parseContentRange', () => {
  it('parses start, end and total', () => {
    expect(parseContentRange('bytes 400-999/1000')).toEqual({ start: 400, end: 999, total: 1000 });
    expect(parseContentRange('bytes 0-9/*')).toEqual({ start: 0, end: 9, total: null });
  });
  it('rejects nonsense', () => {
    expect(parseContentRange(null)).toBeNull();
    expect(parseContentRange('bytes */1000')).toBeNull();
    expect(parseContentRange('items 1-2/3')).toBeNull();
    expect(parseContentRange('bytes 9-1/10')).toBeNull();
  });
});

describe('interpretResponse', () => {
  const base: ResponseInfo = { status: 206, contentRange: 'bytes 400-999/1000', contentLength: 600, requestedOffset: 400, expectedSize: 1000 };
  const act = (over: Partial<ResponseInfo>) => interpretResponse({ ...base, ...over });

  it('appends on a matching 206', () => {
    expect(act({})).toEqual({ action: 'append' });
  });

  it('replaces on 200 to a range request (If-Range failed: the file changed)', () => {
    expect(act({ status: 200, contentRange: null, contentLength: 1000 })).toEqual({ action: 'replace' });
  });

  it('replaces on a plain 200 for a fresh download', () => {
    expect(act({ status: 200, contentRange: null, contentLength: 1000, requestedOffset: 0 })).toEqual({ action: 'replace' });
  });

  it('fails when a 200 has a different length than the manifest says', () => {
    expect(act({ status: 200, contentRange: null, contentLength: 1234 })).toMatchObject({ action: 'fail', code: 'changed' });
  });

  it('restarts when the 206 starts somewhere else or is for a different total', () => {
    expect(act({ contentRange: 'bytes 0-999/1000' })).toEqual({ action: 'restart' });
    expect(act({ contentRange: 'bytes 0-999/1000', requestedOffset: 0 })).toEqual({ action: 'replace' });
    expect(act({ contentRange: 'bytes 200-999/1000' })).toEqual({ action: 'restart' });
    expect(act({ contentRange: 'garbage' })).toEqual({ action: 'restart' });
    expect(act({ contentRange: 'bytes 400-998/1000' })).toEqual({ action: 'restart' });
    expect(act({ contentRange: 'bytes 400-1199/1200' })).toMatchObject({ action: 'fail', code: 'changed' });
  });

  it('restarts on 416 when resuming, fails on 416 for a full request', () => {
    expect(act({ status: 416, contentRange: 'bytes */1000' })).toEqual({ action: 'restart' });
    expect(act({ status: 416, requestedOffset: 0 })).toMatchObject({ action: 'fail', code: 'http' });
  });

  it('maps auth and missing files to failures', () => {
    expect(act({ status: 401 })).toMatchObject({ action: 'fail', code: 'auth' });
    expect(act({ status: 403 })).toMatchObject({ action: 'fail', code: 'auth' });
    expect(act({ status: 404 })).toMatchObject({ action: 'fail', code: 'missing' });
  });

  it('retries server trouble', () => {
    for (const status of [429, 500, 502, 503, 504]) expect(act({ status })).toMatchObject({ action: 'retry' });
  });
});

describe('retryDelayMs', () => {
  it('doubles from 0.5 s up to 8 s', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(retryDelayMs)).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
  });
});

describe('concurrency policy', () => {
  it('limits big files but lets small files fill the other slots', () => {
    const limits = chooseLimits([200 * MIB, 200 * MIB, 200 * MIB, 200 * MIB, 1, 1, 1, 1, 1, 1]);
    expect(limits.maxActive).toBe(8);
    expect(limits.maxBigActive).toBe(3);
  });

  it('never exceeds the number of files', () => {
    expect(chooseLimits([5, 5])).toMatchObject({ maxActive: 2, maxBigActive: 1 });
    expect(chooseLimits([])).toMatchObject({ maxActive: 1 });
  });

  it('honours overrides', () => {
    expect(chooseLimits([1, 1, 1, 1], { maxActive: 2 }).maxActive).toBe(2);
  });

  it('starts the largest files first', () => {
    const sorted = sortForDispatch([{ size: 1 }, { size: 50 }, { size: 7 }, { size: 50 }]);
    expect(sorted.map((f) => f.size)).toEqual([50, 50, 7, 1]);
  });

  it('skips a big file when the big slots are full and takes the next small one', () => {
    const limits = { maxActive: 4, maxBigActive: 1, bigThreshold: 100 };
    expect(pickNext([500, 400, 10, 5], { total: 1, big: 1 }, limits)).toBe(2);
    expect(pickNext([500, 400], { total: 1, big: 1 }, limits)).toBe(-1);
    expect(pickNext([500, 10], { total: 0, big: 0 }, limits)).toBe(0);
  });

  it('starts nothing when every slot is busy', () => {
    expect(pickNext([1], { total: 4, big: 0 }, { maxActive: 4, maxBigActive: 1, bigThreshold: 100 })).toBe(-1);
  });
});

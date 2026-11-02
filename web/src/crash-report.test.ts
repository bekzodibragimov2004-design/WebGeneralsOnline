import { describe, expect, it } from 'vitest';
import { LOG_LINES, MAX_REPORT_BYTES, RingLog, buildCrashReport, classifyThrown, describeThrown, redact } from './crash-report';

describe('redact', () => {
  it.each([
    ['password=hunter2 next', 'hunter2'],
    ['{"password":"correct horse battery"}', 'correct horse battery'],
    ["login failed {password: 'p@ss w0rd'}", 'p@ss w0rd'],
    ['https://host/path?token=abcDEF123&x=1', 'abcDEF123'],
    ['api_key: sk-live-9999', 'sk-live-9999'],
    ['secret = topsecretvalue', 'topsecretvalue'],
    ['Authorization: Bearer abc.def.ghi-123456', 'abc.def.ghi-123456'],
    ['sent Bearer zyxwvutsrqponm to server', 'zyxwvutsrqponm'],
    ['Cookie: wgo_session=AAAA1111BBBB2222; other=1', 'AAAA1111BBBB2222'],
    ['Set-Cookie: wgo_session=ZZZZ9999; HttpOnly', 'ZZZZ9999'],
    ['document.cookie is wgo_session=QQQQ7777 here', 'QQQQ7777'],
    ['https://user:swordfish@example.test/x', 'swordfish'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef_ghij', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0'],
    ['id k3J9sd02LkQpZx81mNb7vC4tYhGfD5aW', 'k3J9sd02LkQpZx81mNb7vC4tYhGfD5aW'],
  ])('removes the secret from %j', (input, secret) => {
    const out = redact(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it('keeps ordinary text, paths and short hex', () => {
    const line = 'download Data/Synthetic/alpha.dat 1500 bytes ok sha abcd1234';
    expect(redact(line)).toBe(line);
    expect(redact('TypeError: Failed to fetch')).toBe('TypeError: Failed to fetch');
  });

  it('keeps the key name so the report is still readable', () => {
    expect(redact('password=hunter2')).toBe('password=[redacted]');
  });

  it('is safe to apply twice', () => {
    const once = redact('token=abc123xyz');
    expect(redact(once)).toBe(once);
  });
});

describe('RingLog', () => {
  it('keeps only the last 200 lines', () => {
    const log = new RingLog();
    for (let i = 0; i < 500; i += 1) log.push(`line ${i}`);
    const lines = log.lines();
    expect(lines).toHaveLength(LOG_LINES);
    expect(lines[0]).toBe('line 300');
    expect(lines[LOG_LINES - 1]).toBe('line 499');
  });

  it('redacts lines as they arrive', () => {
    const log = new RingLog();
    log.push('POST /api/login {"password":"fake-pass-value"}');
    expect(log.lines().join('\n')).not.toContain('fake-pass-value');
  });

  it('returns a copy', () => {
    const log = new RingLog(3);
    log.push('a');
    log.lines().push('b');
    expect(log.lines()).toEqual(['a']);
  });
});

describe('buildCrashReport', () => {
  const base = { buildHash: 'abc1234', phase: 'download', kind: 'exception', message: 'boom', stack: 'Error: boom\n    at x', log: ['one', 'two'] } as const;

  it('has exactly the fields of the contract', () => {
    const report = buildCrashReport(base);
    expect(Object.keys(report).sort()).toEqual(['buildHash', 'kind', 'log', 'message', 'phase', 'stack']);
    expect(report.log).toEqual(['one', 'two']);
  });

  it('strips secrets from message, stack and log', () => {
    const report = buildCrashReport({
      ...base,
      message: 'failed with password=hunter2',
      stack: 'at fetch (cookie: wgo_session=SECRETCOOKIE1)',
      log: ['token=abc999', 'fine'],
    });
    const text = JSON.stringify(report);
    for (const secret of ['hunter2', 'SECRETCOOKIE1', 'abc999']) expect(text).not.toContain(secret);
    expect(report.log[1]).toBe('fine');
  });

  it('never carries more than 200 log lines', () => {
    const lines = Array.from({ length: 450 }, (_, i) => `line ${i}`);
    const report = buildCrashReport({ ...base, log: lines });
    expect(report.log).toHaveLength(200);
    expect(report.log.at(-1)).toBe('line 449');
  });

  it('stays under the size limit even with huge input', () => {
    const big = 'x'.repeat(5_000);
    const report = buildCrashReport({ ...base, message: big, stack: big.repeat(10), log: Array.from({ length: 200 }, () => big) });
    expect(new TextEncoder().encode(JSON.stringify(report)).length).toBeLessThanOrEqual(MAX_REPORT_BYTES);
    expect(MAX_REPORT_BYTES).toBeLessThan(256 * 1024);
  });
});

describe('classifyThrown / describeThrown', () => {
  it('guesses the report kind', () => {
    expect(classifyThrown('RangeError: Out of memory')).toBe('oom');
    expect(classifyThrown('Aborted(OOM)')).toBe('oom');
    expect(classifyThrown('Aborted(assertion failed)')).toBe('abort');
    expect(classifyThrown('GPUDevice was lost')).toBe('webgpu');
    expect(classifyThrown('TypeError: x is not a function')).toBe('exception');
  });

  it('describes errors, strings and odd values', () => {
    expect(describeThrown(new TypeError('bad')).message).toBe('TypeError: bad');
    expect(describeThrown('plain').message).toBe('plain');
    expect(describeThrown({ a: 1 }).message).toBe('{"a":1}');
    expect(describeThrown(undefined).message).toBe('undefined');
  });
});

import { describe, expect, it } from 'vitest';
import { ProgressTracker } from './download/progress-state';
import { SpeedMeter, formatBytes, formatEta, formatSpeed, formatWait, parseRetryAfter, percent } from './format';

describe('formatting', () => {
  it('formats bytes, 1024-based', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1536 * 1024)).toBe('1.50 MB');
    expect(formatBytes(150 * 1024 ** 2)).toBe('150 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB');
    expect(formatBytes(-5)).toBe('0 B');
  });

  it('formats speed and ETA', () => {
    expect(formatSpeed(2 * 1024 ** 2)).toBe('2.00 MB/s');
    expect(formatSpeed(null)).toBe('-');
    expect(formatEta(5)).toBe('0:05');
    expect(formatEta(65.2)).toBe('1:06');
    expect(formatEta(3725)).toBe('1:02:05');
    expect(formatEta(null)).toBe('-');
  });

  it('clamps percent', () => {
    expect(percent(5, 10)).toBe(50);
    expect(percent(20, 10)).toBe(100);
    expect(percent(0, 0)).toBe(100);
  });

  it('formats waits', () => {
    expect(formatWait(1)).toBe('1 second');
    expect(formatWait(12)).toBe('12 seconds');
    expect(formatWait(120)).toBe('2 minutes');
    expect(formatWait(95)).toBe('1 min 35 s');
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  it('reads seconds', () => {
    expect(parseRetryAfter('17')).toBe(17);
  });
  it('reads an HTTP date', () => {
    expect(parseRetryAfter('Tue, 03 Nov 2026 12:01:30 GMT', now)).toBe(90);
  });
  it('falls back to 30 s when missing or unreadable, and clamps', () => {
    expect(parseRetryAfter(null)).toBe(30);
    expect(parseRetryAfter('soon')).toBe(30);
    expect(parseRetryAfter('0')).toBe(1);
    expect(parseRetryAfter('999999')).toBe(3600);
    expect(parseRetryAfter('Tue, 03 Nov 2026 11:00:00 GMT', now)).toBe(1);
  });
});

describe('SpeedMeter', () => {
  it('needs two samples apart before it reports', () => {
    const meter = new SpeedMeter();
    expect(meter.bytesPerSecond()).toBeNull();
    meter.add(0, 0);
    expect(meter.bytesPerSecond()).toBeNull();
    meter.add(100, 1000);
    expect(meter.bytesPerSecond()).toBeNull();
  });

  it('computes bytes per second over the window', () => {
    const meter = new SpeedMeter(5000);
    meter.add(0, 0);
    meter.add(1000, 2_000_000);
    expect(meter.bytesPerSecond()).toBe(2_000_000);
    expect(meter.etaSeconds(10_000_000)).toBe(5);
  });

  it('forgets samples older than the window', () => {
    const meter = new SpeedMeter(2000);
    meter.add(0, 0);
    meter.add(1000, 1_000_000);
    meter.add(10_000, 1_000_000 + 100);
    meter.add(11_000, 1_000_000 + 100 + 500_000);
    // Only the last two samples are inside the 2 s window: 500,000 bytes in 1 s.
    expect(meter.bytesPerSecond()).toBe(500_000);
  });

  it('reports no ETA when stalled', () => {
    const meter = new SpeedMeter();
    meter.add(0, 100);
    meter.add(2000, 100);
    expect(meter.etaSeconds(1000)).toBeNull();
  });
});

describe('ProgressTracker', () => {
  const message = (receivedBytes: number, extra = {}) => ({
    type: 'progress' as const,
    receivedBytes,
    totalBytes: 10_000_000,
    filesDone: 1,
    filesTotal: 4,
    active: ['Data/big.bin', 'Data/other.bin'],
    verifying: false,
    ...extra,
  });

  it('shows an indeterminate bar while checking', () => {
    const state = new ProgressTracker().state();
    expect(state.indeterminate).toBe(true);
    expect(state.status).toMatch(/Checking/);
  });

  it('shows percent, speed, ETA, files and the current file while downloading', () => {
    const tracker = new ProgressTracker();
    tracker.setPhase('downloading');
    tracker.update(message(0), 0);
    tracker.update(message(2_000_000), 1000);
    const state = tracker.state();
    expect(state.percent).toBe(20);
    expect(state.bytesText).toBe('1.91 MB of 9.54 MB');
    expect(state.speedText).toBe('1.91 MB/s');
    expect(state.etaText).toBe('0:04');
    expect(state.filesText).toBe('1 of 4 files');
    expect(state.currentFile).toBe('Data/big.bin');
    expect(state.indeterminate).toBe(false);
  });

  it('says verifying when every active file is being hashed', () => {
    const tracker = new ProgressTracker();
    tracker.setPhase('downloading');
    tracker.update(message(9_000_000, { verifying: true }), 0);
    expect(tracker.state().status).toMatch(/Verifying/);
  });

  it('reports up to date', () => {
    const tracker = new ProgressTracker();
    tracker.setUpToDate();
    expect(tracker.state()).toMatchObject({ phase: 'up-to-date', percent: 100 });
  });
});

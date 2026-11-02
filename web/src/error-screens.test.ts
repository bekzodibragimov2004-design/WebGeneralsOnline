import { describe, expect, it } from 'vitest';
import { checkSupport, describeBrowser, type BrowserEnv } from './capabilities';
import {
  chooseErrorScreen,
  classifyWorkerError,
  describeErrorScreen,
  screenKindFor,
  type ErrorSignal,
} from './error-screens';

const chromeUa =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function env(over: Partial<BrowserEnv> = {}): BrowserEnv {
  return {
    userAgent: chromeUa,
    uaData: {
      brands: [
        { brand: 'Chromium', version: '131' },
        { brand: 'Google Chrome', version: '131' },
        { brand: 'Not_A Brand', version: '24' },
      ],
      mobile: false,
      platform: 'Windows',
    },
    hasWebGpu: true,
    requestGpuAdapter: async () => true,
    crossOriginIsolated: true,
    hasSharedArrayBuffer: true,
    hasOpfs: true,
    hasWorker: true,
    ...over,
  };
}

describe('checkSupport', () => {
  it('accepts desktop Chrome with everything present', async () => {
    expect(await checkSupport(env())).toEqual([]);
  });

  it('rejects Edge (Chromium brands but not Google Chrome)', async () => {
    const edge = env({
      uaData: { brands: [{ brand: 'Chromium', version: '131' }, { brand: 'Microsoft Edge', version: '131' }], mobile: false, platform: 'Windows' },
    });
    expect(await checkSupport(edge)).toEqual(['not-chrome']);
  });

  it('rejects Firefox without client hints', async () => {
    const firefox = env({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; rv:130.0) Gecko/20100101 Firefox/130.0', uaData: null, hasWebGpu: false });
    expect(await checkSupport(firefox)).toContain('not-chrome');
  });

  it('rejects Chrome on a phone', async () => {
    const phone = env({
      uaData: { brands: [{ brand: 'Google Chrome', version: '131' }], mobile: true, platform: 'Android' },
    });
    expect(await checkSupport(phone)).toEqual(['mobile']);
  });

  it('falls back to the user agent string when client hints are missing', async () => {
    expect(await checkSupport(env({ uaData: null }))).toEqual([]);
    expect(await checkSupport(env({ uaData: null, userAgent: `${chromeUa} Edg/131.0.0.0` }))).toEqual(['not-chrome']);
    expect(await checkSupport(env({ uaData: null, userAgent: `${chromeUa} OPR/115.0.0.0` }))).toEqual(['not-chrome']);
    expect(describeBrowser({ userAgent: `${chromeUa} Mobile`, uaData: null }).mobile).toBe(true);
  });

  it('rejects an old Chrome', async () => {
    const old = env({ uaData: { brands: [{ brand: 'Google Chrome', version: '109' }], mobile: false, platform: 'Windows' } });
    expect(await checkSupport(old)).toEqual(['chrome-too-old']);
  });

  it('reports missing WebGPU, and a missing adapter separately', async () => {
    expect(await checkSupport(env({ hasWebGpu: false }))).toEqual(['no-webgpu']);
    expect(await checkSupport(env({ requestGpuAdapter: async () => false }))).toEqual(['no-gpu-adapter']);
    expect(
      await checkSupport(
        env({
          requestGpuAdapter: async () => {
            throw new Error('boom');
          },
        }),
      ),
    ).toEqual(['no-gpu-adapter']);
  });

  it('reports missing shared memory and missing isolation', async () => {
    expect(await checkSupport(env({ hasSharedArrayBuffer: false, crossOriginIsolated: false }))).toEqual([
      'no-shared-array-buffer',
      'not-cross-origin-isolated',
    ]);
    expect(await checkSupport(env({ crossOriginIsolated: false }))).toEqual(['not-cross-origin-isolated']);
  });

  it('reports missing OPFS or workers', async () => {
    expect(await checkSupport(env({ hasOpfs: false }))).toEqual(['no-opfs']);
    expect(await checkSupport(env({ hasWorker: false }))).toEqual(['no-opfs']);
  });

  it('lists every problem at once', async () => {
    const bad = env({ uaData: null, userAgent: 'Mozilla/5.0 Firefox/130.0', hasWebGpu: false, crossOriginIsolated: false });
    expect(await checkSupport(bad)).toEqual(['not-chrome', 'no-webgpu', 'not-cross-origin-isolated']);
  });
});

describe('chooseErrorScreen', () => {
  const unsupported: ErrorSignal = { type: 'unsupported', reasons: ['no-webgpu'] };
  const storage: ErrorSignal = { type: 'storage', needed: 10, available: 1 };
  const network: ErrorSignal = { type: 'network' };
  const goLogin: ErrorSignal = { type: 'go-login', failure: { reason: 'bad-credentials' } };
  const download: ErrorSignal = { type: 'download', message: 'x' };
  const crash: ErrorSignal = { type: 'crash', message: 'x', reported: null };

  it('returns null when there is nothing wrong', () => {
    expect(chooseErrorScreen([])).toBeNull();
    expect(chooseErrorScreen([null, undefined])).toBeNull();
  });

  it('prefers the problem the person can fix first', () => {
    expect(chooseErrorScreen([crash, download, goLogin, network, storage, unsupported])).toBe(unsupported);
    expect(chooseErrorScreen([crash, download, goLogin, network, storage])).toBe(storage);
    expect(chooseErrorScreen([crash, download, goLogin, network])).toBe(network);
    expect(chooseErrorScreen([crash, download, goLogin])).toBe(goLogin);
    expect(chooseErrorScreen([crash, download])).toBe(download);
    expect(chooseErrorScreen([crash])).toBe(crash);
  });

  it('maps each signal to its screen', () => {
    expect([unsupported, storage, network, goLogin, download, crash].map(screenKindFor)).toEqual([
      'unsupported-browser',
      'insufficient-storage',
      'server-unreachable',
      'go-login-failed',
      'download-failed',
      'crash',
    ]);
  });
});

describe('classifyWorkerError', () => {
  it('sends 401 back to the password gate', () => {
    expect(classifyWorkerError({ code: 'auth', message: '' })).toEqual({ kind: 'reauth' });
  });

  it('turns storage failures into the storage screen with the numbers', () => {
    const result = classifyWorkerError({ code: 'storage', message: '', needed: 500, available: 100 });
    expect(result).toEqual({ kind: 'signal', signal: { type: 'storage', needed: 500, available: 100 } });
    const refused = classifyWorkerError({ code: 'storage', message: '', needed: 5, available: 100, refused: true });
    expect(refused).toMatchObject({ signal: { type: 'storage', refused: true } });
  });

  it('turns network failures into the server-unreachable screen', () => {
    const result = classifyWorkerError({ code: 'network', message: 'dropped' });
    expect(result).toMatchObject({ kind: 'signal', signal: { type: 'network', detail: 'dropped' } });
  });

  it('shows integrity, manifest, locked and unknown failures as download failures', () => {
    for (const code of ['integrity', 'manifest', 'locked', 'server', 'unknown'] as const) {
      const result = classifyWorkerError({ code, message: 'm', path: 'a/b' });
      expect(result).toMatchObject({ kind: 'signal', signal: { type: 'download' } });
    }
  });
});

describe('describeErrorScreen', () => {
  it('storage: states bytes needed against bytes available and a next step', () => {
    const model = describeErrorScreen({ type: 'storage', needed: 3 * 1024 ** 3, available: 1 * 1024 ** 3 });
    expect(model.kind).toBe('insufficient-storage');
    expect(model.facts).toContain('Needed: 3.00 GB');
    expect(model.facts).toContain('Available: 1.00 GB');
    expect(model.facts).toContain('Short by: 2.00 GB');
    expect(model.steps.length).toBeGreaterThan(0);
    expect(model.actions.map((a) => a.id)).toContain('retry');
  });

  it('storage: when Chrome refused a write despite showing room, says so instead of a wrong shortfall', () => {
    const model = describeErrorScreen({ type: 'storage', needed: 2 * 1024 ** 3, available: 10 * 1024 ** 3, refused: true });
    expect(model.facts).toEqual(['Still needed: 2.00 GB', 'Chrome reports 10.0 GB free but refused to store more data.']);
  });

  it('storage: a refused write keeps the normal numbers when they do show a shortage', () => {
    const model = describeErrorScreen({ type: 'storage', needed: 3 * 1024 ** 3, available: 1 * 1024 ** 3, refused: true });
    expect(model.facts).toContain('Short by: 2.00 GB');
  });

  it('unsupported: names what was found and offers Chrome', () => {
    const model = describeErrorScreen({ type: 'unsupported', reasons: ['not-chrome', 'no-webgpu', 'not-cross-origin-isolated'] });
    expect(model.facts).toHaveLength(3);
    expect(model.steps.join(' ')).toMatch(/Chrome/);
    expect(model.steps.join(' ')).toMatch(/graphics/);
    expect(model.steps.join(' ')).toMatch(/headers/);
    expect(model.actions.map((a) => a.id)).toContain('get-chrome');
  });

  it('server unreachable: retry button and the detail', () => {
    const model = describeErrorScreen({ type: 'network', detail: '/api/session timed out' });
    expect(model.facts).toEqual(['/api/session timed out']);
    expect(model.actions[0]?.id).toBe('retry');
  });

  it('GO login failure: wording follows the reason and never asks for a password', () => {
    const bad = describeErrorScreen({ type: 'go-login', failure: { reason: 'bad-credentials' } });
    expect(bad.title).toMatch(/sign-in failed/);
    expect(bad.summary).toMatch(/account name or password/);
    expect(bad.actions.map((a) => a.id)).toEqual(['go-retry', 'reload']);

    const limited = describeErrorScreen({ type: 'go-login', failure: { reason: 'rate-limited', retryAfterSeconds: 90 } });
    expect(limited.steps.join(' ')).toMatch(/1 min 30 s/);
  });

  it('crash: reload is the way out, and the report status is shown', () => {
    expect(describeErrorScreen({ type: 'crash', message: 'boom', reported: true }).facts).toContain('A crash report was sent to the server.');
    expect(describeErrorScreen({ type: 'crash', message: 'boom', reported: false }).facts).toContain('The crash report could not be sent.');
    expect(describeErrorScreen({ type: 'crash', message: 'boom', reported: null }).actions.map((a) => a.id)).toEqual(['reload']);
  });
});

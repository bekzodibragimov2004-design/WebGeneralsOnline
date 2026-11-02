/** Browser support check: desktop Chrome with WebGPU, SharedArrayBuffer and OPFS. */

export const MIN_CHROME_MAJOR = 113; // first Chrome with WebGPU enabled

export type UnsupportedReason =
  | 'not-chrome'
  | 'mobile'
  | 'chrome-too-old'
  | 'no-webgpu'
  | 'no-gpu-adapter'
  | 'no-shared-array-buffer'
  | 'not-cross-origin-isolated'
  | 'no-opfs';

/** What the check needs from the browser. A plain object, so tests can fake it. */
export interface BrowserEnv {
  userAgent: string;
  uaData: { brands: { brand: string; version: string }[]; mobile: boolean; platform: string } | null;
  hasWebGpu: boolean;
  /** Resolves to true if a GPU adapter is available. Only called when hasWebGpu is true. */
  requestGpuAdapter: () => Promise<boolean>;
  crossOriginIsolated: boolean;
  hasSharedArrayBuffer: boolean;
  hasOpfs: boolean;
  hasWorker: boolean;
}

export interface BrowserInfo {
  isChrome: boolean;
  major: number | null;
  mobile: boolean;
}

const OTHER_CHROMIUM_UA = /\b(Edg|EdgA|EdgiOS|OPR|OPiOS|Opera|SamsungBrowser|Vivaldi|YaBrowser|CriOS|FxiOS)\//;
const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile/i;

export function describeBrowser(env: Pick<BrowserEnv, 'userAgent' | 'uaData'>): BrowserInfo {
  const { userAgent, uaData } = env;
  if (uaData) {
    const chrome = uaData.brands.find((entry) => entry.brand === 'Google Chrome');
    const major = chrome ? Number.parseInt(chrome.version, 10) : NaN;
    return {
      isChrome: Boolean(chrome),
      major: Number.isNaN(major) ? null : major,
      mobile: uaData.mobile || /^(Android|iOS)$/i.test(uaData.platform),
    };
  }
  const match = /\bChrome\/(\d+)/.exec(userAgent);
  const isChrome = Boolean(match) && !OTHER_CHROMIUM_UA.test(userAgent);
  return {
    isChrome,
    major: match ? Number.parseInt(match[1] as string, 10) : null,
    mobile: MOBILE_UA.test(userAgent),
  };
}

/** Everything that is wrong, in the order a person should fix it. Empty means supported. */
export async function checkSupport(env: BrowserEnv): Promise<UnsupportedReason[]> {
  const reasons: UnsupportedReason[] = [];
  const browser = describeBrowser(env);

  if (!browser.isChrome) reasons.push('not-chrome');
  if (browser.mobile) reasons.push('mobile');
  if (browser.isChrome && browser.major !== null && browser.major < MIN_CHROME_MAJOR) reasons.push('chrome-too-old');

  if (!env.hasWebGpu) {
    reasons.push('no-webgpu');
  } else {
    let adapter = false;
    try {
      adapter = await env.requestGpuAdapter();
    } catch {
      adapter = false;
    }
    if (!adapter) reasons.push('no-gpu-adapter');
  }

  if (!env.hasSharedArrayBuffer) reasons.push('no-shared-array-buffer');
  if (!env.crossOriginIsolated) reasons.push('not-cross-origin-isolated');
  if (!env.hasOpfs || !env.hasWorker) reasons.push('no-opfs');
  return reasons;
}

const ADAPTER_TIMEOUT_MS = 4000;

/** The real browser. */
export function readBrowserEnv(): BrowserEnv {
  const gpu = navigator.gpu;
  return {
    userAgent: navigator.userAgent,
    uaData: navigator.userAgentData ?? null,
    hasWebGpu: Boolean(gpu),
    requestGpuAdapter: async () => {
      if (!gpu) return false;
      const adapter = await Promise.race([
        gpu.requestAdapter(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), ADAPTER_TIMEOUT_MS)),
      ]);
      return adapter !== null;
    },
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    hasOpfs: typeof navigator.storage?.getDirectory === 'function',
    hasWorker: typeof Worker !== 'undefined',
  };
}

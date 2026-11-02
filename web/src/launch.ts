/**
 * Starting the engine.
 *
 * The engine build does not exist yet, so everything that touches /engine/generals.js lives in
 * loadEngine() below. When the real build lands, change that one function (for example to
 * import() it as a module, or to pass the canvas and file system in), nothing else.
 */

export const ENGINE_URL = '/engine/generals.js';

export type EngineLoadResult =
  | { status: 'loaded' }
  /** The server has no engine build (404). A normal state until the engine ships. */
  | { status: 'unavailable' }
  /** 401: the session cookie is gone. */
  | { status: 'unauthorized' }
  | { status: 'failed'; message: string; serverProblem: boolean };

export async function loadEngine(url: string = ENGINE_URL): Promise<EngineLoadResult> {
  let probe: Response;
  try {
    probe = await fetch(url, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' });
  } catch {
    return { status: 'failed', message: `${url} could not be reached`, serverProblem: true };
  }
  if (probe.status === 404) return { status: 'unavailable' };
  if (probe.status === 401 || probe.status === 403) return { status: 'unauthorized' };
  if (!probe.ok) return { status: 'failed', message: `${url} answered with HTTP ${probe.status}`, serverProblem: probe.status >= 500 };

  return new Promise<EngineLoadResult>((resolve) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => resolve({ status: 'loaded' });
    script.onerror = () => resolve({ status: 'failed', message: `${url} could not be loaded as a script`, serverProblem: false });
    document.head.append(script);
  });
}

/** The canvas the engine draws into. Created before the engine script runs. */
export function prepareEngineCanvas(): HTMLCanvasElement {
  const root = document.getElementById('engine-root');
  if (!root) throw new Error('#engine-root is missing from index.html');
  const existing = root.querySelector('canvas');
  if (existing) return existing;
  const canvas = document.createElement('canvas');
  canvas.id = 'canvas';
  canvas.tabIndex = -1;
  // The engine owns context loss; stop the browser's default handling.
  canvas.addEventListener('webglcontextlost', (event) => event.preventDefault());
  root.append(canvas);
  return canvas;
}

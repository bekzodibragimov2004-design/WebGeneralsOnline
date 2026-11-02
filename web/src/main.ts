import './styles.css';
import { ServerUnreachableError, getSession } from './api';
import { checkSupport, readBrowserEnv } from './capabilities';
import { installCrashHandlers, reportCrash, setCrashPhase } from './crash';
import { InstallError, installGame } from './download/client';
import { classifyWorkerError } from './error-screens';
import { runGate } from './gate';
import { reportGoLoginFailure } from './go-login';
import { loadEngine, prepareEngineCanvas } from './launch';
import { installConsoleCapture, log } from './log';
import { showError } from './ui/error-host';
import { renderDownload, renderLaunch } from './ui/views';

/** What the engine can reach on `window.wgoShell`. */
export interface WgoShell {
  buildHash: string;
  canvas: HTMLCanvasElement | null;
  reportGoLoginFailure: typeof reportGoLoginFailure;
  reportCrash: typeof reportCrash;
  setCrashPhase: typeof setCrashPhase;
}

declare global {
  interface Window {
    wgoShell?: WgoShell;
  }
}

/** Resolves once the server accepts us, asking for the password only if needed. */
async function ensureSession(): Promise<void> {
  for (;;) {
    try {
      if (await getSession()) {
        log('info', 'session is valid, skipping the password form');
        return;
      }
      await runGate();
      return;
    } catch (error) {
      if (!(error instanceof ServerUnreachableError)) throw error;
      log('error', `session check failed: ${error.message}`);
      await showError({ type: 'network', detail: error.message });
    }
  }
}

/** Downloads or updates the game files. Returns the installed game version. */
async function installFiles(): Promise<string> {
  for (;;) {
    const view = renderDownload();
    try {
      const installation = installGame((state) => view.update(state));
      const result = await installation.result;
      return result.version;
    } catch (error) {
      if (!(error instanceof InstallError)) throw error;
      const failure = classifyWorkerError(error.info);
      if (failure.kind === 'reauth') {
        log('info', 'session expired during download, asking for the password again');
        await runGate();
        continue;
      }
      await showError(failure.signal); // resolves on Retry; files already verified are kept
    }
  }
}

/** Loads the engine. Shows "engine build not available" (with a re-check button) while it is missing. */
async function launch(gameVersion: string): Promise<void> {
  for (;;) {
    const view = renderLaunch(gameVersion);
    const canvas = prepareEngineCanvas();
    if (window.wgoShell) window.wgoShell.canvas = canvas;
    const result = await loadEngine();
    switch (result.status) {
      case 'loaded':
        log('info', 'engine loaded');
        view.hide();
        setCrashPhase('menu');
        return;
      case 'unavailable':
        log('info', 'engine build not available on this server');
        await view.showUnavailable();
        break;
      case 'unauthorized':
        await runGate();
        break;
      case 'failed':
        log('error', `engine load failed: ${result.message}`);
        await showError(
          result.serverProblem
            ? { type: 'network', detail: result.message }
            : { type: 'download', message: `The game engine could not be started: ${result.message}` },
        );
        break;
    }
  }
}

async function main(): Promise<void> {
  installConsoleCapture();
  installCrashHandlers((signal) => void showError(signal));
  window.wgoShell = {
    buildHash: __BUILD_HASH__,
    canvas: null,
    reportGoLoginFailure,
    reportCrash,
    setCrashPhase,
  };
  log('info', `shell build ${__BUILD_HASH__}`);

  const problems = await checkSupport(readBrowserEnv());
  if (problems.length > 0) {
    log('warn', `unsupported browser: ${problems.join(', ')}`);
    await showError({ type: 'unsupported', reasons: problems });
    return;
  }

  await ensureSession();
  const version = await installFiles();
  await launch(version);
}

void main().catch((error: unknown) => {
  // Anything that escapes the flows above goes through the same crash path as window errors.
  void reportCrash('exception', error);
});

import { chooseErrorScreen, describeErrorScreen, type ActionId, type ErrorSignal } from '../error-screens';
import { log } from '../log';
import { appRoot } from './dom';
import { renderError } from './views';

const CHROME_DOWNLOAD_URL = 'https://www.google.com/chrome/';

let current: ErrorSignal | null = null;

export interface ShowOptions {
  /** Called when the person presses "Try again" on the Generals Online sign-in screen. */
  onGoRetry?: () => void;
}

/**
 * Shows an error screen. The promise resolves when the person chooses an action that lets the
 * caller carry on (Retry). Reload and "get Chrome" are handled here and never resolve it.
 *
 * If a more important error is already on screen, a new one is logged but does not replace it.
 */
export function showError(signal: ErrorSignal, options: ShowOptions = {}): Promise<ActionId> {
  // The same kind of error may update itself (the crash screen learns whether its report was sent).
  const chosen = current && current.type !== signal.type ? chooseErrorScreen([current, signal]) : signal;
  if (chosen !== signal) {
    log('warn', `not showing ${signal.type} error: ${current?.type ?? 'another'} error is already on screen`);
    return new Promise<ActionId>(() => undefined);
  }
  current = signal;
  log('info', `error screen: ${signal.type}`);

  return new Promise<ActionId>((resolve) => {
    renderError(describeErrorScreen(signal), (id) => {
      switch (id) {
        case 'reload':
          location.reload();
          return;
        case 'get-chrome':
          window.open(CHROME_DOWNLOAD_URL, '_blank', 'noopener,noreferrer');
          return;
        case 'go-retry':
          current = null;
          appRoot().replaceChildren();
          if (options.onGoRetry) options.onGoRetry();
          else location.reload();
          resolve(id);
          return;
        default:
          current = null;
          resolve(id);
      }
    });
  });
}

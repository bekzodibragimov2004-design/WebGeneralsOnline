import { ServerUnreachableError, login } from './api';
import { log } from './log';
import { showError } from './ui/error-host';
import { renderGate } from './ui/views';

/** Shows the password form and resolves once the server has accepted the password. */
export function runGate(): Promise<void> {
  return new Promise<void>((resolve) => {
    const view = renderGate(async (password) => {
      view.setBusy(true);
      view.showMessage('');
      try {
        const result = await login(password);
        if (result.kind === 'ok') {
          log('info', 'signed in');
          resolve();
          return;
        }
        view.setBusy(false);
        if (result.kind === 'wrong-password') {
          log('info', 'password rejected');
          view.showMessage('That password is not correct. Check it and try again.');
          view.focusPassword(true);
        } else {
          log('warn', `login rate limited for ${result.retryAfterSeconds}s`);
          view.lockFor(result.retryAfterSeconds);
        }
      } catch (error) {
        if (!(error instanceof ServerUnreachableError)) throw error;
        log('error', `login failed: ${error.message}`);
        await showError({ type: 'network', detail: error.message });
        await runGate();
        resolve();
      }
    });
  });
}

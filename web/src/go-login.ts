import { redact } from './crash-report';
import type { GoLoginFailure } from './error-screens';
import { log } from './log';
import { showError } from './ui/error-host';

export interface GoLoginHandlers {
  /** Runs when the person presses "Try again". Default: reload the page. */
  onRetry?: () => void;
}

/**
 * For the engine to call when Generals Online refuses the login. Shows the sign-in failure screen
 * with a next step. Never pass credentials: only the reason and a short message from GO.
 *
 * Reachable from the engine as `window.wgoShell.reportGoLoginFailure(...)`.
 */
export function reportGoLoginFailure(failure: GoLoginFailure, handlers: GoLoginHandlers = {}): void {
  const message = failure.message ? redact(failure.message).slice(0, 300) : undefined;
  log('warn', `GO login failed: ${failure.reason}${message ? ` (${message})` : ''}`);
  const safe: GoLoginFailure = { reason: failure.reason };
  if (message) safe.message = message;
  if (failure.retryAfterSeconds !== undefined) safe.retryAfterSeconds = failure.retryAfterSeconds;
  const options = handlers.onRetry ? { onGoRetry: handlers.onRetry } : {};
  void showError({ type: 'go-login', failure: safe }, options);
}

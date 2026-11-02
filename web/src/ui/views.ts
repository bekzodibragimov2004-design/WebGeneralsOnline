import type { ActionId, ErrorScreenModel } from '../error-screens';
import { formatWait } from '../format';
import type { DownloadViewState } from '../download/progress-state';
import { h, mount } from './dom';

function frame(...content: Node[]): HTMLElement {
  return h(
    'main',
    { class: 'stage' },
    h(
      'section',
      { class: 'panel' },
      h(
        'header',
        { class: 'brand' },
        h('div', { class: 'brand-mark', 'aria-hidden': 'true' }),
        h('div', {}, h('h1', { class: 'brand-name' }, 'WebGeneralsOnline'), h('p', { class: 'brand-sub' }, 'Browser client')),
      ),
      ...content,
    ),
    h('footer', { class: 'foot' }, `Shell build ${__BUILD_HASH__}`),
  );
}

// --- password gate ----------------------------------------------------------------------------

export interface GateView {
  setBusy(busy: boolean): void;
  showMessage(text: string): void;
  /** Disables the form and counts down; `onDone` runs when the wait is over. */
  lockFor(seconds: number): void;
  focusPassword(selectText?: boolean): void;
}

export function renderGate(onSubmit: (password: string) => void): GateView {
  const input = h('input', {
    id: 'password',
    name: 'password',
    type: 'password',
    autocomplete: 'current-password',
    required: true,
    'aria-describedby': 'gate-message',
  });
  const button = h('button', { type: 'submit', class: 'btn btn-primary', id: 'gate-submit' }, 'Continue');
  const message = h('p', { id: 'gate-message', class: 'message', role: 'alert' });
  const form = h(
    'form',
    {
      class: 'gate-form',
      onsubmit: (event: Event) => {
        event.preventDefault();
        if (input.value !== '' && !button.disabled) onSubmit(input.value);
      },
    },
    h('label', { for: 'password' }, 'Site password'),
    input,
    message,
    button,
  );
  mount(
    frame(
      h('h2', { class: 'screen-title' }, 'Enter the password'),
      h('p', { class: 'lead' }, 'This server is private. Enter the password you were given to continue.'),
      form,
    ),
  );

  let timer: ReturnType<typeof setInterval> | null = null;
  const stopTimer = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const view: GateView = {
    setBusy(busy) {
      button.disabled = busy || timer !== null;
      input.disabled = busy;
      button.textContent = busy ? 'Checking...' : 'Continue';
      if (!busy) input.focus();
    },
    showMessage(text) {
      message.textContent = text;
    },
    lockFor(seconds) {
      stopTimer();
      let left = seconds;
      const paint = () => {
        message.textContent = `Too many attempts. Try again in ${formatWait(left)}.`;
        button.disabled = true;
      };
      paint();
      timer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          stopTimer();
          message.textContent = 'You can try again now.';
          button.disabled = false;
          input.focus();
        } else {
          paint();
        }
      }, 1000);
    },
    focusPassword(selectText) {
      input.focus();
      if (selectText) input.select();
    },
  };
  input.focus();
  return view;
}

// --- download ---------------------------------------------------------------------------------

export interface DownloadView {
  update(state: DownloadViewState): void;
}

export function renderDownload(): DownloadView {
  const status = h('p', { class: 'status', id: 'dl-status', 'aria-live': 'polite' }, 'Checking for updates...');
  const fill = h('div', { class: 'bar-fill' });
  const bar = h(
    'div',
    { class: 'bar is-indeterminate', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-labelledby': 'dl-status', id: 'dl-bar' },
    fill,
  );
  const stat = (label: string, id: string) => {
    const value = h('dd', { id }, '-');
    return { node: h('div', { class: 'stat' }, h('dt', {}, label), value), value };
  };
  const bytes = stat('Downloaded', 'dl-bytes');
  const speed = stat('Speed', 'dl-speed');
  const eta = stat('Time left', 'dl-eta');
  const files = stat('Files', 'dl-files');
  const current = h('p', { class: 'current-file', id: 'dl-current' }, ' ');
  mount(
    frame(
      h('h2', { class: 'screen-title' }, 'Preparing game files'),
      status,
      bar,
      h('dl', { class: 'stats' }, bytes.node, speed.node, eta.node, files.node),
      current,
      h('p', { class: 'note' }, 'Keep this tab open. If the download is interrupted it continues where it stopped.'),
    ),
  );

  return {
    update(state) {
      status.textContent = state.status;
      bar.classList.toggle('is-indeterminate', state.indeterminate);
      fill.style.width = state.indeterminate ? '' : `${state.percent.toFixed(1)}%`;
      if (state.indeterminate) bar.removeAttribute('aria-valuenow');
      else bar.setAttribute('aria-valuenow', String(Math.round(state.percent)));
      bytes.value.textContent = state.bytesText || '-';
      speed.value.textContent = state.speedText;
      eta.value.textContent = state.etaText;
      files.value.textContent = state.filesText || '-';
      current.textContent = state.currentFile || ' ';
      current.title = state.currentFile;
    },
  };
}

// --- launch -----------------------------------------------------------------------------------

export interface LaunchView {
  setStatus(text: string): void;
  /** Shows the "engine not available" message and resolves when the person asks to check again. */
  showUnavailable(): Promise<void>;
  /** Empties the shell screen so the engine's canvas is visible. */
  hide(): void;
}

export function renderLaunch(gameVersion: string): LaunchView {
  const status = h('p', { class: 'status', id: 'launch-status', role: 'status' }, 'Starting the game engine...');
  const spinner = h('div', { class: 'spinner', 'aria-hidden': 'true' });
  const title = h('h2', { class: 'screen-title', id: 'launch-title' }, 'Launching');
  const body = h('div', { class: 'launch-body' }, spinner, status);
  mount(frame(title, body, h('p', { class: 'note' }, `Game files version ${gameVersion}`)));

  return {
    setStatus(text) {
      status.textContent = text;
    },
    showUnavailable() {
      return new Promise<void>((resolve) => {
        title.textContent = 'Engine build not available';
        const again = h('button', { class: 'btn btn-primary', id: 'launch-retry', type: 'button' }, 'Check again');
        again.addEventListener('click', () => resolve());
        body.replaceChildren(
          h(
            'p',
            { class: 'lead', id: 'launch-unavailable' },
            `Your game files are installed, but this server has no engine build to run them yet. Nothing is wrong with your browser or your files.`,
          ),
          h('p', { class: 'lead' }, 'Ask whoever runs this server to publish the engine, then check again.'),
          again,
        );
        again.focus();
      });
    },
    hide() {
      mount();
    },
  };
}

// --- errors -----------------------------------------------------------------------------------

export function renderError(model: ErrorScreenModel, onAction: (id: ActionId) => void): void {
  const buttons = model.actions.map((action, index) => {
    const button = h(
      'button',
      { class: `btn ${index === 0 ? 'btn-primary' : 'btn-quiet'}`, type: 'button', 'data-action': action.id },
      action.label,
    );
    button.addEventListener('click', () => onAction(action.id));
    return button;
  });
  mount(
    frame(
      h('div', { class: 'error-screen', 'data-screen': model.kind, role: 'alert' },
        h('h2', { class: 'screen-title is-error' }, model.title),
        h('p', { class: 'lead' }, model.summary),
        model.facts.length > 0 && h('ul', { class: 'facts' }, ...model.facts.map((fact) => h('li', {}, fact))),
        model.steps.length > 0 &&
          h('div', { class: 'steps' }, h('h3', {}, 'What to do'), h('ol', {}, ...model.steps.map((step) => h('li', {}, step)))),
        h('div', { class: 'actions' }, ...buttons),
      ),
    ),
  );
  buttons[0]?.focus();
}

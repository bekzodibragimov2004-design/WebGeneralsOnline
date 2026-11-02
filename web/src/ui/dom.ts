type Child = Node | string | null | undefined | false;
type AttrValue = string | number | boolean | null | undefined | ((event: Event) => void);

/**
 * Builds an element. Text children are added as text nodes, never as HTML, so server-supplied
 * strings can be shown safely.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, AttrValue> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === 'function') {
      element.addEventListener(name.replace(/^on/, '').toLowerCase(), value);
    } else if (value === true) {
      element.setAttribute(name, '');
    } else {
      element.setAttribute(name, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return element;
}

export function appRoot(): HTMLElement {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app is missing from index.html');
  return root;
}

/** Replaces everything on screen. */
export function mount(...nodes: Node[]): void {
  appRoot().replaceChildren(...nodes);
}

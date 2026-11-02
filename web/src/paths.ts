/** Helpers for manifest-style relative paths (forward slashes, original case). */

export function splitPath(path: string): string[] {
  return path.split('/');
}

export function dirnameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

export function basenameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

/** URL path for one game file under /assets/files/. Every segment is encoded. */
export function assetFileUrl(path: string): string {
  return `/assets/files/${splitPath(path).map(encodeURIComponent).join('/')}`;
}

/** The OPFS root directories this shell may write to. `/player/` is deliberately absent. */
export const WRITABLE_ROOTS = ['game', 'partial'] as const;
export type WritableRoot = (typeof WRITABLE_ROOTS)[number];

/** Defense in depth: anything that deletes or rewrites files goes through this check. */
export function assertWritableRoot(name: string): asserts name is WritableRoot {
  if (!(WRITABLE_ROOTS as readonly string[]).includes(name)) {
    throw new Error(`Refusing to modify OPFS root "${name}"; only ${WRITABLE_ROOTS.join(', ')} may be changed`);
  }
}

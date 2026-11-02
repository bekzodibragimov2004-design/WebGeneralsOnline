import { expect, test, type Page } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_PASSWORD, INTERRUPTED_PATH, startMockServer, syntheticBytes } from '../mock-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', '..', 'dist');
const shots = join(here, '..', '..', 'test-results', 'shots');

interface OpfsState {
  game: Record<string, { size: number; sha256: string }>;
  partial: string[];
  player: Record<string, string>;
  installedManifest: { version: string; files: { path: string }[] } | null;
}

/** Reads the origin private file system from inside the page. */
async function inspectOpfs(page: Page): Promise<OpfsState> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const walk = async (dir: FileSystemDirectoryHandle, prefix = ''): Promise<Record<string, File>> => {
      const found: Record<string, File> = {};
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'directory') Object.assign(found, await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`));
        else found[`${prefix}${name}`] = await (handle as FileSystemFileHandle).getFile();
      }
      return found;
    };
    const open = async (name: string) => {
      try {
        return await root.getDirectoryHandle(name);
      } catch {
        return null;
      }
    };
    const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

    const game: OpfsState['game'] = {};
    let installedManifest: OpfsState['installedManifest'] = null;
    const gameDir = await open('game');
    if (gameDir) {
      for (const [path, file] of Object.entries(await walk(gameDir))) {
        if (path === 'manifest.json') installedManifest = JSON.parse(await file.text());
        else game[path] = { size: file.size, sha256: hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())) };
      }
    }
    const partialDir = await open('partial');
    const partial = partialDir ? Object.keys(await walk(partialDir)) : [];
    const player: OpfsState['player'] = {};
    const playerDir = await open('player');
    if (playerDir) for (const [path, file] of Object.entries(await walk(playerDir))) player[path] = await file.text();
    return { game, partial, player, installedManifest };
  });
}

test('gate -> download -> launch, nothing re-downloaded on reload, then update and crash screen', async ({ page }) => {
  const server = await startMockServer({ distDir, maxLoginFailures: 2, retryAfterSeconds: 2 });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    await test.step('password gate: wrong password, rate limit with wait, then success', async () => {
      await page.goto(`${server.url}/`);
      await expect(page.locator('#password')).toBeVisible();
      await page.screenshot({ path: join(shots, '1-gate.png') });

      // Put some player data in OPFS first; no update may ever touch it.
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('player', { create: true });
        const handle = await dir.getFileHandle('save-slot-1.dat', { create: true });
        const writable = await handle.createWritable();
        await writable.write('synthetic player save');
        await writable.close();
      });

      await page.fill('#password', 'wrong-fake-password');
      await page.click('#gate-submit');
      await expect(page.locator('#gate-message')).toContainText('not correct');
      await page.screenshot({ path: join(shots, '2-gate-wrong.png') });

      // The second failure crosses the mock's limit: 429 with Retry-After: 2.
      await page.fill('#password', 'wrong-fake-password-again');
      await page.click('#gate-submit');
      await expect(page.locator('#gate-message')).toContainText(/Too many attempts. Try again in \d+ seconds?/);
      await expect(page.locator('#gate-submit')).toBeDisabled();
      await page.screenshot({ path: join(shots, '3-gate-rate-limited.png') });
      await expect(page.locator('#gate-submit')).toBeEnabled({ timeout: 10_000 });

      await page.fill('#password', FAKE_PASSWORD);
      await page.click('#gate-submit');
    });

    await test.step('download runs, verifies and reaches the launch page', async () => {
      // No engine build exists on the mock yet, so the launch page says so instead of failing.
      await expect(page.locator('#launch-unavailable')).toBeVisible({ timeout: 90_000 });
      await expect(page.locator('#launch-title')).toHaveText('Engine build not available');
      await page.screenshot({ path: join(shots, '4-launch-unavailable.png') });

      const files = server.fileRequests();
      const requestedPaths = new Set(files.map((entry) => decodeURIComponent(entry.path.replace('/assets/files/', ''))));
      expect(requestedPaths.has('Data/Synthetic/bravo.bin')).toBe(true);
      expect(requestedPaths.has('Large/Nested/Deep/path with space.bin')).toBe(true);
      expect(requestedPaths.has('Data/Synthetic/empty.dat')).toBe(false); // nothing to fetch for an empty file

      // The interrupted transfer was cut once, then continued with Range + If-Range (not restarted).
      const blob = files.filter((entry) => entry.path === `/assets/files/${INTERRUPTED_PATH}`);
      expect(blob[0]).toMatchObject({ status: 200, range: null, interrupted: true });
      const resumed = blob.find((entry) => entry.range !== null);
      expect(resumed, 'a Range request after the interruption').toBeDefined();
      const offset = Number(/^bytes=(\d+)-$/.exec(resumed?.range ?? '')?.[1]);
      expect(offset).toBeGreaterThan(0);
      expect(resumed?.ifRange).toMatch(/^"[0-9a-f]{16}"$/);
      expect(resumed?.status).toBe(206);
      expect(blob.length).toBe(2);

      // One download arrived with a flipped byte: the SHA-256 check caught it and the file was fetched
      // again from the start.
      const bravo = files.filter((entry) => entry.path === '/assets/files/Data/Synthetic/bravo.bin');
      expect(bravo.map((entry) => [entry.status, entry.range, entry.corrupted ?? false])).toEqual([
        [200, null, true],
        [200, null, false],
      ]);

      // Everything verified and installed; nothing left in staging; player data untouched.
      const manifest = await page.evaluate(async () => {
        const response = await fetch('/assets/manifest.json');
        return (await response.json()) as { files: { path: string; size: number; sha256: string }[] };
      });
      const state = await inspectOpfs(page);
      expect(Object.keys(state.game).sort()).toEqual(manifest.files.map((f) => f.path).sort());
      for (const file of manifest.files) expect(state.game[file.path]).toEqual({ size: file.size, sha256: file.sha256 });
      expect(state.installedManifest?.version).toBe('2026.11.03-test-1');
      expect(state.partial).toEqual([]);
      expect(state.player).toEqual({ 'save-slot-1.dat': 'synthetic player save' });
    });

    await test.step('reload: no password, no file downloads', async () => {
      server.resetRequests();
      await page.reload();
      await expect(page.locator('#launch-unavailable')).toBeVisible({ timeout: 30_000 });
      expect(server.fileRequests()).toEqual([]);
      expect(server.requests.some((r) => r.path === '/assets/manifest.json')).toBe(true);
      expect(server.requests.some((r) => r.path === '/api/login')).toBe(false);
      await expect(page.locator('#password')).toHaveCount(0);
    });

    await test.step('engine appears on the server: "Check again" loads it', async () => {
      server.setEngine(true);
      await page.click('#launch-retry');
      await expect.poll(() => page.evaluate(() => (window as unknown as { __engineStubLoaded?: boolean }).__engineStubLoaded)).toBe(true);
      await expect(page.locator('#app')).toBeEmpty();
    });

    await test.step('update: only changed and new files are fetched, removed files go, player data stays', async () => {
      server.resetRequests();
      server.setVersion('2026.11.03-test-2');
      server.setFile('Data/Synthetic/alpha.dat', syntheticBytes(99, 2000)); // changed
      server.setFile('Data/Synthetic/delta.dat', syntheticBytes(98, 5000)); // new
      server.removeFile('Config/sample.cfg'); // gone
      await page.reload();
      await expect.poll(() => page.evaluate(() => (window as unknown as { __engineStubLoaded?: boolean }).__engineStubLoaded), { timeout: 60_000 }).toBe(true);

      const fetched = server
        .fileRequests()
        .map((entry) => decodeURIComponent(entry.path.replace('/assets/files/', '')))
        .sort();
      expect(fetched).toEqual(['Data/Synthetic/alpha.dat', 'Data/Synthetic/delta.dat']);

      const state = await inspectOpfs(page);
      expect(state.game['Config/sample.cfg']).toBeUndefined();
      expect(state.game['Data/Synthetic/delta.dat']?.size).toBe(5000);
      expect(state.game['Data/Synthetic/alpha.dat']?.size).toBe(2000);
      expect(state.installedManifest?.version).toBe('2026.11.03-test-2');
      expect(state.partial).toEqual([]);
      expect(state.player).toEqual({ 'save-slot-1.dat': 'synthetic player save' });
    });

    await test.step('crash screen: error caught, redacted report sent, reload button recovers', async () => {
      await page.evaluate(() => {
        setTimeout(() => {
          throw new Error('deliberate test crash password=fake-secret-pw token=fake-token-123');
        }, 0);
      });
      const screen = page.locator('[data-screen="crash"]');
      await expect(screen).toBeVisible();
      await expect(screen).toContainText('A crash report was sent to the server.');
      await page.screenshot({ path: join(shots, '5-crash.png') });

      expect(server.crashReports).toHaveLength(1);
      const report = server.crashReports[0] as Record<string, unknown> & { log: string[] };
      expect(Object.keys(report).sort()).toEqual(['buildHash', 'kind', 'log', 'message', 'phase', 'stack']);
      expect(report.kind).toBe('exception');
      expect(report.phase).toBe('menu'); // the engine had loaded
      expect(report.message).toContain('deliberate test crash');
      expect(report.log.length).toBeGreaterThan(0);
      expect(report.log.length).toBeLessThanOrEqual(200);
      const text = JSON.stringify(report);
      expect(text).not.toContain('fake-secret-pw');
      expect(text).not.toContain('fake-token-123');

      await page.click('[data-action="reload"]');
      await expect.poll(() => page.evaluate(() => (window as unknown as { __engineStubLoaded?: boolean }).__engineStubLoaded)).toBe(true);
    });

    expect(pageErrors.filter((message) => !message.includes('deliberate test crash'))).toEqual([]);
  } finally {
    await server.close();
  }
});

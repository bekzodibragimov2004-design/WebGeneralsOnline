// Mock of the server in docs/WEB_CONTRACT.md, for tests and for `npm run dev`.
//
// It serves synthetic files that are generated when it starts. Nothing here comes from the game.
// The password below is a made-up test value, not a real credential.
//
//   node test/mock-server.mjs [--port 8787] [--dist dist] [--delay 0] [--engine]

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FAKE_PASSWORD = 'fake-test-password-not-real';
export const INTERRUPTED_PATH = 'Large/interrupted-blob.bin';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
};

/** Deterministic pseudo-random bytes: same seed and size give the same content. */
export function syntheticBytes(seed, size) {
  const out = Buffer.alloc(size);
  let state = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < size; i += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
}

/** A small tree of made-up files. Extensions are deliberately generic. */
export function makeSyntheticFiles() {
  const files = new Map();
  files.set('Data/Synthetic/alpha.dat', syntheticBytes(1, 1500));
  files.set('Data/Synthetic/bravo.bin', syntheticBytes(2, 300 * 1024));
  files.set('Data/Synthetic/charlie.pak', syntheticBytes(3, 2_500_000));
  files.set('Data/Synthetic/empty.dat', Buffer.alloc(0));
  files.set('Config/sample.cfg', Buffer.from('synthetic = true\nname = test\n'));
  files.set('Large/Nested/Deep/path with space.bin', syntheticBytes(4, 40 * 1024));
  files.set(INTERRUPTED_PATH, syntheticBytes(5, 6 * 1024 * 1024));
  return files;
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const byteCompare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function constantTimeEqual(a, b) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/**
 * @param {object} [options]
 * @param {number} [options.port] 0 picks a free port.
 * @param {string} [options.distDir] Built shell (vite build output), served at / and /shell/*.
 * @param {Map<string, Buffer>} [options.files]
 * @param {{path: string, afterBytes: number}[]} [options.interrupt] Each entry cuts the first full-file or
 *   range GET of that path after `afterBytes` bytes of body, once.
 * @param {string[]} [options.corrupt] Paths whose first full download has one byte flipped, once, so the
 *   SHA-256 check fails and the shell has to download the file again.
 * @param {number} [options.chunkDelayMs] Pause after every 64 KB chunk, to watch the progress screen.
 * @param {number} [options.maxLoginFailures] The failure that reaches this count is answered with 429.
 * @param {number} [options.retryAfterSeconds]
 * @param {boolean} [options.engine] Serve a stub at /engine/generals.js. Off means 404.
 * @param {string} [options.version]
 */
export async function startMockServer(options = {}) {
  const {
    port = 0,
    distDir = null,
    password = FAKE_PASSWORD,
    interrupt = [{ path: INTERRUPTED_PATH, afterBytes: 2_500_000 }],
    chunkDelayMs = 0,
    maxLoginFailures = 5,
    retryAfterSeconds = 2,
  } = options;
  let engineEnabled = options.engine ?? false;
  let version = options.version ?? '2026.11.03-test-1';
  const files = new Map();
  for (const [path, data] of options.files ?? makeSyntheticFiles()) files.set(path, { data, sha256: sha256(data) });

  const sessions = new Set();
  const requests = [];
  const crashReports = [];
  const pendingCorruptions = new Set(options.corrupt ?? ['Data/Synthetic/bravo.bin']);
  const pendingInterrupts = new Map(interrupt.map((entry) => [entry.path, entry.afterBytes]));
  let failures = 0;
  let lockedUntil = 0;

  const etagOf = (entry) => `"${entry.sha256.slice(0, 16)}"`;

  function manifest() {
    const list = [...files.keys()].sort(byteCompare).map((path) => {
      const entry = files.get(path);
      return { path, size: entry.data.length, sha256: entry.sha256 };
    });
    return {
      schema: 1,
      version,
      generatedAt: new Date().toISOString(),
      totalBytes: list.reduce((sum, file) => sum + file.size, 0),
      files: list,
    };
  }

  function hasSession(req) {
    const cookie = req.headers.cookie ?? '';
    for (const part of cookie.split(';')) {
      const [name, value] = part.trim().split('=');
      if (name === 'wgo_session' && sessions.has(value)) return true;
    }
    return false;
  }

  function readBody(req, limit) {
    return new Promise((resolveBody, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(Object.assign(new Error('too large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolveBody(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function reply(res, log, status, headers = {}, body = '') {
    log.status = status;
    res.writeHead(status, { 'Content-Length': Buffer.byteLength(body), ...headers });
    res.end(body);
  }

  async function sendBody(req, res, data, start, end, cutAfter) {
    const chunkSize = 64 * 1024;
    let position = start;
    let sent = 0;
    while (position <= end) {
      if (cutAfter !== null && sent >= cutAfter) {
        req.socket.destroy();
        return true;
      }
      const length = Math.min(chunkSize, end - position + 1, cutAfter === null ? Infinity : cutAfter - sent);
      await new Promise((done) => res.write(data.subarray(position, position + length), done));
      position += length;
      sent += length;
      if (chunkDelayMs > 0) await sleep(chunkDelayMs);
    }
    res.end();
    return false;
  }

  async function serveGameFile(req, res, log, path) {
    const entry = files.get(path);
    if (!entry) return reply(res, log, 404);
    const total = entry.data.length;
    const etag = etagOf(entry);
    const headers = { ETag: etag, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' };

    let start = 0;
    let end = total - 1;
    let status = 200;
    const range = req.headers.range;
    const ifRange = req.headers['if-range'];
    if (range && (ifRange === undefined || ifRange === etag)) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] !== '' || match[2] !== '')) {
        if (match[1] === '') {
          start = Math.max(0, total - Number(match[2]));
        } else {
          start = Number(match[1]);
          if (match[2] !== '') end = Math.min(end, Number(match[2]));
        }
        if (start >= total || start > end) {
          return reply(res, log, 416, { ...headers, 'Content-Range': `bytes */${total}` });
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
      }
    }
    headers['Content-Length'] = end - start + 1;
    log.status = status;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || total === 0) {
      res.end();
      return;
    }

    let cutAfter = null;
    const planned = pendingInterrupts.get(path);
    if (planned !== undefined && end - start + 1 > planned) {
      pendingInterrupts.delete(path);
      cutAfter = planned;
      log.interrupted = true;
    }
    let body = entry.data;
    if (start === 0 && pendingCorruptions.delete(path)) {
      body = Buffer.from(entry.data);
      body[Math.floor(total / 2)] ^= 0xff;
      log.corrupted = true;
    }
    await sendBody(req, res, body, start, end, cutAfter);
  }

  async function serveShell(res, log, pathname) {
    if (!distDir) return reply(res, log, 404);
    const relative = pathname === '/' || pathname === '/index.html' ? 'index.html' : pathname.replace(/^\/shell\//, '');
    const root = resolve(distDir);
    const target = normalize(join(root, relative));
    if (target !== root && !target.startsWith(root + sep)) return reply(res, log, 404);
    try {
      const data = await readFile(target);
      return reply(res, log, 200, { 'Content-Type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream' }, data);
    } catch {
      return reply(res, log, 404);
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const log = { method: req.method, path: pathname, range: req.headers.range ?? null, ifRange: req.headers['if-range'] ?? null, status: 0 };
    requests.push(log);

    // Every response, errors included.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    try {
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname.startsWith('/shell/'))) {
        return await serveShell(res, log, pathname);
      }

      if (req.method === 'POST' && pathname === '/api/login') {
        const body = await readBody(req, 4096);
        const now = Date.now();
        if (now < lockedUntil) {
          return reply(res, log, 429, { 'Retry-After': String(Math.ceil((lockedUntil - now) / 1000)) });
        }
        let given = '';
        try {
          given = String(JSON.parse(body.toString('utf8')).password ?? '');
        } catch {
          return reply(res, log, 400);
        }
        if (constantTimeEqual(given, password)) {
          failures = 0;
          const token = randomBytes(24).toString('base64url');
          sessions.add(token);
          return reply(res, log, 204, { 'Set-Cookie': `wgo_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/` });
        }
        failures += 1;
        if (failures >= maxLoginFailures) {
          failures = 0;
          lockedUntil = now + retryAfterSeconds * 1000;
          return reply(res, log, 429, { 'Retry-After': String(retryAfterSeconds) });
        }
        return reply(res, log, 401);
      }

      if (req.method === 'GET' && pathname === '/api/session') {
        return reply(res, log, hasSession(req) ? 204 : 401);
      }

      // Everything below needs the cookie.
      const protectedRoute = ['/api/logout', '/api/crash', '/assets/', '/engine/', '/go-api/', '/relay'].some((prefix) => pathname.startsWith(prefix));
      if (protectedRoute && !hasSession(req)) return reply(res, log, 401);

      if (req.method === 'POST' && pathname === '/api/logout') {
        sessions.clear();
        return reply(res, log, 204, { 'Set-Cookie': 'wgo_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' });
      }

      if (req.method === 'POST' && pathname === '/api/crash') {
        const body = await readBody(req, 256 * 1024);
        try {
          crashReports.push(JSON.parse(body.toString('utf8')));
        } catch {
          return reply(res, log, 400);
        }
        return reply(res, log, 204);
      }

      if (req.method === 'GET' && pathname === '/assets/manifest.json') {
        return reply(res, log, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, JSON.stringify(manifest()));
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/assets/files/')) {
        let path;
        try {
          path = decodeURIComponent(pathname.slice('/assets/files/'.length));
        } catch {
          return reply(res, log, 400);
        }
        return await serveGameFile(req, res, log, path);
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/engine/generals.js') {
        if (!engineEnabled) return reply(res, log, 404);
        return reply(res, log, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }, 'window.__engineStubLoaded = true;\n');
      }

      return reply(res, log, 404);
    } catch (error) {
      if (!res.headersSent) reply(res, log, error?.status ?? 500);
      else res.destroy();
    }
  });

  await new Promise((done) => server.listen(port, done));
  const actualPort = server.address().port;

  return {
    port: actualPort,
    url: `http://localhost:${actualPort}`,
    password,
    requests,
    crashReports,
    /** Requests for game file bodies (not the manifest). */
    fileRequests: () => requests.filter((entry) => entry.path.startsWith('/assets/files/')),
    resetRequests: () => {
      requests.length = 0;
    },
    setFile(path, data) {
      files.set(path, { data, sha256: sha256(data) });
    },
    removeFile(path) {
      files.delete(path);
    },
    setVersion(next) {
      version = next;
    },
    setEngine(enabled) {
      engineEnabled = enabled;
    },
    /** Invalidate every cookie, as if the server had restarted. */
    expireSessions() {
      sessions.clear();
    },
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--engine') args.engine = true;
    else if (arg.startsWith('--')) args[arg.slice(2)] = argv[(i += 1)];
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const here = fileURLToPath(new URL('.', import.meta.url));
  const server = await startMockServer({
    port: Number(args.port ?? 8787),
    distDir: resolve(args.dist ?? join(here, '..', 'dist')),
    chunkDelayMs: Number(args.delay ?? 0),
    engine: Boolean(args.engine),
  });
  console.log(`mock server on ${server.url}`);
  console.log(`test password: ${FAKE_PASSWORD}`);
  console.log(`serving ${resolve(args.dist ?? join(here, '..', 'dist'))} at / and /shell/*`);
}

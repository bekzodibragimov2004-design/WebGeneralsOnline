import { execSync } from 'node:child_process';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/** Short commit id for crash reports. Read-only git; falls back when git or a repo is missing. */
function buildHash(): string {
  if (process.env.BUILD_HASH) return process.env.BUILD_HASH.slice(0, 40);
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

// Same headers as every response from relay/ (docs/WEB_CONTRACT.md), so SharedArrayBuffer works in dev too.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** Dev only: the contract serves the gate at "/", Vite serves it under the /shell/ base. */
const redirectRoot: Plugin = {
  name: 'redirect-root-to-shell',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.statusCode = 302;
        res.setHeader('Location', '/shell/');
        res.end();
        return;
      }
      next();
    });
  },
};

// `npm run mock` serves the contract's routes with synthetic files; `npm run dev` proxies to it.
const backend = process.env.WGO_BACKEND ?? 'http://localhost:8787';

export default defineConfig({
  // The relay serves the shell's JS and CSS under /shell/*.
  base: '/shell/',
  define: { __BUILD_HASH__: JSON.stringify(buildHash()) },
  plugins: [redirectRoot],
  worker: { format: 'es' },
  build: { target: 'es2023', sourcemap: false },
  server: {
    port: 5173,
    headers: isolationHeaders,
    proxy: {
      '/api': backend,
      '/assets': backend,
      '/engine': backend,
    },
  },
  preview: { headers: isolationHeaders },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});

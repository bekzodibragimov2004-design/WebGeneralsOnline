import { defineConfig } from '@playwright/test';

// Runs against the installed Google Chrome (no browser download needed). The shell needs OPFS,
// which needs a secure context: http://localhost counts as one.
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 720 },
    trace: 'off',
  },
});

import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: {
    name: 'workers',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Node-only suites (SIGTERM, listener lifecycle) are excluded by naming convention.
    exclude: ['tests/**/*.node.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});

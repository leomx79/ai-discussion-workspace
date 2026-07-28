import { defineConfig } from 'vitest/config';
import { disableLiveE2ECredentials } from './scripts/live-e2e-env.ts';

disableLiveE2ECredentials(process.env);

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000, // 30 seconds for API calls
    reporters: process.env.GITHUB_ACTIONS ? ['dot', 'github-actions'] : ['dot'],
    silent: 'passed-only',
  }
});

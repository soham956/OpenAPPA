import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Tests never read the repo-root .env or secrets/. Live sidecar tests
    // skip themselves unless APPA_BIN is set or CLEARANCE_REQUIRE_APPA=1.
  },
});

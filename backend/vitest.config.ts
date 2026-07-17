import { defineConfig } from 'vitest/config';

// Sets TABLE_NAME / TOKEN_SECRET before any test module runs (data/handler layers
// read them lazily). The pure domain/auth tests don't depend on these.
export default defineConfig({
  test: {
    setupFiles: ['./src/test-setup.ts'],
  },
});

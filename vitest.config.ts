import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Several specs run many full seeded games; the 5s default times them out,
    // especially under CI / concurrent load. Give them headroom.
    testTimeout: 30000,
  },
});

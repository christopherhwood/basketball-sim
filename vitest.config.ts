import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Several specs run many full seeded games; the 5s default times them out,
    // especially on CI's slower runners. Each such test hard-caps its own tick
    // loop, so this ceiling is purely a guard against a genuine hang.
    testTimeout: 120000,
  },
});

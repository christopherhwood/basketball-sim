import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Several specs run many full seeded games; the 5s default times them out,
    // especially on CI's slower runners. Each such test hard-caps its own tick
    // loop, so this ceiling is purely a guard against a genuine hang.
    testTimeout: 120000,
    // The heavy statistical specs are CPU-bound. Running them in parallel on a
    // 2-core CI runner oversubscribes it: workers starve and miss Vitest's
    // worker-RPC heartbeat ("Timeout calling onTaskUpdate"), failing the run
    // even though every test passes. Run files serially so each gets a full
    // core and the main process stays responsive.
    fileParallelism: false,
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "node",
    testTimeout: 120000,
    fileParallelism: false,
  },
});

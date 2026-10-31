import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    clearMocks: true,
    // PGlite/WASM database suites are CPU- and memory-heavy. Four workers keep
    // the full suite deterministic on developer machines without hiding any
    // assertion failure.
    maxWorkers: 4,
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});

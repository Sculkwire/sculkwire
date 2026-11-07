import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Validator fixture tests run the real tsc; shared CI machines take longer than 5 s.
    testTimeout: 30_000,
  },
});

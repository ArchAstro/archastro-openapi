import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    // Regenerate the sample SDK before any test file is loaded. Keeps the
    // contract tests from drifting against the current generator + spec.
    globalSetup: ["./__tests__/setup/regenerate-sample-sdk.ts"],
  },
});

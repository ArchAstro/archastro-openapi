import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    // Regenerate the sample SDK + boot the harness subprocess. The `pretest`
    // script runs the same regeneration first (so the generated contract-test
    // files exist before vitest globs them on a cold checkout); this refreshes
    // them and starts the service.
    globalSetup: ["./__tests__/setup/regenerate-sample-sdk.mjs"],
    // The generated contract-test files (channels + SSE streams) all drive a
    // single shared harness subprocess and call reset() in beforeEach, so they
    // must run serially — parallel files would clear each other's scenarios and
    // observations mid-test.
    fileParallelism: false,
  },
});

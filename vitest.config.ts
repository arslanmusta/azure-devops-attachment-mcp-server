import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 20_000,
  },
});

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  webServer: process.env.YT_JAM_EXTERNAL_PREVIEW ? undefined : {
    command: "node ./scripts/serve-dist.mjs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    gracefulShutdown: { signal: "SIGINT", timeout: 500 },
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Starts stand-ins for SearXNG and Ollama plus BookMind itself (single-process mode, fresh DB),
// then runs every spec on a desktop and a phone profile.
import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const python = process.env.PYTHON || "python3";
const port = Number(process.env.E2E_PORT || 8765);
const db = path.join(os.tmpdir(), `bookmind-e2e-${Date.now()}.db`);

export default defineConfig({
  testDir: "./specs",
  fullyParallel: false,
  workers: 1, // specs share one server and its notebook
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    { command: `${python} fixtures/fake_searxng.py 8899`, port: 8899, reuseExistingServer: false },
    { command: `${python} fixtures/fake_ollama.py 11435`, port: 11435, reuseExistingServer: false },
    {
      command: `${python} -m bookmind --port ${port}`,
      cwd: root,
      url: `http://localhost:${port}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        BOOKMIND_DB_PATH: db,
        BOOKMIND_OLLAMA_URL: "http://127.0.0.1:11435/api/chat",
        BOOKMIND_SEARXNG_URL: "http://127.0.0.1:8899",
        BOOKMIND_WEBSEARCH_PROVIDERS: "searxng",
        BOOKMIND_RATE_API_BURST: "100000",
        BOOKMIND_RATE_RESEARCH_BURST: "100000",
      },
    },
  ],
});

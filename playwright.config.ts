// The end-to-end tests (plan step 5.1): three servers over the scripted agents, one per scenario; chromium only.
// `npm test` builds the page before it runs these.
import { defineConfig } from "@playwright/test";

const PORTS = { converge: 8101, decision: 8102, stop: 8103, interview: 8104, workCorrection: 8105, tabs: 8106, drop: 8107, long: 8108, questionReview: 8109, longChoices: 8110, decide: 8111, decideLong: 8112, decideRevise: 8113, decideBlank: 8114, planSteps: 8115, transportRetry: 8116, unchangedPause: 8117, longQuestion: 8118, permissionLong: 8119, whitespace: 8120, transportLong: 8121 } as const;

// E2E_SCENARIOS (comma-separated) starts only the servers a single test needs, so that one test runs in a short command.
const only = process.env.E2E_SCENARIOS?.split(",").filter((s) => s !== "") ?? [];
const servers = Object.entries(PORTS).filter(([scenario]) => only.length === 0 || only.includes(scenario));

export default defineConfig({
  testDir: "e2e",
  // Deadlines sized for a loaded machine (a shared CI runner, or this host at load 10 and more): a passing wait returns
  // at once, so only a genuine hang takes longer to report.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { browserName: "chromium", headless: true },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: servers.map(([scenario, port]) => ({
    command: `node e2e/server.ts`,
    env: { SCENARIO: scenario, PORT: String(port) },
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  })),
});

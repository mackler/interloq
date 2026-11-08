// The end-to-end tests (plan step 5.1): the scenario servers of e2e/ports.ts over the scripted agents; chromium only.
// `npm test` builds the page before it runs these.
import { defineConfig } from "@playwright/test";
import { SERVERS } from "./e2e/ports.ts";

// E2E_SCENARIOS (comma-separated) starts only the servers a single test needs, so that one test runs in a short command.
const only = process.env.E2E_SCENARIOS?.split(",").filter((s) => s !== "") ?? [];
const servers = SERVERS.filter(([scenario]) => only.length === 0 || only.includes(scenario));

export default defineConfig({
  testDir: "e2e",
  // Deadlines sized for a loaded machine (a shared CI runner, or this host at load 10 and more) running the tests in
  // parallel: a passing wait returns at once, so only a genuine hang takes longer to report. Issue #75: with the tests
  // in parallel on this host at load 20 and more, waits of 20 s and the long scenario's 60 s were exceeded (e2e (6), L18,
  // and the long scenario's (9), L4-L6), so each was tripled, with the test's own limit.
  timeout: 360_000,
  expect: { timeout: 60_000 },
  // Issue #75: the tests run on half of each machine's cores (eight here, two on the CI runner), from this one value,
  // which both read; test/ci.test.ts checks that nothing else sets it. One worker was the setting from the first
  // e2e commit (fd202b4), with no reason recorded. What must stay apart is the run of a scenario server, which holds
  // one run at a time: each server belongs to one file (e2e/ports.ts), and in each file the tests of one server are a
  // describe that runs in order in one worker, while the groups run in parallel.
  fullyParallel: true,
  workers: "50%",
  // Issue #39: where Interloq names a counts file (its final run of the end-to-end command), e2e/countsReporter.ts
  // writes the tests' counts there beside the list reporter's output.
  reporter: process.env.INTERLOQ_TEST_COUNTS_FILE === undefined || process.env.INTERLOQ_TEST_COUNTS_FILE === "" ? "list" : [["list"], ["./e2e/countsReporter.ts"]],
  use: { browserName: "chromium", headless: true },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: servers.map(([scenario, port]) => ({
    command: `node e2e/server.ts`,
    // Suite run 9 of issue #219: a server left by a runner stopped with `timeout` held its port, and Playwright refused
    // the next run. The configuration is evaluated in the runner, so this is the runner's pid, which e2e/server.ts watches.
    env: { SCENARIO: scenario, PORT: String(port), INTERLOQ_E2E_RUNNER_PID: String(process.pid) },
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  })),
});

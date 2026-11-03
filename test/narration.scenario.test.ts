// Issue #40: while the whole suite runs, nothing Interloq says or writes claims its success, even while the agent's
// narration already claims it; Interloq's own line comes only when the suite has completed (issue #162's ordering).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Effect, Fiber } from "effect";
import { exitCodeOf, program } from "../src/program.ts";
import { FULL_SUITE_PHASE, suitePassedLine } from "../src/prompts.ts";
import { finished, scriptedStart, tempRepo, testWiring } from "./helpers.ts";

const SUITE = "script/test --all";
const CLAIM = "npm test passes in full (unit 567, e2e 33)";

test("no program-generated success appears on the page or in conversation.md until the held suite completes", async () => {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const { wiring, probe } = testWiring(tempRepo(), {
    steps: [{ output: { questions_for_user: [] }, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
    execScripts: [{ said: [{ text: CLAIM, running: [] }] }],
    suite: [{ gate: () => held, result: { _tag: "Passed", output: "all passed\n", ms: 1 } }],
    config: { suiteCommand: SUITE },
  });
  const passed = suitePassedLine(FULL_SUITE_PHASE, SUITE);
  const conversation = (): string => {
    const file = path.join(probe.dir, "conversation.md");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  };
  const fiber = Effect.runFork(Effect.scoped(program(scriptedStart(probe.project), wiring)));
  for (let i = 0; i < 600 && probe.suite.runs.length === 0; i++) await sleep(50);
  assert.equal(probe.suite.runs.length, 1, "the suite did not start");
  await sleep(100);
  assert.ok(probe.ui.notified.some((e) => e._tag === "ClaudeSaid" && e.text === CLAIM), "the premature claim was not notified");
  assert.ok(!probe.ui.said.some((line) => line.includes(passed)), probe.ui.said.join("\n"));
  assert.ok(!probe.ui.notified.some((e) => e._tag === "PhaseEnded" && e.phase.kind === "suite"));
  assert.ok(!conversation().includes(passed));
  release();
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assert.equal(exitCodeOf(exit), 0);
  assert.ok(probe.ui.said.some((line) => line.includes(passed)));
  assert.ok(conversation().includes(passed));
});

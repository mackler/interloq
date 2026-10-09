import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Layer } from "effect";
import { executionSteps } from "../src/planSteps.ts";
import { renderPlanMarkdown } from "../src/plan.ts";
import { stepRecordedText, unknownStepText } from "../src/prompts.ts";
import type { RecordedPlan, StepStatus } from "../src/schema.ts";
import { Store, type StoreShape, Ui } from "../src/services.ts";
import { platformLayer } from "../src/platform.ts";
import { makeStore } from "../src/store.ts";
import { ScriptedUi, tempRepo , TEST_ROOT } from "./helpers.ts";

// Issue #6 (Q2, Q3, Q8, G-R1-2; P1-R1-4): report_step records on the plan held since the execution phase began.

const plan = (statuses: Record<string, StepStatus> = {}): RecordedPlan => ({
  stages: [{ number: 1, title: "t", steps: ["S1", "S2"].map((id, i) => ({ id, number: i + 1, label: `l ${id}`, text: `x ${id}`, status: statuses[id] ?? "pending" })) }],
});
const setup = async (initial: RecordedPlan | null = plan()) => {
  const store: StoreShape = await Effect.runPromise(makeStore(tempRepo(), TEST_ROOT, []).pipe(Effect.provide(platformLayer)));
  await Effect.runPromise(store.init("task"));
  if (initial !== null) await Effect.runPromise(store.savePlan(initial));
  const ui = new ScriptedUi([]);
  const run = <A, E>(effect: Effect.Effect<A, E, Store | Ui>): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(Layer.succeed(Store, store), Layer.succeed(Ui, ui)))));
  const files = () => ({ json: JSON.parse(fs.readFileSync(path.join(store.dir, "plan.json"), "utf8")).plan as RecordedPlan, md: fs.readFileSync(path.join(store.dir, "plan.md"), "utf8") });
  const changed = () => ui.notified.flatMap((e) => (e._tag === "PlanChanged" ? [e] : []));
  return { store, ui, run, files, changed };
};

test("a started and then a done report are written to plan.json and plan.md and notified with the phase", async () => {
  const h = await setup();
  const steps = await h.run(executionSteps(2));
  assert.deepEqual(await h.run(steps.report("S2", "started")), { text: stepRecordedText("S2", "started"), isError: false });
  assert.deepEqual(h.files().json, plan({ S2: "started" }));
  assert.equal(h.files().md, renderPlanMarkdown(plan({ S2: "started" })));
  await h.run(steps.report("S2", "done"));
  assert.deepEqual(h.files().json, plan({ S2: "done" }));
  assert.deepEqual(h.changed().map((e) => [e.phase, e.plan]), [[2, plan({ S2: "started" })], [2, plan({ S2: "done" })]]);
});

// Issue #53 (G-R1-1): PlanChanged names the report that caused it, so that the page can tell which step is current.
test("a report's PlanChanged names the step and the status reported", async () => {
  const h = await setup();
  const steps = await h.run(executionSteps(1));
  await h.run(steps.report("S1", "started"));
  await h.run(steps.report("S1", "done"));
  assert.deepEqual(h.changed().map((e) => e.step), [{ id: "S1", status: "started" }, { id: "S1", status: "done" }]);
});

test("a step reported started again while it is started is recorded and notified again with its report", async () => {
  const h = await setup();
  const steps = await h.run(executionSteps(1));
  await h.run(steps.report("S1", "started"));
  assert.deepEqual(await h.run(steps.report("S1", "started")), { text: stepRecordedText("S1", "started"), isError: false });
  assert.deepEqual(h.changed().map((e) => e.step), [{ id: "S1", status: "started" }, { id: "S1", status: "started" }]);
});

test("a second step started while another is started is recorded: nothing is refused (issue #53, Q1)", async () => {
  const h = await setup();
  const steps = await h.run(executionSteps(1));
  await h.run(steps.report("S1", "started"));
  assert.deepEqual(await h.run(steps.report("S2", "started")), { text: stepRecordedText("S2", "started"), isError: false });
  assert.deepEqual(h.files().json, plan({ S1: "started", S2: "started" }));
  assert.deepEqual(h.changed().at(-1)?.step, { id: "S2", status: "started" });
});

test("the end's PlanChanged names no report", async () => {
  const h = await setup();
  const steps = await h.run(executionSteps(1));
  await h.run(steps.report("S1", "started"));
  await h.run(steps.end);
  assert.equal(h.changed().at(-1)?.step, null);
});

test("an id that is not in the plan is an error for Claude Code: nothing is written or notified, and the run goes on", async () => {
  const h = await setup();
  const before = fs.readFileSync(path.join(h.store.dir, "plan.json"), "utf8");
  const steps = await h.run(executionSteps(1));
  assert.deepEqual(await h.run(steps.report("S9", "started")), { text: unknownStepText("S9", ["S1", "S2"]), isError: true });
  assert.equal(fs.readFileSync(path.join(h.store.dir, "plan.json"), "utf8"), before);
  assert.deepEqual(h.changed(), []);
});

test("a change of plan.json on disk between reports is not taken in: the next report writes the held plan", async () => {
  const h = await setup();
  const steps = await h.run(executionSteps(1));
  await h.run(steps.report("S1", "started"));
  await Effect.runPromise(h.store.savePlan(plan({ S1: "done", S2: "done" })));
  await h.run(steps.report("S1", "done"));
  assert.deepEqual(h.files().json, plan({ S1: "done" }));
});

test("concurrent reports are serialized: none is lost", async () => {
  const h = await setup();
  const steps = await h.run(executionSteps(1));
  await h.run(Effect.all([steps.report("S1", "done"), steps.report("S2", "started")], { concurrency: "unbounded" }));
  assert.deepEqual(h.files().json, plan({ S1: "done", S2: "started" }));
});

test("the end turns a started step unfinished, writes and notifies it", async () => {
  const h = await setup();
  const steps = await h.run(executionSteps(3));
  await h.run(steps.report("S1", "done"));
  await h.run(steps.report("S2", "started"));
  await h.run(steps.end);
  assert.deepEqual(h.files().json, plan({ S1: "done", S2: "unfinished" }));
  assert.deepEqual(h.changed().at(-1)?.plan, plan({ S1: "done", S2: "unfinished" }));
  assert.equal(h.changed().at(-1)?.phase, 3);
});

test("the end without a started step notifies nothing, and still replaces both files with the held plan", async () => {
  const h = await setup();
  const steps = await h.run(executionSteps(1));
  await h.run(steps.report("S1", "done"));
  // An edit of both files after the last report, as a Bash command could make.
  fs.writeFileSync(path.join(h.store.dir, "plan.json"), JSON.stringify({ version: 2, plan: plan({ S1: "done", S2: "done" }) }));
  fs.writeFileSync(path.join(h.store.dir, "plan.md"), "edited");
  const notified = h.changed().length;
  await h.run(steps.end);
  assert.equal(h.changed().length, notified);
  assert.deepEqual(h.files().json, plan({ S1: "done" }));
  assert.equal(h.files().md, renderPlanMarkdown(plan({ S1: "done" })));
});

test("without a plan, a report is an error and the end writes nothing", async () => {
  const h = await setup(null);
  const steps = await h.run(executionSteps(1));
  assert.equal((await h.run(steps.report("S1", "started"))).isError, true);
  await h.run(steps.end);
  assert.equal(fs.existsSync(path.join(h.store.dir, "plan.json")), false);
});

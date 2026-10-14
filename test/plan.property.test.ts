import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import fc from "fast-check";
import { endExecution, renderPlanMarkdown, STATUS_MARKER, stepRecordsOf, stripStatuses, validatePlan } from "../src/plan.ts";
import { stageHeading } from "../src/prompts.ts";
import type { RecordedPlan, StepStatus } from "../src/schema.ts";

// Issue #6 (G-R1-1, F2): the rows of the plan in recommendation E of docs/functional-design-review.md. A valid recorded
// plan revised to itself is itself, and the rendered plan.md carries everything plan.json carries.

const RUNS = { numRuns: 200, seed: 20260928 };
const record = <T>(shape: { [K in keyof T]: fc.Arbitrary<T[K]> }): fc.Arbitrary<T> => fc.record(shape, { noNullPrototype: true }) as fc.Arbitrary<T>;
const STATUSES: readonly StepStatus[] = ["pending", "started", "done", "unfinished"];
/** One line of text without a line break (a title, a label). */
const arbLine = fc.string({ maxLength: 30 }).map((s) => s.replace(/[\r\n]/g, " "));
/** A step's Markdown text: any lines, but no carriage return (plan.md is written with \n). */
const arbText = fc.array(fc.string({ maxLength: 20 }).map((s) => s.replace(/[\r\n]/g, "")), { maxLength: 4 }).map((lines) => lines.join("\n"));

/** A valid recorded plan: unique non-empty ids, numbers 1…n in order. */
const arbPlan: fc.Arbitrary<RecordedPlan> = fc
  .uniqueArray(fc.stringMatching(/^S[0-9A-Z]{1,4}$/), { maxLength: 8 })
  .chain((ids) => fc.array(fc.nat({ max: 2 }), { minLength: ids.length, maxLength: ids.length }).map((cuts) => ({ ids, cuts })))
  .chain(({ ids, cuts }) => {
    const steps = ids.map((id) => record({ id: fc.constant(id), label: arbLine, text: arbText, status: fc.constantFrom(...STATUSES) }));
    return fc.tuple(fc.tuple(...steps), fc.array(arbLine, { minLength: 3, maxLength: 3 })).map(([all, titles]) => {
      const groups: (typeof all)[number][][] = [[]];
      all.forEach((st, i) => {
        if (i > 0 && cuts[i] === 0) groups.push([]);
        groups[groups.length - 1].push(st);
      });
      return { stages: groups.map((g, i) => ({ number: i + 1, title: titles[i % 3], steps: g.map((st, j) => ({ ...st, number: j + 1 })) })) };
    });
  });

test("property: a valid recorded plan revised to its own steps is itself, statuses included", () => {
  fc.assert(
    fc.property(arbPlan, (plan) => {
      const r = validatePlan(plan, stripStatuses(plan));
      assert.ok(Result.isSuccess(r));
      assert.deepEqual(r.success.value, plan);
      assert.deepEqual(r.success.notes, []);
    }),
    RUNS,
  );
});

/** A reader of plan.md written for this test alone: what the rendered file says, back as data. */
const readPlanMarkdown = (md: string): RecordedPlan => {
  const statusOf = Object.fromEntries(Object.entries(STATUS_MARKER).map(([status, marker]) => [marker, status as StepStatus]));
  const lines = md.split("\n");
  const stages: { number: number; title: string; steps: RecordedPlan["stages"][number]["steps"][number][] }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const stage = /^## Stage (\d+): (.*)$/.exec(lines[i]);
    if (stage !== null) {
      stages.push({ number: Number(stage[1]), title: stage[2], steps: [] });
      continue;
    }
    const item = /^(\d+)\. \[(.)\] (.*) \(([^()]*)\)$/.exec(lines[i]);
    if (item === null) continue;
    const text: string[] = [];
    if (lines[i + 1] === "" && lines[i + 2]?.startsWith("   ")) {
      for (i += 2; i < lines.length && lines[i].startsWith("   "); i++) text.push(lines[i].slice(3));
      i--;
    }
    stages[stages.length - 1].steps.push({ id: item[4], number: Number(item[1]), label: item[3], text: text.join("\n"), status: statusOf[item[2]] });
  }
  return { stages };
};

test("property (F2): plan.md rendered from a plan reads back as that plan", () => {
  fc.assert(
    fc.property(arbPlan, (plan) => {
      assert.deepEqual(readPlanMarkdown(renderPlanMarkdown(plan)), plan);
    }),
    RUNS,
  );
});

test("the rendered stage heading is the one the rail shows", () => {
  const plan: RecordedPlan = { stages: [{ number: 2, title: "the records", steps: [] }] };
  assert.ok(renderPlanMarkdown(plan).includes(`## ${stageHeading(2, "the records")}`));
});

// Issue #157: stepRecordsOf is exactly the done and the unfinished steps, in plan order; after an execution's end no
// started step is missing from the unfinished ones.
test("property: stepRecordsOf partitions out the done and the unfinished steps in plan order", () => {
  fc.assert(
    fc.property(arbPlan, (plan) => {
      const all = plan.stages.flatMap((s) => s.steps);
      const records = stepRecordsOf(plan);
      assert.deepEqual(records.done, all.filter((s) => s.status === "done"));
      assert.deepEqual(records.unfinished, all.filter((s) => s.status === "unfinished"));
      const ended = stepRecordsOf(endExecution(plan)).unfinished.map((s) => s.id);
      for (const s of all.filter((s) => s.status === "started")) assert.ok(ended.includes(s.id), s.id);
    }),
    RUNS,
  );
});

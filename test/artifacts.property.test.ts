import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { type Artifact, RECORDS_DIR, recordPath, runRootOf, type SubjectId } from "../src/artifacts.ts";
import { RUN_MODES } from "../src/runMode.ts";

// Issue #120 (issue #66): two runs may be in progress at once, so for any two distinct runs no record path either
// produces is a path the other produces, and neither run's directory holds the other's.

const RUNS = { numRuns: 300, seed: 20261009 };
const n = fc.integer({ min: 1, max: 30 });
const subject: fc.Arbitrary<SubjectId> = fc.oneof(
  fc.constantFrom<SubjectId>("questions", "terms", "requirements"),
  n.map((k) => ({ plan: k })),
  n.map((k) => ({ work: k })),
  n.map((k) => ({ decision: k })),
);
const artifact: fc.Arbitrary<Artifact> = fc.oneof(
  fc.constantFrom<Artifact>(...(["conversation", "decisions", "feedback", "usage", "questions", "terms", "requirements", "plan", "planFile", "checkpoint", "config", "baseline"] as const).map((kind) => ({ kind }) as Artifact)),
  subject.map((s) => ({ kind: "log", subject: s }) as const),
  fc.tuple(fc.constantFrom("review", "response", "round") as fc.Arbitrary<"review" | "response" | "round">, subject, n).map(([kind, s, round]) => ({ kind, subject: s, round })),
  fc.tuple(subject, n, n).map(([s, round, attempt]) => ({ kind: "correction", subject: s, round, attempt }) as const),
  fc.tuple(fc.constantFrom("planWrite", "execution") as fc.Arbitrary<"planWrite" | "execution">, n).map(([kind, phase]) => ({ kind, phase })),
  n.map((phase) => ({ kind: "changes", phase }) as const),
  fc.tuple(fc.constantFrom("claude", "codex") as fc.Arbitrary<"claude" | "codex">, n).map(([agent, k]) => ({ kind: "invalidReply", agent, n: k }) as const),
  fc.tuple(fc.constantFrom("decisionQuestion", "analysis", "analysisWrite", "chosen") as fc.Arbitrary<"decisionQuestion" | "analysis" | "analysisWrite" | "chosen">, n).map(([kind, decision]) => ({ kind, decision })),
);
const time = fc.date({ min: new Date("2020-01-01T00:00:00Z"), max: new Date("2040-01-01T00:00:00Z"), noInvalidDate: true }).map((d) => d.toISOString());
const root = fc.tuple(fc.constantFrom(...RUN_MODES), fc.string({ minLength: 1, maxLength: 60 }), time).map(([mode, item, at]) => runRootOf(mode, item, at));

test("property: two distinct runs' roots produce disjoint record paths, and neither root contains the other", () => {
  fc.assert(
    fc.property(root, root, fc.array(artifact, { minLength: 1, maxLength: 8 }), fc.array(artifact, { minLength: 1, maxLength: 8 }), (a, b, as, bs) => {
      fc.pre(a !== b);
      const pa = new Set(as.map((x) => recordPath(a, x)));
      for (const x of bs) assert.ok(!pa.has(recordPath(b, x)));
      assert.ok(!`${RECORDS_DIR}/${a}/`.startsWith(`${RECORDS_DIR}/${b}/`) && !`${RECORDS_DIR}/${b}/`.startsWith(`${RECORDS_DIR}/${a}/`));
      for (const x of as) assert.ok(recordPath(a, x).startsWith(`${RECORDS_DIR}/${a}/`));
    }),
    RUNS,
  );
});

test("runRootOf names the start time, the mode and the item, under runs/", () => {
  assert.equal(runRootOf("implementation", "120", "2026-10-09T10:15:00.000Z"), "runs/2026-10-09T10-15-00-000Z-implementation-120");
  assert.equal(runRootOf("refinement", "a/b c", "2026-10-09T10:15:00.000Z"), "runs/2026-10-09T10-15-00-000Z-refinement-a_b_c");
  assert.equal(runRootOf("refinement", "x".repeat(50), "2026-10-09T10:15:00.000Z").length, "runs/2026-10-09T10-15-00-000Z-refinement-".length + 40);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { Disposition, RequirementFinding } from "../src/schema.ts";
import { findingsProblems, interviewedOf, writtenOf } from "../src/requirementsFindings.ts";

// Issue #47: the classification of the requirements review's accepted findings.
const RUNS = { numRuns: 200, seed: 20261103 };
const ACTIONS = ["accepted", "partially_accepted", "rejected", "no_change_needed", "clarification_requested"] as const;
const CURRENT = "# Requirements\n\nThe summary.\n";

const dispositions = fc.uniqueArray(fc.record({ id: fc.stringMatching(/^G-R1-[0-9]{1,3}$/), action: fc.constantFrom(...ACTIONS) }), { selector: (r) => r.id, maxLength: 8 }).map((rs): Disposition[] => rs.map((r) => ({ ...r, rationale: "r", duplicate_of: "", reverses: "" })));
const findingFor = (id: string): fc.Arbitrary<RequirementFinding> =>
  fc.oneof(
    fc.constant({ id, kind: "answered" as const, source: "user-decisions.md: yes" }),
    fc.constant({ id, kind: "corrected" as const }),
    fc.constant({ id, kind: "unresolved" as const }),
    fc.constant({ id, kind: "reopened" as const, changed: "the setting was removed" }),
  );
const accepted = (ds: readonly Disposition[]): string[] => ds.filter((x) => x.action === "accepted" || x.action === "partially_accepted").map((x) => x.id);
const validCase = dispositions.chain((ds) => fc.tuple(fc.constant(ds), fc.tuple(...accepted(ds).map(findingFor))));

test("one valid finding per accepted id and a changed document have no problem", () => {
  fc.assert(
    fc.property(validCase, ([ds, fs]) => {
      assert.deepEqual(findingsProblems(ds, fs, CURRENT + "\nThe answer.\n", CURRENT), []);
    }),
    RUNS,
  );
});

test("interviewedOf and writtenOf partition the findings, each in order", () => {
  fc.assert(
    fc.property(validCase, ([, fs]) => {
      const interviewed = interviewedOf(fs).map((f) => f.id);
      const written = writtenOf(fs).map((f) => f.id);
      assert.deepEqual(interviewed, fs.filter((f) => f.kind === "unresolved" || f.kind === "reopened").map((f) => f.id));
      assert.deepEqual(written, fs.filter((f) => f.kind === "answered" || f.kind === "corrected").map((f) => f.id));
      assert.equal(interviewed.length + written.length, fs.length);
    }),
    RUNS,
  );
});

test("removing one finding of a valid list yields exactly one missing problem for its id", () => {
  fc.assert(
    fc.property(
      validCase.filter(([, fs]) => fs.length > 0).chain(([ds, fs]) => fc.tuple(fc.constant(ds), fc.constant(fs), fc.nat({ max: fs.length - 1 }))),
      ([ds, fs, i]) => {
        const rest = fs.filter((_, j) => j !== i);
        assert.deepEqual(findingsProblems(ds, rest, CURRENT + "\nThe answer.\n", CURRENT), [{ kind: "missing", id: fs[i]!.id }]);
      },
    ),
    RUNS,
  );
});

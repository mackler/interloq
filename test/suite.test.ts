// Issue #162: the pure part of the whole suite's run: the tail of its output that the revision prompt carries.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { type SuiteFailure, type SuiteResult, suiteVerdictOf, tailLines } from "../src/suite.ts";

test("tailLines keeps the last n lines, and the whole text when it has fewer", () => {
  assert.equal(tailLines("a\nb\nc\nd\n", 2), "c\nd\n");
  assert.equal(tailLines("a\nb\nc", 2), "b\nc");
  assert.equal(tailLines("a\nb", 5), "a\nb");
  assert.equal(tailLines("", 3), "");
});

test("property: the tail is a suffix of the output with at most n lines, the whole output when it has n or fewer", () => {
  const output = fc.array(fc.string({ unit: fc.constantFrom("x", "y", " ") }), { maxLength: 30 }).chain((lines) => fc.boolean().map((end) => lines.join("\n") + (end ? "\n" : "")));
  fc.assert(
    fc.property(output, fc.integer({ min: 1, max: 10 }), (text, n) => {
      const tail = tailLines(text, n);
      assert.ok(text.endsWith(tail));
      const lines = (t: string): number => (t === "" ? 0 : t.replace(/\n$/u, "").split("\n").length);
      assert.ok(lines(tail) <= n);
      if (lines(text) <= n) assert.equal(tail, text);
      else assert.equal(lines(tail), n);
    }),
    { numRuns: 300 },
  );
});

// Issue #181 (requirements Q1, Q2): a stop by the limit or a failed start is not the work's fault; an exit or a signal is.
test("suiteVerdictOf: passed, a work failure for an exit or a signal, a stop for the limit or a failed start", () => {
  const failed = (reason: SuiteFailure): SuiteResult => ({ _tag: "Failed", reason, output: "", ms: 1 });
  assert.deepEqual(suiteVerdictOf({ _tag: "Passed", output: "", ms: 1 }), { _tag: "Passed" });
  assert.deepEqual(suiteVerdictOf(failed({ kind: "exit", code: 1 })), { _tag: "WorkFailed", reason: { kind: "exit", code: 1 } });
  assert.deepEqual(suiteVerdictOf(failed({ kind: "signal", signal: "SIGKILL" })), { _tag: "WorkFailed", reason: { kind: "signal", signal: "SIGKILL" } });
  assert.deepEqual(suiteVerdictOf(failed({ kind: "timedOut", ms: 5 })), { _tag: "Stopped", reason: { kind: "timedOut", ms: 5 } });
  assert.deepEqual(suiteVerdictOf(failed({ kind: "notStarted", message: "m" })), { _tag: "Stopped", reason: { kind: "notStarted", message: "m" } });
});

test("property: the verdict follows the kind of failure and carries the reason unchanged", () => {
  const reason: fc.Arbitrary<SuiteFailure> = fc.oneof(
    fc.integer().map((code) => ({ kind: "exit" as const, code })),
    fc.string().map((signal) => ({ kind: "signal" as const, signal })),
    fc.nat().map((ms) => ({ kind: "timedOut" as const, ms })),
    fc.string().map((message) => ({ kind: "notStarted" as const, message })),
  );
  const result: fc.Arbitrary<SuiteResult> = fc.oneof(
    fc.record({ output: fc.string(), ms: fc.nat() }).map(({ output, ms }) => ({ _tag: "Passed" as const, output, ms })),
    fc.record({ reason, output: fc.string(), ms: fc.nat() }).map(({ reason, output, ms }) => ({ _tag: "Failed" as const, reason, output, ms })),
  );
  fc.assert(
    fc.property(result, (r) => {
      const verdict = suiteVerdictOf(r);
      if (r._tag === "Passed") return assert.deepEqual(verdict, { _tag: "Passed" });
      const tag = r.reason.kind === "exit" || r.reason.kind === "signal" ? "WorkFailed" : "Stopped";
      assert.deepEqual(verdict, { _tag: tag, reason: r.reason });
    }),
    { numRuns: 300 },
  );
});

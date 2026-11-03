/**
 * Issue #39: the readers of each test runner's structured output, one per runner this repository uses, each from the
 * runner's own report and never from its printed summary. A text that is not the runner's shape is a failure with its
 * reason, never a guessed number. Pure.
 */
import { Result, Schema } from "effect";
import type { TestCounts } from "./testCounts.ts";

/** The environment variable naming the directory into which each stage of `npm test` writes its runner's report. */
export const STAGE_REPORT_VARIABLE = "INTERLOQ_STAGE_REPORT_DIR";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const reason = <A>(r: Result.Result<A, Schema.SchemaError>): Result.Result<A, string> => Result.mapError(r, (e) => e.message);

/** Node's final `test:summary` event's counts, as `scripts/nodeTestCounts.ts` writes them. */
const NodeSummary = Schema.fromJsonString(Schema.Struct({ passed: Count, failed: Count, cancelled: Count, skipped: Count, todo: Count }));
const decodeNode = Schema.decodeUnknownResult(NodeSummary);
/** Node's counts: a cancelled test fails the run, so it is failed; a todo test is skipped. */
export const nodeTestCounts = (text: string): Result.Result<TestCounts, string> =>
  Result.map(reason(decodeNode(text)), (c) => ({ passed: c.passed, failed: c.failed + c.cancelled, skipped: c.skipped + c.todo }));

/** Vitest's JSON reporter (Jest's shape). */
const VitestReport = Schema.fromJsonString(Schema.Struct({ numPassedTests: Count, numFailedTests: Count, numPendingTests: Count, numTodoTests: Count }));
const decodeVitest = Schema.decodeUnknownResult(VitestReport);
export const vitestCounts = (text: string): Result.Result<TestCounts, string> =>
  Result.map(reason(decodeVitest(text)), (r) => ({ passed: r.numPassedTests, failed: r.numFailedTests, skipped: r.numPendingTests + r.numTodoTests }));

const TAP_PLAN = /^1\.\.(\d+)(\s+#.*)?$/u;
const TAP_TEST = /^(not )?ok\b(.*)$/u;
const TAP_SKIP = /#\s*(skip|todo)\b/iu;
/**
 * bats' TAP report: each top-level test line counted once, a `# skip` or `# todo` directive skipped, `not ok` failed and
 * `ok` passed. Indented lines (diagnostics, YAML blocks, subtests) and comments are not test lines. A report without exactly one plan line `1..N` (an optional `# …` comment after it), or whose top-level test lines do not
 * number N, is not bats' report.
 */
export const tapCounts = (text: string): Result.Result<TestCounts, string> => {
  const lines = text.split(/\r\n|\r|\n/u);
  const plans = lines.flatMap((l) => {
    const m = TAP_PLAN.exec(l);
    return m === null ? [] : [Number(m[1])];
  });
  if (plans.length !== 1) return Result.fail(plans.length === 0 ? "no TAP plan line of the form 1..N" : `${plans.length} TAP plan lines`);
  const counts = lines.reduce<TestCounts>((c, l) => {
    const m = TAP_TEST.exec(l);
    if (m === null) return c;
    if (TAP_SKIP.test(m[2])) return { ...c, skipped: c.skipped + 1 };
    return m[1] === undefined ? { ...c, passed: c.passed + 1 } : { ...c, failed: c.failed + 1 };
  }, { passed: 0, failed: 0, skipped: 0 });
  const total = counts.passed + counts.failed + counts.skipped;
  return total === plans[0] ? Result.succeed(counts) : Result.fail(`the TAP plan names ${plans[0]} tests and the report has ${total}`);
};

/** A Playwright test's outcome, as `TestCase.outcome()` gives it. */
export type PlaywrightOutcome = "expected" | "unexpected" | "flaky" | "skipped";
/** One count per test Playwright ran: a flaky test passed on a retry. */
export const playwrightCounts = (outcomes: readonly PlaywrightOutcome[]): TestCounts => ({
  passed: outcomes.filter((o) => o === "expected" || o === "flaky").length,
  failed: outcomes.filter((o) => o === "unexpected").length,
  skipped: outcomes.filter((o) => o === "skipped").length,
});

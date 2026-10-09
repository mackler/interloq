import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import fc from "fast-check";
import { normalizeLabel } from "../src/analysis.ts";
import * as S from "../src/schema.ts";
import { entryOf } from "./helpers.ts";

// Row 5 of the table in recommendation E of docs/functional-design-review.md: the program's own record schemas.
const RUNS = { numRuns: 200, seed: 20260925 };
const record = <T>(shape: { [K in keyof T]: fc.Arbitrary<T[K]> }): fc.Arbitrary<T> => fc.record(shape, { noNullPrototype: true }) as fc.Arbitrary<T>;
const positiveInt = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
const nonNegativeInt = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });
const cost = fc.double({ min: 0, max: 1e6, noNaN: true, noDefaultInfinity: true });
const nonEmpty = fc.string({ minLength: 1 });
const nonBlank = fc.string({ minLength: 1 }).filter((t) => /\S/u.test(t));

const arbConfig = record<S.Config>({
  questionPhase: fc.boolean(),
  ignorePaths: fc.array(fc.string()),
  maxRounds: positiveInt,
  maxIdleRounds: positiveInt,
  maxTransportRetries: positiveInt,
  transportRetryDelaySeconds: fc.double({ min: Number.MIN_VALUE, max: 1e6, noNaN: true, noDefaultInfinity: true }),
  countMinor: fc.boolean(),
  execPermissionMode: fc.constantFrom("auto", "acceptEdits", "bypassPermissions", "default"),
  claudeModel: fc.option(fc.string(), { nil: null }),
  codexModel: fc.option(fc.string(), { nil: null }),
  tracker: fc.option(
    fc.record({ owner: nonBlank, repo: nonBlank, labels: fc.uniqueArray(nonBlank, { minLength: 5, maxLength: 5 }) }).map(({ owner, repo, labels }): S.GithubTrackerConfig => ({ kind: "github", owner, repo, labels: { unrefined: labels[0], refined: labels[1], implementing: labels[2], implemented: labels[3], deployed: labels[4] } })),
    { nil: null },
  ),
});
const arbIssueId = nonEmpty.map((s) => s as S.IssueId);
const entryBase = { id: arbIssueId, phase: nonNegativeInt, round: nonNegativeInt, problem: fc.string(), rationale: fc.string(), superseded: fc.boolean() };
const arbLogEntry: fc.Arbitrary<S.LogEntry> = fc.oneof(
  record({ ...entryBase, source: fc.constant("review" as const), severity: fc.constantFrom("blocking", "major", "minor"), location: fc.string(), evidence: fc.string(), action: fc.constantFrom("accepted", "partially_accepted", "rejected", "no_change_needed", "clarification_requested"), duplicate_of: fc.option(arbIssueId, { nil: null }), reverses: fc.option(arbIssueId, { nil: null }), file_change: fc.option(record({ changed: fc.boolean(), added: nonNegativeInt, removed: nonNegativeInt }), { nil: null }) }),
  record({ ...entryBase, source: fc.constant("self_correction" as const), action: fc.constantFrom("accepted", "plan_error", "correction_disputed"), file_change: fc.option(record({ changed: fc.boolean(), added: nonNegativeInt, removed: nonNegativeInt }), { nil: null }) }),
  record({ ...entryBase, source: fc.constant("user" as const), action: fc.constant("decided_by_user" as const) }),
);
const arbClaudeUsage = record({ version: fc.constant(2 as const), agent: fc.constant("claude" as const), time: fc.string(), session: fc.option(fc.string(), { nil: null }), num_turns: fc.option(nonNegativeInt, { nil: null }), total_cost_usd: fc.option(cost, { nil: null }) });
const arbCodexUsage = record({ version: fc.constant(2 as const), agent: fc.constant("codex" as const), time: fc.string(), thread: fc.option(fc.string(), { nil: null }), input_tokens: nonNegativeInt, output_tokens: nonNegativeInt });
const arbUsage: fc.Arbitrary<S.UsageRecord> = fc.oneof(arbClaudeUsage, arbCodexUsage);
const arbQuestions = record<S.QuestionsFile>({
  version: fc.constant(2),
  task: fc.string(),
  questions: fc.array(fc.record({ id: nonEmpty, context: fc.string(), question: fc.string(), reason: fc.string(), proposed_answers: fc.array(fc.record({ label: fc.string(), description: fc.string() })), default_answer: fc.string() }).map(entryOf)),
});

const roundTrips = <T>(schema: Schema.Codec<T>, value: T): void => {
  const encoded = Schema.encodeSync(schema)(value);
  assert.deepEqual(Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(encoded), value);
};
const rejected = (schema: Schema.Top & Schema.ConstraintDecoder<unknown>, value: unknown, what: string): void => assert.throws(() => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value), `${what} was accepted`);

test("property: encode/decode round trips for the record schemas", () => {
  fc.assert(fc.property(arbConfig, (c) => roundTrips(S.Config, c)), RUNS);
  fc.assert(fc.property(arbLogEntry, (e) => roundTrips(S.LogEntry, e)), RUNS);
  fc.assert(fc.property(arbUsage, (u) => roundTrips(S.UsageRecord, u)), RUNS);
  fc.assert(fc.property(arbQuestions, (q) => roundTrips(S.QuestionsFile, q)), RUNS);
});

test("property: negative, fractional and unsafe counts fail; empty required identifiers fail", () => {
  const badCount = fc.oneof(fc.integer({ max: 0 }), fc.double({ min: 1.0001, max: 1e6, noNaN: true, noInteger: true }), fc.constant(2 ** 53), fc.constant(Number.POSITIVE_INFINITY));
  fc.assert(
    fc.property(arbConfig, badCount, (c, bad) => {
      rejected(S.Config, { ...c, maxRounds: bad }, `maxRounds ${bad}`);
      rejected(S.Config, { ...c, maxIdleRounds: bad }, `maxIdleRounds ${bad}`);
    }),
    RUNS,
  );
  const badNonNegative = fc.oneof(fc.integer({ max: -1 }), fc.double({ min: 0.0001, max: 1e6, noNaN: true, noInteger: true }), fc.constant(2 ** 53));
  fc.assert(
    fc.property(arbLogEntry, badNonNegative, (e, bad) => {
      rejected(S.LogEntry, { ...e, phase: bad }, `phase ${bad}`);
      rejected(S.LogEntry, { ...e, round: bad }, `round ${bad}`);
      rejected(S.LogEntry, { ...e, id: "" }, "empty id");
    }),
    RUNS,
  );
  fc.assert(
    fc.property(arbClaudeUsage, arbCodexUsage, badNonNegative, fc.double({ max: -0.0001, noNaN: true, noDefaultInfinity: true }), (c, x, bad, negativeCost) => {
      rejected(S.UsageRecord, { ...c, num_turns: bad }, `num_turns ${bad}`);
      rejected(S.UsageRecord, { ...c, total_cost_usd: negativeCost }, `cost ${negativeCost}`);
      rejected(S.UsageRecord, { ...x, input_tokens: bad }, `input_tokens ${bad}`);
    }),
    RUNS,
  );
  fc.assert(
    fc.property(arbQuestions.filter((q) => q.questions.length > 0), fc.nat(), (q, pick) => {
      const i = pick % q.questions.length;
      rejected(S.QuestionsFile, { ...q, questions: q.questions.map((x, k) => (k === i ? { ...x, id: "" } : x)) }, "empty question id");
    }),
    RUNS,
  );
});

test("property: partial configs merge right-biased per key, and any unknown key is rejected", () => {
  const arbPartial = arbConfig.chain((c) => fc.subarray(Object.keys(c) as (keyof S.Config)[]).map((keys) => Object.fromEntries(keys.map((k) => [k, c[k]])) as Partial<S.Config>));
  const decodePartial = Schema.decodeUnknownSync(S.PartialConfig, { onExcessProperty: "error" });
  fc.assert(
    fc.property(arbPartial, arbPartial, (shared, project) => {
      const merged = { ...S.defaultConfig, ...decodePartial(shared), ...decodePartial(project) };
      for (const key of Object.keys(S.defaultConfig) as (keyof S.Config)[]) {
        const expected = key in project ? project[key] : key in shared ? shared[key] : S.defaultConfig[key];
        assert.deepEqual(merged[key], expected, key);
      }
    }),
    RUNS,
  );
  fc.assert(
    fc.property(arbPartial, fc.stringMatching(/^[a-z][A-Za-z]{2,12}$/).filter((k) => !(k in S.defaultConfig)), fc.anything(), (partial, key, value) => {
      assert.throws(() => decodePartial({ ...partial, [key]: value }), `unknown key ${key} was accepted`);
    }),
    RUNS,
  );
});

// Row 5, domain validation (issue #37, W1-R1-1): the tolerant comparison of an analysis's option labels.
const collapse = (s: string): string => s.split(/\s+/).filter((w) => w !== "").join(" ");
test("normalizeLabel: leading ordinals are dropped, whitespace collapsed; it is idempotent and ignores an added ordinal", () => {
  fc.assert(
    fc.property(fc.nat(999), fc.constantFrom(".", ")"), fc.oneof(fc.string(), fc.tuple(fc.nat(99), fc.string()).map(([k, t]) => `${k}. ${t}`)), (n, mark, label) => {
      assert.equal(normalizeLabel(`${n}${mark} ${label}`), normalizeLabel(label));
      assert.equal(normalizeLabel(normalizeLabel(label)), normalizeLabel(label));
      assert.equal(normalizeLabel(label), collapse(normalizeLabel(label)));
    }),
    RUNS,
  );
});

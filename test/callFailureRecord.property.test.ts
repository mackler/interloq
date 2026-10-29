// Issue #192, requirements Q1: the line of a failed Claude Code request holds the failure's facts with every value of a
// credential-named variable redacted. The properties check the occurrences in the input against a reference mask the
// test computes itself, never the joined output, since a marker next to other text can form a string the input never
// held (review P1-R1-2).
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { REDACTED, failureLineOf, redact, secretsOf } from "../src/callFailureRecord.ts";
import type { ClaudeFailure } from "../src/transport.ts";

const RUNS = { numRuns: 300, seed: 20261029 };

/** True at every character any occurrence of any secret covers, overlapping occurrences included. */
const maskOf = (text: string, secrets: readonly string[]): boolean[] => {
  const mask = Array.from({ length: text.length }, () => false);
  for (const secret of secrets) {
    for (let start = 0; start + secret.length <= text.length; start++) {
      if (text.slice(start, start + secret.length) === secret) for (let i = start; i < start + secret.length; i++) mask[i] = true;
    }
  }
  return mask;
};

/** The expected output from the mask: the unmarked runs, one REDACTED where each run of marked characters stood. */
const expected = (text: string, mask: readonly boolean[]): { output: string; runs: string[] } => {
  let output = "";
  const runs: string[] = [];
  let run = "";
  for (let i = 0; i < text.length; i++) {
    if (mask[i]) {
      if (i === 0 || !mask[i - 1]) {
        if (run !== "") runs.push(run);
        run = "";
        output += REDACTED;
      }
    } else {
      run += text[i];
      output += text[i];
    }
  }
  if (run !== "") runs.push(run);
  return { output, runs };
};

const alphabet = fc.constantFrom("a", "b", "c", "x", " ", "[", "]", "r", "e", "d");
const small = (max: number) => fc.array(alphabet, { maxLength: max }).map((cs) => cs.join(""));
const secret = fc.array(alphabet, { minLength: 1, maxLength: 4 }).map((cs) => cs.join("")).filter((s) => s.trim() !== "");
const textWithSecrets = fc.tuple(fc.array(secret, { maxLength: 3 }), fc.array(fc.tuple(small(6), fc.nat()), { maxLength: 5 })).map(([secrets, parts]) => ({
  secrets,
  // Each part followed by a secret (where there is one), so secrets occur, some adjacent and overlapping.
  text: parts.map(([p, k]) => p + (secrets.length === 0 ? "" : secrets[k % secrets.length])).join(""),
}));

test("property: redact replaces exactly the characters an occurrence covers, each run by one marker", () => {
  fc.assert(
    fc.property(textWithSecrets, ({ secrets, text }) => {
      const mask = maskOf(text, secrets);
      const { output, runs } = expected(text, mask);
      assert.equal(redact(text, secrets), output);
      for (const r of runs) for (const s of secrets) assert.ok(!r.includes(s));
      assert.equal(runs.join(""), Array.from(text).filter((_, i) => !mask[i]).join(""));
    }),
    RUNS,
  );
});

const nullable = <A>(a: fc.Arbitrary<A>) => fc.option(a, { nil: null });
const failure: fc.Arbitrary<ClaudeFailure> = fc.record({
  streamCode: nullable(fc.string()),
  apiStatus: nullable(fc.integer({ min: 100, max: 599 })),
  terminalReason: nullable(fc.string()),
  assistantError: nullable(fc.string()),
  retrySeen: nullable(fc.record({ status: nullable(fc.integer({ min: 100, max: 599 })), error: fc.string() })),
  subtype: nullable(fc.string()),
  rejection: nullable(
    fc.oneof(
      fc.record({ kind: fc.constant("withReset" as const), resetsAtMs: fc.integer({ min: 0, max: 2 ** 41 }), limitType: nullable(fc.string()) }),
      fc.record({ kind: fc.constant("withoutReset" as const), limitType: nullable(fc.string()) }),
    ),
  ),
  resultText: nullable(fc.string()),
  processEnd: nullable(fc.oneof(fc.record({ kind: fc.constant("signal" as const), signal: fc.string() }), fc.record({ kind: fc.constant("exit" as const), code: fc.integer() }))),
});
const input = fc.record({ session: nullable(fc.string()), purpose: fc.constantFrom("planning" as const, "interview" as const, "context" as const, "execution" as const), callId: fc.string(), message: fc.string(), failure });
const r = (t: string | null, secrets: readonly string[]) => (t === null ? null : redact(t, secrets));

test("property: every string fact of the line is redact of the input's fact", () => {
  fc.assert(
    fc.property(input, fc.array(secret, { maxLength: 3 }), (given, secrets) => {
      const line = failureLineOf(given, secrets);
      const f = line.failure;
      assert.ok(f !== null);
      assert.equal(line.message, redact(given.message, secrets));
      assert.equal(f.streamCode, r(given.failure.streamCode, secrets));
      assert.equal(f.terminalReason, r(given.failure.terminalReason, secrets));
      assert.equal(f.assistantError, r(given.failure.assistantError, secrets));
      assert.equal(f.subtype, r(given.failure.subtype, secrets));
      assert.equal(f.resultText, r(given.failure.resultText, secrets));
      assert.equal(f.retrySeen?.error ?? null, r(given.failure.retrySeen?.error ?? null, secrets));
      assert.equal(f.rejection?.limitType ?? null, r(given.failure.rejection?.limitType ?? null, secrets));
      assert.equal(f.apiStatus, given.failure.apiStatus);
      assert.deepEqual(f.processEnd?.kind ?? null, given.failure.processEnd?.kind ?? null);
    }),
    RUNS,
  );
});

test("property: with no secrets every fact comes through unchanged", () => {
  fc.assert(
    fc.property(input, (given) => {
      // fast-check builds records without a prototype; JSON compares the fields alone.
      assert.deepEqual(JSON.parse(JSON.stringify(failureLineOf(given, []))), JSON.parse(JSON.stringify(given)));
    }),
    RUNS,
  );
});

test("the marker collision: a marker formed by a replacement is not redacted again", () => {
  assert.equal(redact("[redacted]x abx", ["[redacted]x", "ab"]), "[redacted] [redacted]x");
});

test("overlapping secrets are one run", () => {
  assert.equal(redact("xabcdy", ["abc", "bcd"]), "x[redacted]y");
});

test("a one-character secret is replaced", () => {
  assert.equal(redact("a-b-a", ["a"]), "[redacted]-b-[redacted]");
});

test("secretsOf picks the credential-named variables that are not blank", () => {
  const env = {
    CLAUDE_CODE_OAUTH_TOKEN: "tok-1",
    INTERLOQ_GITHUB_TOKEN: "ghp_2",
    ANTHROPIC_API_KEY: "sk-3",
    X_PASSWORD: "p",
    PATH: "/usr/bin",
    EMPTY_SECRET: "  ",
    UNSET_TOKEN: undefined,
    DUPLICATE_TOKEN: "tok-1",
  };
  assert.deepEqual([...secretsOf(env)].sort(), ["ghp_2", "p", "sk-3", "tok-1"]);
});

test("a request with no facts kept has a null failure", () => {
  const line = failureLineOf({ session: null, purpose: "planning", callId: "claude-1", message: "boom tok", failure: null }, ["tok"]);
  assert.equal(line.failure, null);
  assert.equal(line.message, "boom [redacted]");
});

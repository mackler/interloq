import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { chooseOption, parseAskLine, parseExtraRounds, parseMessage } from "../src/input.ts";

// Row 6 of the table in recommendation E of docs/functional-design-review.md.
const RUNS = { numRuns: 200, seed: 20260925 };

test("property: only an entire in-range integer chooses an option; every other reply is free text", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 9 }), fc.integer({ min: 1, max: 20 }), fc.constantFrom("", " ", "  "), (count, n, pad) => {
      const chosen = chooseOption(`${pad}${n}${pad}`, count);
      assert.equal(chosen, n <= count ? n - 1 : null);
    }),
    RUNS,
  );
  fc.assert(
    fc.property(fc.string().filter((s) => !/^\s*[1-9][0-9]*\s*$/.test(s)), fc.integer({ min: 1, max: 9 }), (text, count) => assert.equal(chooseOption(text, count), null)),
    RUNS,
  );
  fc.assert(fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (n) => assert.equal(parseExtraRounds(` ${n} `), n)), RUNS);
  fc.assert(fc.property(fc.bigInt({ min: 2n ** 31n, max: 10n ** 25n }), (n) => assert.equal(parseExtraRounds(String(n)), null)), RUNS);
});

test("property: parseAskLine and parseMessage keep the text apart from the trimming and the two commands", () => {
  fc.assert(
    fc.property(fc.string(), (text) => {
      const line = parseAskLine(text);
      const trimmed = text.trim();
      assert.deepEqual(line, trimmed === "q" ? { kind: "quit" } : { kind: "answer", text: trimmed });
      const message = parseMessage(text);
      assert.deepEqual(message, trimmed === "/quit" ? { kind: "quit" } : { kind: "message", text: trimmed });
    }),
    RUNS,
  );
});


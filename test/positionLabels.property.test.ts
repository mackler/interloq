// Issue #159: properties of namesAgent (src/prompts.ts): a text of words that are no agent's name names none, and one
// with an agent's name inserted as a word, in any case, names one.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { AGENT_NAMES, namesAgent } from "../src/prompts.ts";

const RUNS = { numRuns: 200, seed: 20261029 };
const WORDS = ["keep", "the", "change", "file", "point", "review", "plan", "correction", "withdraw", "now", "codexes", "claudette", "(it)", "as-is"];
const words = fc.array(fc.constantFrom(...WORDS), { maxLength: 8 });
const anyCase = (s: string, flips: readonly boolean[]): string => [...s].map((c, i) => (flips[i % Math.max(flips.length, 1)] ? c.toUpperCase() : c.toLowerCase())).join("");

test("a text of words that are no agent's name names no agent", () => {
  fc.assert(fc.property(words, (ws) => !namesAgent(ws.join(" "))), RUNS);
});

test("an agent's name inserted as a word, in any case, is found", () => {
  fc.assert(
    fc.property(words, fc.nat(), fc.constantFrom(...AGENT_NAMES), fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), (ws, at, name, flips) => {
      const i = at % (ws.length + 1);
      const text = [...ws.slice(0, i), anyCase(name, flips), ...ws.slice(i)].join(" ");
      assert.equal(namesAgent(text), true, text);
    }),
    RUNS,
  );
});

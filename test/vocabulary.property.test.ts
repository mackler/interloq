import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { PROGRAM_WORDS, substitutesIn } from "../src/vocabulary.ts";

const substitutes = PROGRAM_WORDS.flatMap((w) => w.substitutes.map((s) => ({ s, names: w.names })));
/** The single-word substitutes: a phrase's last word stands alone after its inner space, so only a word is wholly inside another. */
const singleWords = substitutes.filter(({ s }) => !s.includes(" "));
/** Every single-word substitute, lowercased: a word the property builds may itself be one of them. */
const listedWords = new Set(singleWords.map(({ s }) => s.toLowerCase()));
/** A built word that is itself listed is reported as itself; any other is not reported. */
const reportedAsItself = (word: string): void => {
  if (listedWords.has(word.toLowerCase())) assert.deepEqual(substitutesIn(word).map((f) => f.found), [word]);
  else assert.deepEqual(substitutesIn(word), []);
};
const plainWord = fc.stringMatching(/^[a-z]{1,8}$/).filter((w) => substitutesIn(w).length === 0 && !/build|built/.test(w));
const words = fc.array(plainWord, { maxLength: 6 });

test("a substitute between plain words is reported, and its entry's name is not", () => {
  fc.assert(
    fc.property(words, words, fc.constantFrom(...substitutes), (before, after, { s, names }) => {
      const text = [...before, s, ...after].join(" ");
      assert.deepEqual(substitutesIn(text).map((f) => f.found), [s]);
      for (const name of names) assert.deepEqual(substitutesIn([...before, name, ...after].join(" ")), []);
    }),
  );
});

test("a substitute inside a longer word is never reported", () => {
  fc.assert(
    fc.property(fc.stringMatching(/^[a-z0-9]{1,3}$/), fc.stringMatching(/^[a-z0-9]{0,3}$/), fc.constantFrom(...singleWords), (pre, post, { s }) => {
      reportedAsItself(`${pre}${s}${post}`);
      reportedAsItself(`${s}${pre}`);
    }),
  );
});

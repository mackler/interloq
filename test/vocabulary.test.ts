import { test } from "node:test";
import assert from "node:assert/strict";
import { PROGRAM_WORDS, programWordsText, substitutesIn, type VocabularySource } from "../src/vocabulary.ts";
import { ITEM_STATES } from "../src/tracker.ts";
import { RUN_MODES } from "../src/runMode.ts";
import { phaseLabel } from "../src/prompts.ts";
import * as S from "../src/schema.ts";

const found = (text: string) => substitutesIn(text).map((s) => s.found);

test("substitutesIn finds a listed substitute as a whole word or phrase, longest first", () => {
  assert.deepEqual(found("the partly built work"), ["partly built"]);
  assert.deepEqual(found("Build the thing"), ["Build"]);
  assert.deepEqual(found("an item being  built, then built again"), ["being  built", "built"]);
  assert.deepEqual(found("rebuilt buildings by a builder"), []);
  assert.deepEqual(found("run npm-build_x and xbuild"), []);
  assert.deepEqual(substitutesIn("built")[0]?.names, ["implementing", "implemented"]);
});

const phaseNames = (): readonly string[] =>
  (["update", "questions", "planning", "execution", "work", "suite"] as const).flatMap((k) => [phaseLabel(k, 1, 1), phaseLabel(k, 2, 2)]);

const sourceNames = (source: VocabularySource): readonly string[] => {
  switch (source) {
    case "itemState":
      return ITEM_STATES;
    case "runMode":
      return RUN_MODES;
    case "phase":
      return phaseNames();
    case "executionStatus":
      return [...S.ExecReport.fields.status.literals, ...S.ExecOutcome.fields.status.literals];
    case "disposition":
      return S.Action.literals;
  }
};

test("every name of the table is a name of its source (the seam)", () => {
  for (const word of PROGRAM_WORDS) for (const name of word.names) assert.ok(sourceNames(word.source).includes(name), `${name} of ${word.source}`);
});

test("programWordsText names every name and every substitute of the table", () => {
  const text = programWordsText();
  for (const word of PROGRAM_WORDS) for (const w of [...word.names, ...word.substitutes]) assert.ok(text.includes(w), w);
});

test("a substitute followed by letters is reported only where the word is itself listed (suite run 3)", () => {
  assert.deepEqual(found("build" + "s"), ["builds"]);
  assert.deepEqual(found("build" + "er"), []);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { RUN_MODES, listedState, stateAtEnd, stateAtStart } from "../src/runMode.ts";
import { taskTextOf } from "../src/program.ts";
import { refinementOf, withRefinement } from "../src/refinement.ts";
import { ITEM_STATES, itemIdOf, type TrackerItem } from "../src/tracker.ts";

// Issue #120: the developer's decisions of 8 and 9 Oct 2026 on what each mode lists and which states it sets.
test("each mode lists its state and sets its states: refinement nothing at the start and refined at the end, implementation implementing and implemented", () => {
  assert.deepEqual(RUN_MODES.map(listedState), ["unrefined", "refined"]);
  assert.deepEqual(RUN_MODES.map(stateAtStart), [null, "implementing"]);
  assert.deepEqual(RUN_MODES.map(stateAtEnd), ["refined", "implemented"]);
  for (const s of [...RUN_MODES.map(listedState), ...RUN_MODES.map(stateAtEnd), "implementing"]) assert.ok((ITEM_STATES as readonly string[]).includes(s));
});

const id = Result.getOrThrow(itemIdOf("120"));
const section = Result.getOrThrow(refinementOf("The confirmed requirements."));
const developerText = "Make the page two tabs.";
const refinedBody = Result.getOrThrow(withRefinement(developerText, section));
const item = (body: string): TrackerItem => ({ id, title: "Two modes", body, state: "refined" });

test("taskTextOf: the title, a blank line and the body; a refinement run without the section, an implementation run with it", () => {
  assert.deepEqual(taskTextOf("refinement", item(refinedBody)), Result.succeed(`Two modes\n\n${developerText}`));
  assert.deepEqual(taskTextOf("implementation", item(refinedBody)), Result.succeed(`Two modes\n\n${refinedBody}`));
  assert.deepEqual(taskTextOf("refinement", item(developerText)), Result.succeed(`Two modes\n\n${developerText}`));
});

test("taskTextOf: a malformed section is SectionMalformed for a refinement run; a blank text is BlankTask", () => {
  const malformed = taskTextOf("refinement", item("## Refined using Interloq\nno closing line"));
  assert.ok(Result.isFailure(malformed) && malformed.failure._tag === "SectionMalformed");
  const blank = taskTextOf("implementation", { id, title: " ", body: " \n\t", state: "refined" });
  assert.ok(Result.isFailure(blank) && blank.failure._tag === "BlankTask");
});

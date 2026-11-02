// Issue #216 (S9, review P1-R4-1): the refinement's task from the developer's title and text; the implementation's unchanged.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Option, Result } from "effect";
import { refinementTask, taskTextOf } from "../src/program.ts";
import { itemTextOf, refinementOf, withRefinement } from "../src/refinement.ts";
import { itemIdOf, type TrackerItem } from "../src/tracker.ts";

const body = Result.getOrThrow(withRefinement("The developer's text.", Result.getOrThrow(refinementOf("the requirements"))));
const item: TrackerItem = { id: Result.getOrThrow(itemIdOf("5")), title: "Title", body, state: "refined", url: Option.none() };

test("an implementation item whose body holds a section gives a task that still contains the whole section", () => {
  assert.equal(Result.getOrThrow(taskTextOf("implementation", item, [])), `Title\n\n${body}`);
});

test("a refinement item's task is its title and text without the section, the same as refinementTask of its ItemText", () => {
  const task = Result.getOrThrow(taskTextOf("refinement", item, []));
  assert.equal(task, "Title\n\nThe developer's text.");
  assert.equal(Result.getOrThrow(refinementTask(Result.getOrThrow(itemTextOf("Title", "The developer's text.")), [])), task);
});

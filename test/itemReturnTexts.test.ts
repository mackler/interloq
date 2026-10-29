// Issue #192: the lines of an item's return name the item and the state the Implementation tab lists.
import assert from "node:assert/strict";
import { test } from "node:test";
import { itemNotReturnedLine, itemReturnedLine, writeCheckText } from "../src/prompts.ts";
import { listedState } from "../src/runMode.ts";

test("itemReturnedLine names the item and the state the Implementation tab lists", () => {
  const line = itemReturnedLine("185");
  assert.match(line, /\b185\b/);
  assert.ok(line.includes(listedState("implementation")));
});

test("itemNotReturnedLine names the item, the cause and, for a check, what the item held", () => {
  const unchecked = itemNotReturnedLine("185", "the tracker could not be reached", null);
  assert.match(unchecked, /\b185\b/);
  assert.ok(unchecked.includes("the tracker could not be reached"));
  assert.ok(unchecked.includes("implementing"));
  assert.ok(unchecked.includes(listedState("implementation")));
  const check = { kind: "held" as const, held: { kind: "state" as const, state: "implementing" as const } };
  const checked = itemNotReturnedLine("185", "boom", check);
  assert.ok(checked.includes(writeCheckText("185", check)));
  assert.ok(itemNotReturnedLine("185", "boom", { kind: "unchecked" }).includes(writeCheckText("185", { kind: "unchecked" })));
});

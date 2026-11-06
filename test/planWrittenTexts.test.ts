// Issue #27: the sentence the dashboard shows as Claude Code's latest message after a plan is written or revised
// (requirements G-R1-1): the verb, the stage as the run names it, and the label of the dashboard's heading.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { documentLabel, planWrittenBody } from "../src/prompts.ts";

test("the sentence of a plan written fresh names the stage and the Plan heading", () => {
  assert.equal(planWrittenBody(false, "Planning", documentLabel({ plan: 1 })), "Claude Code wrote the plan in Planning; open the Plan heading below to read it.");
});

test("the sentence of a plan revised says revised", () => {
  assert.equal(planWrittenBody(true, "Planning 2", documentLabel({ plan: 2 })), "Claude Code revised the plan in Planning 2; open the Plan heading below to read it.");
});

test("the verb stands at its fixed position and the label at the end, whatever the stage and label say", () => {
  fc.assert(fc.property(fc.boolean(), fc.string(), fc.string(), (revised, stage, label) => {
    const text = planWrittenBody(revised, stage, label);
    assert.ok(text.startsWith(`Claude Code ${revised ? "revised" : "wrote"} the plan in ${stage}; `));
    assert.ok(text.endsWith(`open the ${label} heading below to read it.`));
  }));
});

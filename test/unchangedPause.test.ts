import assert from "node:assert/strict";
import { test } from "node:test";
import { DECIDE, parseUnchangedAnswer } from "../src/input.ts";
import { unchangedOptions } from "../src/offer.ts";
import * as prompts from "../src/prompts.ts";
import { promptOf } from "../src/userPrompts.ts";

// Issue #30 (plan step S12): the pause after a corrective turn that left the file unchanged. The page's buttons, the
// parser of src/input.ts and decision support's options must agree; each seam is asserted from one source.
const intended = { [prompts.UNCHANGED_RETRY]: "retry", [prompts.UNCHANGED_PROCEED]: "proceed", [prompts.UNCHANGED_STOP]: "stop" } as const;

for (const interview of [false, true]) {
  // S8: the pause's options are its cards, each sending the answer it shows; the widget adds only the offer and the quit.
  test(`every option of the pause sends the answer its label names, and exactly one option matches it (${interview ? "requirements" : "corrective"})`, () => {
    const widget = promptOf(prompts.withOffer(prompts.unchangedPrompt));
    assert.equal(widget.kind, "unchanged");
    assert.deepEqual(widget.choices.filter((c) => c.sends !== "q" && c.sends !== DECIDE), []);
    assert.ok(widget.choices.some((c) => c.label === prompts.HELP_ME_DECIDE && c.sends === DECIDE), "the pause carries no offer");
    const options = unchangedOptions(interview);
    assert.deepEqual(options.map((o) => o.label), [prompts.UNCHANGED_RETRY, prompts.UNCHANGED_PROCEED, prompts.UNCHANGED_STOP]);
    for (const option of options) {
      const sends = "token" in option.answer ? option.answer.token : "";
      assert.equal(parseUnchangedAnswer(sends), intended[option.label as keyof typeof intended]);
      assert.deepEqual(options.filter((o) => o.matches(sends)).map((o) => o.label), [option.label]);
    }
  });
}

test("a blank or unknown answer at the pause is no answer, so it is asked again", () => {
  for (const answer of ["", "  ", "x", "2", "yes"]) assert.equal(parseUnchangedAnswer(answer), null, answer);
  assert.equal(parseUnchangedAnswer(" R "), "retry");
});

test("the requirements' Retry is another interview; the others' is another corrective turn", () => {
  assert.notEqual(unchangedOptions(true)[0]!.description, unchangedOptions(false)[0]!.description);
  assert.match(unchangedOptions(true)[0]!.description, /interview/);
  assert.match(unchangedOptions(false)[0]!.description, /corrective turn/);
});

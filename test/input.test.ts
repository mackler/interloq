import assert from "node:assert/strict";
import { test } from "node:test";
import { answerOf, isDecide, parseInterviewMessage } from "../src/input.ts";

// Plan step 3.4 (finding 25): the interview's commands as pure functions.

test("parseInterviewMessage: empty, /done, or text (trimmed)", () => {
  assert.deepEqual(parseInterviewMessage(""), { kind: "empty" });
  assert.deepEqual(parseInterviewMessage("   "), { kind: "empty" });
  assert.deepEqual(parseInterviewMessage("/done"), { kind: "done" });
  assert.deepEqual(parseInterviewMessage(" /done "), { kind: "done" });
  assert.deepEqual(parseInterviewMessage("  use the logger  "), { kind: "text", text: "use the logger" });
  assert.deepEqual(parseInterviewMessage("/quit"), { kind: "text", text: "/quit" }); // quitting is the Ui's command
});

// Decision support, plan step 3.1: the command of the offer.
test("isDecide recognizes /decide with surrounding white space only", () => {
  assert.equal(isDecide("/decide"), true);
  assert.equal(isDecide("  /decide \n"), true);
  assert.equal(isDecide("/decide now"), false);
  assert.equal(isDecide("decide"), false);
  assert.equal(isDecide("/Decide"), false);
});

test("answerOf: a number chooses an option and yields its label and description; anything else is the reply", () => {
  const options = [{ label: "Keep", description: "the planner's position" }, { label: "Change", description: "" }];
  assert.equal(answerOf("1", options), "Keep: the planner's position");
  assert.equal(answerOf(" 2 ", options), "Change");
  assert.equal(answerOf("3", options), "3");
  assert.equal(answerOf("keep it as it is", options), "keep it as it is");
  assert.equal(answerOf("", options), "");
});

// S24 (issue #25, Q11, P2-R1-1): the answers that end the run, which the terminal and the page confirm.
test("endingOf: q at an ask and /quit at a message end the run; at the cycle limit every answer but p or a count stops it", async () => {
  const { endingOf, endsRun, limitStops, parseConfirmEnd } = await import("../src/input.ts");
  assert.equal(endingOf("decision", "ask", "q"), "endRun");
  assert.equal(endingOf("decision", "ask", " q "), "endRun");
  assert.equal(endingOf("decision", "ask", "/quit"), null);
  assert.equal(endingOf("interviewMessage", "message", "/quit"), "endRun");
  assert.equal(endingOf("interviewMessage", "message", "q"), null);
  assert.equal(endingOf("decision", "ask", "0"), null);
  assert.equal(endingOf("decision", "ask", ""), null);
  for (const text of ["0", "", "stop", "-1", "x", "1.5"]) {
    assert.equal(endingOf("limit", "ask", text), "limitStop", text);
    assert.equal(endingOf("limitNoProceed", "ask", text), "limitStop", text);
  }
  assert.equal(endingOf("limitNoProceed", "ask", "p"), "limitStop");
  for (const text of ["p", "3", "/decide"]) assert.equal(endingOf("limit", "ask", text), null, text);
  assert.equal(endingOf("limit", "ask", "q"), "endRun");
  assert.equal(endsRun("limit", "ask", ""), true);
  assert.equal(limitStops("p", true), false);
  assert.equal(limitStops("p", false), true);
  assert.equal(parseConfirmEnd("y"), true);
  assert.equal(parseConfirmEnd(" Y "), true);
  for (const text of ["", "n", "yes please", "q"]) assert.equal(parseConfirmEnd(text), false, text);
});

test("the Stop option of the cycle limit matches exactly the answers limitStops names (the seam)", async () => {
  const fc = (await import("fast-check")).default;
  const { limitStops } = await import("../src/input.ts");
  const { limitOptions } = await import("../src/offer.ts");
  const prompts = await import("../src/prompts.ts");
  for (const proceed of [prompts.PROCEED_TO_IMPLEMENTATION, null]) {
    const stop = limitOptions(proceed).find((o) => o.label === prompts.LIMIT_STOP);
    assert.ok(stop !== undefined);
    const agree = (text: string) => stop.matches(text) === limitStops(text, proceed !== null);
    for (const text of ["0", "", "stop", "-1", "x", "p", "3", " 3 "]) assert.ok(agree(text), text);
    fc.assert(fc.property(fc.string(), (text) => text.trim() === "/decide" || agree(text)));
  }
});

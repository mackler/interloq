// Issue #216 (S8): the scripted reviewer answers the phase's checks from a queue of their own, nothing where none is queued.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { UPDATE_MARKER } from "../src/prompts.ts";
import { issue, pathsOf, ScriptedReviewer, tempRepo } from "./helpers.ts";

const turn = (reviewer: ScriptedReviewer, prompt: string) => Effect.runPromise(Effect.flatMap(reviewer.startPhase, (s) => s.review(prompt, undefined as never))).then((r) => JSON.parse(r.text).issues.map((i: { id: string }) => i.id));

test("a check with no queued answer raises nothing and leaves the ordinary reviews untouched; a queued check is returned in order", async () => {
  const reviewer = new ScriptedReviewer(pathsOf(tempRepo()), [{ issues: [issue("Q-R1-1")] }]);
  assert.deepEqual(await turn(reviewer, `${UPDATE_MARKER} check`), []);
  assert.deepEqual(await turn(reviewer, "review the question list"), ["Q-R1-1"]);
  reviewer.updateChecks = [{ issues: [issue("U-R1-1")] }, { issues: [issue("U-R2-1")] }];
  assert.deepEqual(await turn(reviewer, `${UPDATE_MARKER} 1`), ["U-R1-1"]);
  assert.deepEqual(await turn(reviewer, `${UPDATE_MARKER} 2`), ["U-R2-1"]);
});

// Issue #216 (S9, review P1-R3-1): the Decider's withTask replaces the task its analysis call and context call are
// given, and keeps the phase `at` bound, in either order.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { makeDecider } from "../src/decision.ts";
import { plainPieces } from "../src/pieces.ts";
import { Store } from "../src/services.ts";
import { DECISION_FORMAT_TEXT, tempRepo, testLayer } from "./helpers.ts";

const request = { origin: { kind: "permission", tool: "Bash" }, decision: null, question: plainPieces("Allow?"), options: [], details: [], explanations: [], facts: "", fallback: [], history: [] } as never;

test("withTask replaces the task in the context call's prompt and in the analysis prompt, and keeps the phase", async () => {
  const { layer, probe } = testLayer(tempRepo(), { contexts: [{ output: { context: [], history: [], question: [], options: [], details: [], explanations: [] } }, { output: { context: [], history: [], question: [], options: [], details: [], explanations: [] } }] });
  await Effect.runPromiseExit(
    Effect.gen(function* () {
      yield* (yield* Store).init("OLD TASK");
      const decider = yield* makeDecider("OLD TASK", DECISION_FORMAT_TEXT);
      yield* Effect.exit(decider.withTask("NEW TASK").at({ kind: "planning", n: 1 }, "Planning").explain(request));
      yield* Effect.exit(decider.at({ kind: "planning", n: 1 }, "Planning").withTask("NEWER TASK").explain(request));
      yield* Effect.exit(decider.withTask("NEW TASK").at({ kind: "update" }, "Bring Up to Date").decide({ question: "Which?", options: [{ label: "A", description: "" }, { label: "B", description: "" }] }));
    }).pipe(Effect.provide(layer)),
  );
  assert.ok(probe.planner.contextPrompts[0]?.includes("NEW TASK") && !probe.planner.contextPrompts[0]?.includes("OLD TASK"), probe.planner.contextPrompts[0]);
  assert.ok(probe.planner.contextPrompts.some((p) => p.includes("NEWER TASK")), "at then withTask");
  assert.ok(probe.planner.contextPrompts.every((p) => !p.includes("OLD TASK")));
  const analysis = probe.planner.prompts.find((p) => p.includes("Which?"));
  assert.ok(analysis?.includes("NEW TASK") && !analysis.includes("OLD TASK"), analysis);
  assert.ok(analysis?.includes("Bring Up to Date"), "the phase bound by at");
});

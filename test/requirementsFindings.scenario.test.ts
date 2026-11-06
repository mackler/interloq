// Issue #47: each accepted finding of the requirements review is handled by what it is: one the developer already
// answered is written into requirements.md and not asked; a correction is written with no question; an unresolved one,
// or a reopened one with what changed, is asked in the follow-up clarification.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import * as prompts from "../src/prompts.ts";
import type * as S from "../src/schema.ts";
import type { ShownDocument } from "../src/reviewedDocument.ts";
import { Effect } from "effect";
import { program } from "../src/program.ts";
import { fakeTrackerOf, haltConversationOf, haltReasonOf, issue, questionEntry, requirementsRespond, runRefinement, type ScriptedUi, scriptedItem, scriptedStart, summaryReply, tempRepo, testLayer, testWiring, userQuestion } from "./helpers.ts";

const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), "utf8");
const q = (id: string): S.QuestionEntry => questionEntry(id, `question ${id}?`, [["A", "a"], ["B", "b"]], { context: "c", reason: "the codebase does not determine it", default_answer: "A" });
const none = { id: "", context: [], history: [], text: [], explanations: [], options: [] };
const turn = (message: string, answered: string[], summary = ""): S.ClarificationTurn => ({ message_to_user: message, current_question: none, asked_ids: answered, answered_ids: answered, complete: summary !== "", summary });
const closing = [{ output: summaryReply("Q1: A", "Complete.") }];
const followUpsOpened = (ui: ScriptedUi): number => ui.notified.filter((e) => e._tag === "ClarificationOpened" && e.stage === "followUp").length;
const gapsPrompt = (prompts_: readonly string[]): string | undefined => prompts_.find((p) => p.includes("You classified these accepted issues as needing the user"));
const shownRequirements = (ui: ScriptedUi): string[] => ui.notified.flatMap((e) => (e._tag === "DocumentShown" && e.subject === "requirements" && e.document._tag === "Markdown" ? [(e.document as Extract<ShownDocument, { _tag: "Markdown" }>).text] : []));
const retryQuestion = userQuestion("How many retries do you want?", [["Three retries", "three"], ["Five retries", "five"]]);

test("an answer given during the review that is missing from the requirements is written in, and nothing is asked again", async () => {
  const answered: S.RequirementFinding = { id: "G-R2-1", kind: "answered", source: "user-decisions.md: Three retries" };
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["A", "1"],
    closings: closing,
    steps: [
      { output: { questions: [q("Q1")] } },
      { output: requirementsRespond([["G-R1-1", "no_change_needed"]], [], null, { questions_for_user: [retryQuestion] }) },
      { output: { requirements: null } }, // the application of decisions leaves the document without the answer, as on 28 Sep 2026
      { output: requirementsRespond([["G-R2-1", "accepted"]], [answered], "Q1: A\nRetries: 3") },
    ],
    reviews: [{ issues: [] }, { issues: [issue("G-R1-1", "retry count?")] }, { issues: [issue("G-R2-1", "the retry decision is absent")] }, { issues: [] }],
  });
  await runRefinement(layer);
  assert.match(read(probe.dir, "user-decisions.md"), /Three retries/);
  assert.equal(probe.ui.asked.length, 2, probe.ui.asked.join("\n---\n"));
  assert.equal(followUpsOpened(probe.ui), 0);
  assert.equal(read(probe.dir, "requirements.md"), "Q1: A\nRetries: 3\n");
  const line = prompts.requirementsFindingLine(answered);
  assert.ok(read(probe.dir, "conversation.md").includes(line));
  assert.ok(probe.ui.said.some((s) => s.includes(line)));
  assert.equal(probe.reviewer.prompts.filter((p) => p.includes("requirements.md")).length, 3);
});

test("the application of decisions writes the document it returns", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["A", "1"],
    closings: closing,
    steps: [
      { output: { questions: [q("Q1")] } },
      { output: requirementsRespond([["G-R1-1", "no_change_needed"]], [], null, { questions_for_user: [retryQuestion] }) },
      { output: { requirements: "Q1: A\nRetries: 3" } },
    ],
    reviews: [{ issues: [] }, { issues: [issue("G-R1-1", "retry count?")] }, { issues: [] }],
  });
  await runRefinement(layer);
  assert.equal(read(probe.dir, "requirements.md"), "Q1: A\nRetries: 3\n");
  assert.equal(followUpsOpened(probe.ui), 0);
});

test("an unresolved finding is asked in the follow-up clarification", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["A", "retries: 3"],
    closings: closing,
    steps: [
      { output: { questions: [q("Q1")] } },
      { output: requirementsRespond([["G-R1-1", "accepted"]], [{ id: "G-R1-1", kind: "unresolved" }], null) },
      { output: turn("How many retries?", []) },
      { output: turn("Complete.", ["G-R1-1"], "Q1: A\nRetries: 3") },
    ],
    reviews: [{ issues: [] }, { issues: [issue("G-R1-1", "retry count absent")] }, { issues: [] }],
  });
  await runRefinement(layer);
  const opening = gapsPrompt(probe.planner.prompts);
  assert.ok(opening !== undefined, "no follow-up clarification was opened");
  assert.ok(opening.includes("- G-R1-1"));
  assert.ok(!opening.includes("Treat each accepted issue as an agreed question"));
  assert.equal(followUpsOpened(probe.ui), 1);
  assert.equal(read(probe.dir, "requirements.md"), "Q1: A\nRetries: 3\n");
});

test("a reopened finding is asked again, the opening stating what changed", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["A", "retries: 5"],
    closings: closing,
    steps: [
      { output: { questions: [q("Q1")] } },
      { output: requirementsRespond([["G-R1-1", "accepted"]], [{ id: "G-R1-1", kind: "reopened", changed: "the retry setting was removed" }], null) },
      { output: turn("How many retries now?", []) },
      { output: turn("Complete.", ["G-R1-1"], "Q1: A\nRetries: 5") },
    ],
    reviews: [{ issues: [] }, { issues: [issue("G-R1-1", "the retry setting is gone")] }, { issues: [] }],
  });
  await runRefinement(layer);
  const opening = gapsPrompt(probe.planner.prompts);
  assert.ok(opening !== undefined);
  assert.ok(opening.includes("the retry setting was removed"));
  assert.match(opening, /state in the question's history what changed/);
  assert.equal(read(probe.dir, "requirements.md"), "Q1: A\nRetries: 5\n");
});

test("every finding a correction: the requirements are revised and reviewed again with no clarification", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["A"],
    closings: closing,
    steps: [
      { output: { questions: [q("Q1")] } },
      {
        output: requirementsRespond(
          [["G-R1-1", "accepted"], ["G-R1-2", "partially_accepted"]],
          [{ id: "G-R1-1", kind: "answered", source: "conversation.md: A" }, { id: "G-R1-2", kind: "corrected" }],
          "Q1: A, as the user answered\nNo contradiction.",
        ),
      },
    ],
    reviews: [{ issues: [] }, { issues: [issue("G-R1-1", "Q1's reason absent"), issue("G-R1-2", "a contradiction")] }, { issues: [] }],
  });
  await runRefinement(layer);
  assert.equal(followUpsOpened(probe.ui), 0);
  assert.equal(gapsPrompt(probe.planner.prompts), undefined);
  assert.equal(read(probe.dir, "requirements.md"), "Q1: A, as the user answered\nNo contradiction.\n");
  assert.equal(probe.ui.asked.length, 1);
  assert.equal(probe.reviewer.prompts.filter((p) => p.includes("requirements.md")).length, 2);
});

test("an answered and an unresolved finding: the document is written before the clarification, which asks the unresolved one alone", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["A", "retries: 3"],
    closings: closing,
    steps: [
      { output: { questions: [q("Q1")] } },
      { output: requirementsRespond([["G-R1-1", "accepted"], ["G-R1-2", "accepted"]], [{ id: "G-R1-1", kind: "answered", source: "conversation.md: A" }, { id: "G-R1-2", kind: "unresolved" }], "Q1: A\nX: yes") },
      { output: turn("How many retries?", []) },
      { output: turn("Complete.", ["G-R1-2"], "Q1: A\nX: yes\nRetries: 3") },
    ],
    reviews: [{ issues: [] }, { issues: [issue("G-R1-1", "X?"), issue("G-R1-2", "retries?")] }, { issues: [] }],
  });
  await runRefinement(layer);
  const opening = gapsPrompt(probe.planner.prompts);
  assert.ok(opening !== undefined);
  assert.ok(opening.includes("- G-R1-2") && !opening.includes("- G-R1-1"));
  const shown = shownRequirements(probe.ui);
  assert.ok(shown.includes("Q1: A\nX: yes\n"), JSON.stringify(shown));
  assert.ok(shown.indexOf("Q1: A\nX: yes\n") < shown.indexOf("Q1: A\nX: yes\nRetries: 3\n"));
  assert.equal(read(probe.dir, "requirements.md"), "Q1: A\nX: yes\nRetries: 3\n");
});

test("a classification missing an accepted id gets the validation repair turn, and a second failure halts", async () => {
  const missing = prompts.findingProblemText({ kind: "missing", id: "G-R1-1" });
  const repaired = testLayer(tempRepo(), {
    answers: ["A"],
    closings: closing,
    steps: [
      { output: { questions: [q("Q1")] } },
      { output: requirementsRespond([["G-R1-1", "accepted"]], [], "Q1: A\nFixed.") },
      { output: requirementsRespond([["G-R1-1", "accepted"]], [{ id: "G-R1-1", kind: "corrected" }], "Q1: A\nFixed.") },
    ],
    reviews: [{ issues: [] }, { issues: [issue("G-R1-1", "a contradiction")] }, { issues: [] }],
  });
  await runRefinement(repaired.layer);
  assert.ok(repaired.probe.planner.prompts.some((p) => p.includes(missing)), "no repair turn named the missing finding");
  assert.equal(read(repaired.probe.dir, "requirements.md"), "Q1: A\nFixed.\n");

  // W1-R1-2: the second failure is carried through program, the one place a typed error of the run becomes exit code 1
  // and its record is written in conversation.md (issue #193).
  const { wiring, probe } = testWiring(tempRepo(), {
    answers: ["A"],
    closings: closing,
    steps: [
      { output: { questions: [q("Q1")] } },
      { output: requirementsRespond([["G-R1-1", "accepted"]], [], "Q1: A\nFixed.") },
      { output: requirementsRespond([["G-R1-1", "accepted"]], [], "Q1: A\nFixed.") },
    ],
    reviews: [{ issues: [] }, { issues: [issue("G-R1-1", "a contradiction")] }, { issues: [] }],
    tracker: fakeTrackerOf([{ ...scriptedItem, state: "unrefined" }]),
    mode: "refinement",
  });
  const code = await Effect.runPromise(Effect.scoped(program(scriptedStart(probe.project, "refinement"), wiring)));
  assert.equal(code, 1);
  const said = probe.ui.said.join("\n");
  const reason = haltReasonOf(said);
  assert.ok(reason !== null, `no halt said: ${said}`);
  assert.ok(reason.includes(missing), reason);
  assert.ok(haltConversationOf(said).endsWith(prompts.haltRecord(reason)));
  assert.ok(read(probe.dir, "conversation.md").endsWith(prompts.haltRecord(reason)), read(probe.dir, "conversation.md").slice(-600));
});

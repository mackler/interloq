// Issue #86: the document under review of every review loop reaches the page (DocumentShown) before Codex's first review
// of it, and again whenever the loop changes it; documents written outside a loop (unchecked terms, the requirements of
// an empty list) are notified when written.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { SubjectId } from "../src/artifacts.ts";
import { subjectDir } from "../src/artifacts.ts";
import { renderQuestions, renderTerms } from "../src/render.ts";
import { Result } from "effect";
import type { ShownDocument } from "../src/reviewedDocument.ts";
import type * as S from "../src/schema.ts";
import type { UiEvent } from "../src/uiEvents.ts";
import { finished, issue, questionEntry, respond, runRefinement, runTask, type ScriptedUi, summaryReply, tempRepo, testLayer } from "./helpers.ts";

const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), "utf8");
const q = (id: string): S.QuestionEntry => questionEntry(id, `question ${id}?`, [["A", "a"], ["B", "b"]], { context: "c", reason: "the codebase does not determine it", default_answer: "A" });
/** An agreed question as the terms' call returns it, with no term to explain. */
const termsOf = (e: S.QuestionEntry): S.TermsEntry => ({ id: e.id, explanations: [], context: e.context, history: e.history, question: e.question, reason: e.reason, proposed_answers: e.proposed_answers.map((a) => ({ label: a.label, description: a.description })) });
const closing = (summary: string) => [{ output: summaryReply(summary, "Complete.") }];
const noQuestions = { questions_for_user: [] };

const same = (a: SubjectId, b: SubjectId): boolean => subjectDir(a) === subjectDir(b);
/** The documents shown of a subject, in order. */
const shownOf = (ui: ScriptedUi, subject: SubjectId): readonly ShownDocument[] => ui.notified.flatMap((e) => (e._tag === "DocumentShown" && same(e.subject, subject) ? [e.document] : []));
const textOf = (d: ShownDocument | undefined): string => (d === undefined || d._tag === "Analysis" ? assert.fail(`not a text document: ${JSON.stringify(d)}`) : d.text);
const indexOf = (ui: ScriptedUi, found: (e: UiEvent) => boolean): number => ui.notified.findIndex(found);
/** The first DocumentShown of a subject comes before the first review of its loop. */
const shownBeforeReview = (ui: ScriptedUi, subject: SubjectId): void => {
  const shown = indexOf(ui, (e) => e._tag === "DocumentShown" && same(e.subject, subject));
  const reviewed = indexOf(ui, (e) => e._tag === "ReviewReceived" && same(e.subject, subject));
  assert.ok(shown !== -1, `no document of ${subjectDir(subject)} was shown`);
  assert.ok(reviewed === -1 || shown < reviewed, `the document of ${subjectDir(subject)} was shown after its first review`);
};

test("a refinement shows the question list before its review, the amended list after it, the terms, and the requirements before and after the second interview", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1", "B", "retries: 3"],
    steps: [
      { output: { questions: [q("Q1")] } },
      { output: { ...respond([["Q-R1-1", "accepted"]]), questions: [q("Q1"), q("Q2")] } },
      { output: respond([["G-R1-1", "accepted"]]) },
      { output: { message_to_user: "How many retries?", current_question: { id: "", context: [], history: [], text: [], explanations: [], options: [] }, asked_ids: [], answered_ids: [], complete: false, summary: "" } },
      { output: { message_to_user: "Complete.", current_question: { id: "", context: [], history: [], text: [], explanations: [], options: [] }, asked_ids: ["G-R1-1"], answered_ids: ["G-R1-1"], complete: true, summary: "Q1: A\nRetries: 3" } },
    ],
    closings: closing("Q1: A"),
    terms: [{ output: { entries: [termsOf(q("Q1")), termsOf(q("Q2"))] } }],
    termsReviews: [{ issues: [] }],
    reviews: [{ issues: [issue("Q-R1-1", "Q2 is missing")] }, { issues: [] }, { issues: [issue("G-R1-1", "retry count absent")] }, { issues: [] }],
  });
  await runRefinement(layer);

  shownBeforeReview(probe.ui, "questions");
  const lists = shownOf(probe.ui, "questions");
  assert.deepEqual(lists.map((d) => d._tag), ["Markdown", "Markdown"]);
  assert.equal(textOf(lists[0]), renderQuestions({ questions: [q("Q1")] }));
  assert.equal(textOf(lists[1]), renderQuestions({ questions: [q("Q1"), q("Q2")] }));

  shownBeforeReview(probe.ui, "terms");
  assert.equal(shownOf(probe.ui, "terms").length, 1);
  assert.equal(textOf(shownOf(probe.ui, "terms")[0]), Result.getOrThrow(renderTerms([termsOf(q("Q1")), termsOf(q("Q2"))])));

  shownBeforeReview(probe.ui, "requirements");
  const requirements = shownOf(probe.ui, "requirements").map(textOf);
  assert.equal(requirements[0], "Q1: A\n");
  assert.equal(requirements.at(-1), read(probe.dir, "requirements.md"));
  assert.equal(requirements.at(-1), "Q1: A\nRetries: 3\n");
});

test("unchecked terms are shown once, when written, with no review", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1"],
    steps: [{ output: { questions: [q("Q1")] } }],
    closings: closing("Q1: A"),
    terms: [{ output: { entries: [termsOf(q("Q1"))] } }],
    reviews: [{ issues: [] }, { issues: [] }],
  });
  await runRefinement(layer, "task", "unchecked");
  assert.equal(shownOf(probe.ui, "terms").length, 1);
  assert.equal(textOf(shownOf(probe.ui, "terms")[0]), Result.getOrThrow(renderTerms([termsOf(q("Q1"))])));
});

test("an empty agreed list shows the requirements it writes", async () => {
  const { layer, probe } = testLayer(tempRepo(), { answers: [], steps: [{ output: { questions: [] } }], reviews: [{ issues: [] }] });
  await runRefinement(layer);
  const requirements = shownOf(probe.ui, "requirements");
  assert.equal(requirements.length, 1);
  assert.equal(textOf(requirements[0]), read(probe.dir, "requirements.md"));
});

test("an implementation run shows plan.md before its review and the amended plan after the response, and the whole diff once across two rounds of an unchanged diff", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" },
      { output: respond([["W1-R1-1", "rejected"]]) },
    ],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(layer);
  shownBeforeReview(probe.ui, { plan: 1 });
  const plans = shownOf(probe.ui, { plan: 1 }).map(textOf);
  assert.equal(plans.length, 2);
  assert.match(plans[0], /v1/);
  assert.match(plans[1], /v2/);
  assert.equal(plans[1], read(probe.dir, "plan.md"));

  shownBeforeReview(probe.ui, { work: 1 });
  const diffs = shownOf(probe.ui, { work: 1 });
  assert.equal(diffs.length, 1, "an unchanged diff was shown again");
  assert.equal(diffs[0]._tag, "Diff");
  assert.equal(textOf(diffs[0]), read(probe.dir, "work-review-1/changes.diff"));
  assert.match(textOf(diffs[0]), /\+implemented/);
});

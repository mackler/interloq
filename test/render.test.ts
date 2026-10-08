import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { interviewSays, recordHeading, renderTerms, termItem, renderDecision, renderResponse, renderReview, renderFeedback, renderQuestions, renderRound, subjectHeading } from "../src/render.ts";
import { issue, para, plain, questionEntry, readTerms, respond, senseRead, shownOf, term } from "./helpers.ts";
import { blocksMarkdown, piecesText } from "../src/pieces.ts";
import type { PresentedQuestion } from "../src/question.ts";
import type { LogEntry } from "../src/schema.ts";
import * as prompts from "../src/prompts.ts";

// Finding 27 / recommendation D: the Store writes; the text of the records is composed here.
test("subject headings", () => {
  assert.deepEqual([subjectHeading("questions"), subjectHeading("requirements"), subjectHeading({ plan: 3 })], ["Question review", "Requirements review", "Planning phase 3"]);
});

test("renderRound lists the issues, the dispositions with their references, the self-corrections and the feedback", () => {
  const review = { issues: [issue("A"), issue("B")] };
  const base = respond([["A", "accepted"], ["B", "rejected"]]);
  const response = {
    ...base,
    dispositions: base.dispositions.map((d) => (d.id === "B" ? { ...d, duplicate_of: "A" } : d)),
    self_corrections: [{ id: "C", new_action: "plan_error" as const, explanation: "oops" }],
    reviewer_feedback: "be brief",
  };
  const text = renderRound("Planning phase 1", 2, review, response);
  assert.match(text, /^## Planning phase 1, round 2\n\n### Codex\n\n- \*\*\[A\]\*\* /);
  assert.match(text, /### Claude Code\n\n- \*\*\[A\]\*\* accepted: rationale A\n- \*\*\[B\]\*\* rejected \(duplicate of A\): rationale B\n- \*\*Self-correction\*\* \(plan_error, issue "C"\): oops\n- \*\*Feedback to the reviewer:\*\* be brief\n\n$/);
});

test("renderDecision gives the record line and the conversation line of one decision event", () => {
  const lines = renderDecision({ subject: "issue A, raised again", id: null, decision: "keep it", phase: 1, round: 2 });
  assert.equal(lines.record, "Subject: issue A, raised again\nDecision: keep it\n\n");
  assert.equal(lines.conversation, "**User decision** on issue A, raised again: keep it\n\n");
});

test("renderFeedback and renderQuestions", () => {
  assert.equal(renderFeedback("Planning phase 1", 2, "too strict"), "## Planning phase 1, round 2\ntoo strict\n\n");
  assert.equal(renderQuestions({ questions: [] }), "The list is empty.\n");
  const list = { questions: [questionEntry("Q1", "A or B?", [["A", "a"], ["B", "b"]], { default_answer: "B" })] };
  assert.equal(renderQuestions(list), "- **[Q1]** A or B?\n  Reason: r\n  - A: a\n  - B: b (default)\n");
  assert.match(renderQuestions({ questions: [{ ...list.questions[0], default_answer: null }] }), /- B: b\n$/);
});

// Plan step 1.5: the lines said for an interview turn, shared with the page's reducer (4.2).
test("interviewSays gives the lines of a continuing turn and of a proposed summary", () => {
  assert.deepEqual(interviewSays({ kind: "continuing", message: "Hello" }), ["\nHello\n"]);
  assert.deepEqual(interviewSays({ kind: "summary_proposed", message: "Done.", summary: "# R" }), ["\nDone.\n", "Summary proposed by Claude Code:\n\n# R\n"]);
});

// Plan step 1.6: the page shows the two halves of a round as two messages; conversation.md keeps the whole.
test("renderRound is the heading followed by renderReview and renderResponse", () => {
  const review = { issues: [issue("A"), issue("B")] };
  const response = respond([["A", "accepted"], ["B", "rejected"]], { reviewer_feedback: "thanks" });
  assert.equal(renderRound("Planning phase 1", 2, review, response), "## Planning phase 1, round 2\n\n" + renderReview(review) + renderResponse(response));
  assert.match(renderReview(review), /^### Codex\n\n- \*\*\[A\]\*\*/);
  assert.match(renderResponse(response), /^### Claude Code\n\n- \*\*\[A\]\*\* accepted/);
});

test("the heading of a work review", () => {
  assert.equal(subjectHeading({ work: 2 }), "Work review 2");
});

// The records keep their headings when the user-facing name becomes "clarification" (issue #21, Q5 follow-up).
test("conversation.md's headings of the interviews are unchanged", () => {
  assert.equal(recordHeading("clarification"), "Interview");
  assert.equal(recordHeading("followUp"), "Second interview");
});

// S8: every question is recorded in the one shape, in conversation.md: heading with its number, the line saying where it
// came from, the context set apart, what the question is about, the terms, the question itself, the options.
test("renderQuestionRecord writes the heading, the origin, the context, the details, the terms, the question and the options, in that order", async () => {
  const { renderQuestionRecord } = await import("../src/render.ts");
  const q: PresentedQuestion = {
    number: 4,
    origin: { kind: "relayed" },
    context: { blocks: para("Claude Code, the coding agent, is writing the tool's input check."), by: "agent" },
    explanations: [shownOf({ id: "z", term: "zod", senses: ["a library that checks the shape of data"] })],
    question: [...plain("Should "), term("Zod's package", "z"), ...plain(" be declared as a dependency?")],
    options: [
      { label: plain("Declare it"), description: plain("add it to package.json"), answer: { token: "1" } },
      { label: plain("More cycles"), description: [], answer: { numeric: true } },
    ],
    details: para("Codex says: the migration is missing."),
    decision: null,
  };
  const record = renderQuestionRecord(q);
  const at = (text: string) => record.indexOf(text);
  const order = [prompts.questionTitle(4), prompts.originLine(q.origin, null).slice(0, 30), "is writing the tool's input check", "Codex says", prompts.TERMS_HEADING, "zod: a library", "Should Zod's package be declared as a dependency?", "Declare it", "add it to package.json", "More cycles"].map(at);
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), JSON.stringify({ order, record }));
  // S11 (issue #36): the Terms line is labeled with the explanation's term, not with the words of the piece.
  assert.ok(!record.includes("Zod's package:"), record);
  // A context the program wrote is marked as the program's.
  assert.ok(renderQuestionRecord({ ...q, context: { blocks: para("x"), by: "program" } }).includes(prompts.CONTEXT_BY_PROGRAM));
  assert.ok(!record.includes(prompts.CONTEXT_BY_PROGRAM));
});

test("a question inside a decision says in its origin line that it belongs to that decision and why it is asked (issue #57)", () => {
  const line = prompts.originLine({ kind: "planner", heading: "Decision 2" }, 2);
  assert.match(line, /Decision 2/);
  assert.match(line, new RegExp(prompts.HELP_ME_DECIDE));
  assert.match(line, /undetermined/);
  assert.doesNotMatch(prompts.originLine({ kind: "planner", heading: "Planning 1" }, null), /belongs to Decision/);
});

test("conversation.md records a question under its displayed number with the record's id beside it (S6)", async () => {
  const { renderQuestionRecord } = await import("../src/render.ts");
  const q: PresentedQuestion = { number: 3, origin: { kind: "clarification", id: "Q1" }, context: { blocks: para("c"), by: "agent" }, explanations: [], question: plain("Which?"), options: [], details: [], decision: null };
  assert.match(renderQuestionRecord(q), /^### Question 3 \(Q1\)\n/);
  // S11 (issue #59): each option's label in bold on its own line, the description on the next.
  const record = renderQuestionRecord({ ...q, explanations: [shownOf({ id: "t", term: "zod", senses: ["a library"] })], question: [...plain("Use "), term("zod", "t"), ...plain("?")], options: [{ label: plain("Declare it"), description: plain("add it to package.json"), answer: { token: "1" } }] });
  assert.ok(record.includes("- 1. **Declare it**  \n  add it to package.json"), record);
  assert.ok(record.includes("- zod: a library"), record);
  assert.match(renderQuestionRecord({ ...q, origin: { kind: "relayed" } }), /^### Question 3\n/);
  assert.match(renderQuestionRecord({ ...q, origin: { kind: "pause", heading: "Planning phase 1", pause: "reraised", id: "P1-R1-2" } }), /^### Question 3 \(P1-R1-2\)\n/);
});

// S11 (issue #19): a pause's facts are prose, never JSON: the issue's problem and evidence, each earlier disposition
// and its rationale in words, and no empty fields.
test("pauseProse writes every kind of pause as prose, without the record's field names or empty fields", async () => {
  const { pauseProse } = await import("../src/render.ts");
  const earlier = [
    { id: "P1-R1-1", phase: 1, round: 1, source: "review" as const, severity: "major" as const, location: "S3", problem: "The plan omits the migration.", evidence: "Step S3 writes the table\nbut never migrates it.", action: "rejected" as const, rationale: "The migration is in S4.", duplicate_of: null, reverses: null, superseded: true },
    { id: "P1-R1-1", phase: 1, round: 2, source: "user" as const, problem: "The plan omits the migration.", action: "decided_by_user" as const, rationale: "Add it to S3.", superseded: false },
  ] as unknown as LogEntry[];
  const issueNow = { id: "P1-R2-1", severity: "major" as const, location: "S3", problem: "Still no migration.", evidence: "S3 is unchanged." };
  const disposition = { id: "P1-R2-1", action: "partially_accepted" as const, rationale: "Only the index.", duplicate_of: "", reverses: "" };
  const all = [
    pauseProse({ pause: "reraised", id: "P1-R1-1", history: earlier, issue: issueNow }),
    pauseProse({ pause: "secondClarification", id: "P1-R1-1", history: earlier, disposition }),
    pauseProse({ pause: "disputedSelfCorrection", id: "P1-R1-1", explanation: "It breaks the build.", history: earlier }),
    pauseProse({ pause: "reversal", id: "P1-R2-1", reverses: "P1-R1-1", history: earlier, issue: issueNow, disposition }),
    pauseProse({ pause: "repeatedUnderNewId", id: "P1-R2-1", repeats: "P1-R1-1", history: earlier, issue: issueNow }),
    pauseProse({ pause: "unexplained", fileLabel: "plan.json", heading: "Planning phase 1", round: 2, resultText: "I tidied it." }),
    pauseProse({ pause: "identical", fileLabel: "plan.json", round: 3, seen: "cycle 1" }),
    pauseProse({ pause: "idle", idle: 2, round: 2, issues: [earlier[0]] }),
  ];
  for (const text of all.map(blocksMarkdown)) {
    assert.ok(text.trim() !== "");
    for (const forbidden of ["{", "duplicate_of", "reverses:", "superseded", "\\n", "null", "decided_by_user", "partially_accepted"]) assert.ok(!text.includes(forbidden), `${forbidden} in: ${text}`);
  }
  const shown = all.map(blocksMarkdown);
  assert.match(shown[0], /The plan omits the migration\./);
  assert.match(shown[0], /Codex says: Still no migration\.\n\nS3 is unchanged\./);
  assert.match(shown[0], /Codex raised it: The plan omits the migration\. — Claude Code rejected it: The migration is in S4\./);
  assert.match(shown[0], /you decided: Add it to S3\./);
  assert.match(shown[1], /accepted it in part: Only the index\./);
  assert.match(shown[5], /I tidied it\./);
  // S9: the facts are blocks of plain pieces, the history a list, and no piece refers to an explanation.
  assert.ok(all[0].some((b) => b.kind === "list"));
  assert.ok(all.flat().every((b) => b.kind !== "paragraph" || b.pieces.every((p) => p.ref === "" && !p.code)));
});

// S49: the permission question says the input is "shown above": conversation.md records the details before the question.
test("renderQuestionRecord writes a permission's input before its question", async () => {
  const { renderQuestionRecord } = await import("../src/render.ts");
  const { permissionDraft, presentedQuestion } = await import("../src/offer.ts");
  const presented = presentedQuestion(permissionDraft("Bash", { command: "rm -rf build" }), 1);
  assert.ok(Result.isSuccess(presented));
  const q = presented.success;
  const record = renderQuestionRecord(q);
  const input = record.indexOf("rm -rf build");
  const asked = record.indexOf(piecesText(q.question));
  assert.ok(input > 0 && asked > input, record);
  assert.ok(record.includes(prompts.TOOL_INPUT_HEADING));
});

// Issue #112: the "Terms:" block labels a term once; one sense stays on its line, several are numbered in order under it.
test("issue #112: the Terms block of conversation.md numbers two senses in order under the term, and keeps one sense on its line", async () => {
  const { renderQuestionRecord } = await import("../src/render.ts");
  const q: PresentedQuestion = {
    number: 1,
    origin: { kind: "relayed" },
    context: { blocks: para("c"), by: "agent" },
    explanations: [shownOf({ id: "a", term: "zod", senses: ["A library."] }), shownOf({ id: "b", term: "port", senses: ["# The number in the address.", "The socket the server listens on."] })],
    question: [...plain("Use "), term("zod", "a"), ...plain(" on the "), term("port", "b"), ...plain("?")],
    options: [],
    details: [],
    decision: null,
  };
  const record = renderQuestionRecord(q);
  assert.ok(record.includes("- zod: A library.\n"), record);
  assert.ok(record.includes("- port:\n  1. \\# The number in the address.\n  2. The socket the server listens on.\n"), record);
  assert.equal(record.split("- port:").length, 2);
});

// W1-R1-1 and P2-R1-1 of work review 1 (issue #112): a sense of several lines, a blank line or a link reference definition
// whose label spans two lines included, stays whole inside its item, and every later sense stays in the numbered list.
const MULTILINE = ["First paragraph.\n\nSecond paragraph.", "Another meaning."];
const LINK_LABEL = "First paragraph.\n\n[label\nname]: https://example.com\n\nLast paragraph.";
const ONE_OF_TWO_PARAGRAPHS = "One paragraph.\n\nAnd another.";
const multiline = (): PresentedQuestion => ({
  number: 1,
  origin: { kind: "relayed" },
  context: { blocks: para("c"), by: "agent" },
  explanations: [
    shownOf({ id: "a", term: "port", senses: MULTILINE }),
    shownOf({ id: "b", term: "cache", senses: [LINK_LABEL, "A store kept in memory."] }),
    shownOf({ id: "c", term: "zod", senses: [ONE_OF_TWO_PARAGRAPHS] }),
  ],
  question: [...plain("Use "), term("port", "a"), ...plain(", "), term("cache", "b"), ...plain(" and "), term("zod", "c"), ...plain("?")],
  options: [],
  details: [],
  decision: null,
});

test("W1-R1-1, P2-R1-1: a multiline sense stays whole inside its item in the Terms block, read back as Markdown", async () => {
  const { renderQuestionRecord } = await import("../src/render.ts");
  const terms = readTerms(renderQuestionRecord(multiline()));
  assert.deepEqual(terms.get("port"), MULTILINE.map(senseRead));
  assert.deepEqual(terms.get("cache"), [senseRead(LINK_LABEL), "A store kept in memory."]);
  assert.deepEqual(terms.get("zod"), [senseRead(ONE_OF_TWO_PARAGRAPHS)]);
});

test("W1-R1-2: the terms list of conversation.md nests each term under its entry, multiline senses whole", () => {
  const entry = { id: "Q1", explanations: [{ id: "a", term: "port", senses: MULTILINE }, { id: "c", term: "zod", senses: [ONE_OF_TWO_PARAGRAPHS] }], context: para("c"), question: plain("Use the port?"), reason: para("r"), proposed_answers: [] };
  const rendered = renderTerms([entry, { ...entry, id: "Q2", explanations: [] }]);
  assert.ok(Result.isSuccess(rendered));
  const terms = readTerms(rendered.success);
  assert.deepEqual(terms.get("port"), MULTILINE.map(senseRead));
  assert.deepEqual(terms.get("zod"), [senseRead(ONE_OF_TWO_PARAGRAPHS)]);
  assert.match(rendered.success, /- \*\*\[Q2\]\*\* no term/);
});

// The seam (W1-R1-2): the Terms block of the record and the terms list write a term as the one item termItem writes.
test("W1-R1-2: the Terms block and the terms list write a term as the same item", async () => {
  const { renderQuestionRecord } = await import("../src/render.ts");
  const explanation = shownOf({ id: "a", term: "port", senses: MULTILINE });
  const item = termItem(explanation, "");
  assert.ok(renderQuestionRecord({ ...multiline(), explanations: [explanation], question: [...plain("Use "), term("port", "a"), ...plain("?")] }).includes(`${item}\n`));
  const rendered = renderTerms([{ id: "Q1", explanations: [{ id: "a", term: "port", senses: MULTILINE }], context: para("c"), question: plain("q?"), reason: para("r"), proposed_answers: [] }]);
  assert.ok(Result.isSuccess(rendered));
  const nested = rendered.success.split("\n").slice(1).map((l) => l.replace(/^ {2}/u, "")).join("\n");
  assert.ok(nested.includes(item), nested);
});

// W1-R1-1 of work review 2 (issue #112): a sense whose lines end with CR or CRLF stays whole inside its item too.
test("W1-R1-1 of work review 2: senses with CR and CRLF line endings stay whole inside their items", async () => {
  const { renderQuestionRecord } = await import("../src/render.ts");
  for (const eol of ["\r", "\r\n"]) {
    const several = [`First paragraph.${eol}${eol}Second paragraph.`, "Another meaning."];
    const single = `One paragraph.${eol}${eol}And another.`;
    const q: PresentedQuestion = {
      ...multiline(),
      explanations: [shownOf({ id: "a", term: "port", senses: several }), shownOf({ id: "c", term: "zod", senses: [single] })],
      question: [...plain("Use "), term("port", "a"), ...plain(" and "), term("zod", "c"), ...plain("?")],
    };
    const terms = readTerms(renderQuestionRecord(q));
    assert.deepEqual(terms.get("port"), several.map(senseRead), JSON.stringify(eol));
    assert.deepEqual(terms.get("zod"), [senseRead(single)], JSON.stringify(eol));
  }
});

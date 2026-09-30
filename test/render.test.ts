import assert from "node:assert/strict";
import { test } from "node:test";
import { analysisLines, interviewSays, recordHeading, renderDecision, renderResponse, renderReview, renderFeedback, renderQuestions, renderRound, subjectHeading } from "../src/render.ts";
import { issue, para, plain, questionEntry, respond, term } from "./helpers.ts";
import { blocksMarkdown, piecesText } from "../src/pieces.ts";
import type { PresentedQuestion } from "../src/question.ts";
import { viewOf } from "../src/analysisView.ts";
import type { Argument, DecisionAnalysis, Entry, LogEntry } from "../src/schema.ts";
import { OPPOSES_MARKER } from "../src/prompts.ts";
import * as prompts from "../src/prompts.ts";

/** A question as the user was shown it, for an analysis's header (S22). */
const presentedOf = (question: string, number: number): PresentedQuestion => ({
  number,
  origin: { kind: "relayed" },
  context: { blocks: [{ kind: "paragraph", pieces: [term("Claude Code", "t1"), ...plain(", the coding agent, asks.")] }], by: "agent" },
  explanations: [{ id: "t1", term: "Claude Code", explanation: "the coding agent" }],
  question: plain(question),
  options: [],
  details: [],
  decision: null,
});

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

// Plan step 1.5: the terminal lines of an interview turn, shared with the page's reducer (4.2).
test("interviewSays gives the terminal lines of a continuing turn and of a proposed summary", () => {
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
  assert.equal(recordHeading("conversation"), "Conversation before planning");
});

// Decision support, plan step 5.1: the terminal shows each option's arguments one after another.
test("analysisLines: each option in turn, Disadvantages:, arguments indented by level, symbols, the recommendation", () => {
  const el = (text: string, counterarguments: Argument[] = []) => ({ text, counterarguments });
  const entry = (id: string, counter: Argument[] = []): Entry => ({
    id,
    title: `Title ${id}.`,
    comparative_condition: el(`c ${id}`, counter),
    starting_cause: el(`s ${id}`),
    intermediate_steps: el(`i ${id}`),
    threshold: el(`t ${id}`),
    effect_on_persons: el(`e ${id}`),
    reason_the_effect_matters: el(`r ${id}`),
    extent: { per_person: el(`pp ${id}`), persons_affected: el(`pa ${id}`), likelihood: el(`l ${id}`), timing: el(`w ${id}`) },
  });
  const analysis: DecisionAnalysis = {
    decision: "d",
    columns: [
      { kind: "argued", option: "SQLite", advantages: [entry("E1", [{ id: "A1", text: "But x.", equivalent_to: "", replies: [{ id: "A2", text: "On the other hand y.", equivalent_to: "E2", replies: [] }] }])], disadvantages: [] },
      { kind: "argued", option: "PostgreSQL", advantages: [], disadvantages: [entry("E2")] },
    ],
    recommendation: { option: "SQLite", reason: "It is sooner." },
  };
  const all = analysisLines(2, presentedOf("Which database?", 5), viewOf(analysis));
  const m = OPPOSES_MARKER;
  // S22: the header names the decision and the question's number; the question's context, terms and text follow it.
  assert.deepEqual(all.slice(0, 2), ["", prompts.decisionViewHeading(2, 5)]);
  const lines = ["", all[1], ...all.slice(all.indexOf("Which database?") + 1)];
  assert.deepEqual(lines.slice(0, 11), ["", prompts.decisionViewHeading(2, 5), "", "Option 1: SQLite", "", "  Advantages:", "", "  Advantage 1: Title E1.", "    - c E1", `        ${m}But x.`, "          On the other hand y. *"]);
  const second = lines.indexOf("Option 2: PostgreSQL");
  assert.ok(second > 0);
  assert.equal(lines.filter((l) => l === "  Advantages:").length, 2);
  assert.equal(lines.filter((l) => l === "  Disadvantages:").length, 2);
  assert.ok(lines.includes(`  ${m}Disadvantage 1: Title E2. *`));
  assert.ok(lines.includes(`    ${m}- c E2`));
  assert.deepEqual(lines.slice(-3), ["", "Recommended option: SQLite", "It is sooner."]);
});

// Issue #35 (Q9): the terminal marks exactly the texts the page colors, both derived from the view of one analysis.
test("analysisLines marks exactly the texts that oppose the column's option, and an unclear column shows its statement", () => {
  const el = (text: string, counterarguments: Argument[] = []) => ({ text, counterarguments });
  const entry = (id: string, counter: Argument[] = []): Entry => ({
    id,
    title: `Title ${id}.`,
    comparative_condition: el(`c ${id}`, counter),
    starting_cause: el(`s ${id}`),
    intermediate_steps: el(`i ${id}`),
    threshold: el(`t ${id}`),
    effect_on_persons: el(`e ${id}`),
    reason_the_effect_matters: el(`r ${id}`),
    extent: { per_person: el(`pp ${id}`), persons_affected: el(`pa ${id}`), likelihood: el(`l ${id}`), timing: el(`w ${id}`) },
  });
  // W1-R1-2: texts of several lines, opposing and not: every physical line is checked.
  const chain = (p: string): Argument[] => [{ id: `${p}1`, text: `${p} one.\n${p} one, continued.`, equivalent_to: "", replies: [{ id: `${p}2`, text: `${p} two.\n${p} two, continued.`, equivalent_to: "", replies: [{ id: `${p}3`, text: `${p} three.`, equivalent_to: "", replies: [] }] }] }];
  const multiline = (e: Entry): Entry => ({ ...e, title: `${e.title}\nTitle continued.`, comparative_condition: { ...e.comparative_condition, text: `${e.comparative_condition.text}\nElement continued.` } });
  const analysis: DecisionAnalysis = {
    decision: "d",
    columns: [
      { kind: "argued", option: "SQLite", advantages: [multiline(entry("E1", chain("a")))], disadvantages: [multiline(entry("E2", chain("d")))] },
      { kind: "unclear", option: "PostgreSQL", unclear: "It could mean a server\nor a hosted service." },
    ],
    recommendation: { option: "", reason: "" },
  };
  const view = viewOf(analysis);
  const marked = (text: string, symbol: string | null) => (symbol === null ? text : `${text} ${symbol}`);
  // Each item's physical lines, as [indentation, the text after the marker, opposes]: a bullet's continuation lines are
  // indented past its "- ", and every line of an opposing text carries the marker after the indentation.
  const physical = (indent: number, prefix: string, text: string, opposes: boolean) =>
    text.split("\n").map((part, i) => [indent, `${i === 0 ? prefix : " ".repeat(prefix.length)}${part}`, opposes] as const);
  const expected = view.columns.flatMap((c) =>
    c.kind === "unclear"
      ? physical(2, "", c.unclear, false)
      : [...c.advantages, ...c.disadvantages].flatMap((e) => [
          ...physical(2, "", `${e.label} ${marked(e.title, e.symbol)}`, e.opposes),
          ...e.elements.flatMap((x) => [...physical(4, "- ", x.text, x.opposes), ...x.arguments.flatMap((a) => physical(6 + 2 * a.level, "", marked(a.text, a.symbol), a.opposes))]),
        ]),
  );
  const all = analysisLines(1, presentedOf("Which?", 1), view);
  const lines = all.slice(all.indexOf("Which?") + 1);
  const rendered = ([indent, text, opposes]: readonly [number, string, boolean]) => `${" ".repeat(indent)}${opposes ? OPPOSES_MARKER : ""}${text}`;
  const items = lines.filter((l) => l !== "" && !/^(Decision|Option) \d/.test(l) && l.trim() !== "Advantages:" && l.trim() !== "Disadvantages:");
  assert.deepEqual(items, expected.map(rendered));
  assert.ok(expected.some(([, , opposes]) => opposes));
  assert.ok(expected.some(([, text]) => text.startsWith("  ")), "a bullet's continuation line is in the fixture");
  const unclear = lines.indexOf("Option 2: PostgreSQL");
  assert.deepEqual(lines.slice(unclear, unclear + 4), ["Option 2: PostgreSQL", "", "  It could mean a server", "  or a hosted service."]);
});

// S8: every question is printed in the one shape: heading with its number, the line saying where it came from, the
// context set apart and indented, the terms, the question itself apart from the context, the options with their answers.
test("questionLines prints the heading, the origin, the context, the terms, the question and the options, in that order", async () => {
  const { questionLines } = await import("../src/render.ts");
  const q: PresentedQuestion = {
    number: 4,
    origin: { kind: "relayed" },
    context: { blocks: para("Claude Code, the coding agent, is writing the tool's input check."), by: "agent" },
    explanations: [{ id: "z", term: "zod", explanation: "a library that checks the shape of data" }],
    question: [...plain("Should "), term("Zod's package", "z"), ...plain(" be declared as a dependency?")],
    options: [
      { label: plain("Declare it"), description: plain("add it to package.json"), answer: { token: "1" } },
      { label: plain("More cycles"), description: [], answer: { numeric: true } },
    ],
    details: [],
    decision: null,
  };
  const lines = questionLines(q);
  const at = (text: string) => lines.findIndex((l) => l.includes(text));
  const question = "Should Zod's package be declared as a dependency?";
  assert.equal(lines.find((l) => l.trim() !== ""), prompts.questionTitle(4));
  const order = [prompts.originLine(q.origin, null).slice(0, 30), "is writing the tool's input check", prompts.TERMS_HEADING, "zod: a library", question, "1. Declare it", "add it to package.json", "More cycles (type the number)"].map(at);
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), JSON.stringify({ order, lines }));
  // S11 (issue #36): the Terms line is labeled with the explanation's term, not with the words of the piece.
  assert.ok(!lines.some((l) => l.includes("Zod's package:")), JSON.stringify(lines));
  // S11 (issue #59): the label on its own line, the description on the next, indented under the label.
  assert.equal(lines[at("1. Declare it")], "  1. Declare it");
  assert.equal(lines[at("1. Declare it") + 1], "     add it to package.json");
  // The context is indented and set apart by blank lines; the question is not indented.
  assert.match(lines[at("is writing the tool's input check")], /^ {4}\S/);
  assert.equal(lines[at("is writing the tool's input check") - 1], "");
  assert.equal(lines[at(question)], question);
  assert.equal(lines[at(question) - 1], "");
  // S11: what the question is about follows the context, before the terms and the question.
  const withDetails = questionLines({ ...q, details: para("Codex says: the migration is missing.") });
  const d = withDetails.findIndex((l) => l.includes("Codex says"));
  assert.ok(d > withDetails.findIndex((l) => l.includes("is writing the tool's input check")) && d < withDetails.findIndex((l) => l.includes(prompts.TERMS_HEADING)));
  // A context the program wrote is marked as the program's.
  assert.ok(questionLines({ ...q, context: { blocks: para("x"), by: "program" } }).some((l) => l.includes(prompts.CONTEXT_BY_PROGRAM)));
  assert.ok(!lines.some((l) => l.includes(prompts.CONTEXT_BY_PROGRAM)));
  // A document block, Claude Code's message, is printed whole.
  const doc = questionLines({ ...q, context: { blocks: [{ kind: "document", markdown: "# Title\n\n- one\n- two" }], by: "agent" } });
  for (const line of ["    # Title", "    - one", "    - two"]) assert.ok(doc.includes(line), line);
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
  const record = renderQuestionRecord({ ...q, explanations: [{ id: "t", term: "zod", explanation: "a library" }], question: [...plain("Use "), term("zod", "t"), ...plain("?")], options: [{ label: plain("Declare it"), description: plain("add it to package.json"), answer: { token: "1" } }] });
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

// S22: the question beside its analysis is the one the user was shown: its number, its context and its terms.
test("an analysis's terminal header carries the question's number, context and terms before the question", () => {
  const analysis: DecisionAnalysis = { decision: "d", columns: [], recommendation: { option: "", reason: "" } };
  const lines = analysisLines(3, presentedOf("Which?", 9), viewOf(analysis));
  const at = (text: string) => lines.findIndex((l) => l.includes(text));
  assert.equal(lines[1], prompts.decisionViewHeading(3, 9));
  assert.match(prompts.decisionViewHeading(3, 9), /Decision 3.*Question 9/);
  const order = [at("Claude Code, the coding agent, asks."), at(prompts.TERMS_HEADING), at("Claude Code: the coding agent"), lines.indexOf("Which?")];
  assert.ok(order.every((i, n) => i > 1 && (n === 0 || i > order[n - 1])), JSON.stringify(lines));
});

// S49: the permission question says the input is "shown above": the terminal prints the details before the question.
test("questionLines prints a permission's input before its question", async () => {
  const { questionLines } = await import("../src/render.ts");
  const { permissionDraft, presentedQuestion } = await import("../src/offer.ts");
  const q = presentedQuestion(permissionDraft("Bash", { command: "rm -rf build" }), 1);
  const lines = questionLines(q);
  const input = lines.findIndex((l) => l.includes("rm -rf build"));
  const asked = lines.indexOf(piecesText(q.question));
  assert.ok(input > 0 && asked > input, JSON.stringify(lines));
  assert.ok(lines.some((l) => l.includes(prompts.TOOL_INPUT_HEADING)));
});

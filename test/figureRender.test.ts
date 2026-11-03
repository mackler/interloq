// Issue #98 (requirements Q2, G-R1-1): conversation.md links each picture's file, figures/<sha256 of its markup>.svg, with
// its alt text as the link's; a surface that cannot reach the run's files (the dashboard, a tracker comment) shows the
// alt text instead.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Result } from "effect";
import type { Figure } from "../src/figure.ts";
import { plainPieces } from "../src/pieces.ts";
import type { PresentedQuestion } from "../src/question.ts";
import { figureMarkdown, renderQuestionRecord, renderQuestions, renderTerms } from "../src/render.ts";
import type { FigureReply, TermsEntry } from "../src/schema.ts";
import { entryOf } from "./helpers.ts";

const FIGURE: FigureReply = { svg: '<svg viewBox="0 0 4 3"><rect width="4" height="1"/></svg>', alt: "A band across the top." };
const file = (f: FigureReply) => `figures/${createHash("sha256").update(f.svg, "utf8").digest("hex")}.svg`;
const link = (f: FigureReply) => `![${f.alt}](${file(f)})`;

const presented = (figure: FigureReply | null): PresentedQuestion => ({
  number: 1,
  origin: { kind: "relayed" },
  context: { blocks: [{ kind: "paragraph", pieces: plainPieces("c") }], by: "agent" },
  history: [],
  explanations: [],
  question: plainPieces("Which?"),
  options: [
    { label: plainPieces("Narrow"), description: plainPieces("n"), figure: figure as Figure | null, answer: { token: "1" } },
    { label: plainPieces("Wide"), description: plainPieces("w"), figure: null, answer: { token: "2" } },
  ],
  attached: null,
  decision: null,
});
const entry = (figure: FigureReply | null) => {
  const e = entryOf({ id: "Q1", context: "c", question: "Which?", reason: "r", proposed_answers: [{ label: "Narrow", description: "n" }, { label: "Wide", description: "w" }], default_answer: "Narrow" });
  return { ...e, proposed_answers: [{ ...e.proposed_answers[0]!, figure }, e.proposed_answers[1]!] };
};
const terms = (figure: FigureReply | null): TermsEntry => {
  const e = entry(figure);
  return { id: e.id, explanations: [], context: e.context, history: e.history, question: e.question, reason: e.reason, proposed_answers: e.proposed_answers };
};

test("the question record links the picture's file under its option, named by the hash of its markup", () => {
  const record = renderQuestionRecord(presented(FIGURE));
  const lines = record.split("\n");
  const at = lines.findIndex((l) => l.includes("**Narrow**"));
  assert.ok(lines.slice(at + 1, at + 4).some((l) => l.trim() === link(FIGURE)), record);
  assert.equal(record.split("](figures/").length, 2, "one link, under its own option");
});

test("an alt text with brackets, a backslash and line breaks stays one link", () => {
  const md = figureMarkdown({ svg: FIGURE.svg, alt: "a [b] c\\d\ne\r\nf" });
  assert.equal(md, `![a \\[b\\] c\\\\d e f](${file(FIGURE)})`);
  assert.ok(!/[\r\n]/u.test(md));
});

test("the question list links the picture in the records and shows its alt text elsewhere", () => {
  const linked = renderQuestions({ questions: [entry(FIGURE)] }, "link");
  assert.ok(linked.includes(link(FIGURE)), linked);
  const alt = renderQuestions({ questions: [entry(FIGURE)] }, "alt");
  assert.ok(alt.includes(`Picture: ${FIGURE.alt}`), alt);
  assert.ok(!alt.includes("](figures/"));
});

test("the terms render each answer's picture under its entry, linked or as alt text", () => {
  const linked = Result.getOrThrow(renderTerms([terms(FIGURE)], "link"));
  assert.ok(linked.includes(`Narrow: ${link(FIGURE)}`), linked);
  const alt = Result.getOrThrow(renderTerms([terms(FIGURE)], "alt"));
  assert.ok(alt.includes(`Picture: ${FIGURE.alt}`) && !alt.includes("](figures/"), alt);
});

test("a question, a list and terms without pictures render as before", () => {
  assert.ok(!renderQuestionRecord(presented(null)).includes("figures/"));
  assert.equal(renderQuestions({ questions: [entry(null)] }, "link"), renderQuestions({ questions: [entry(null)] }, "alt"));
  assert.equal(Result.getOrThrow(renderTerms([terms(null)], "link")), "- **[Q1]** no term\n");
});

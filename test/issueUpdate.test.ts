import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { RUN_ROOT_FOR_TESTS } from "./issueUpdateRoot.ts";
import { changeCounts, changeMarkdown, initialProtection, issueApplyValidation, issueUpdateValidation, type Protection, protectionAfterDecisions, protectionAfterResponse, protectedPassagesOf } from "../src/issueUpdate.ts";
import * as prompts from "../src/prompts.ts";
import { CLOSING_LINE, itemTextOf, type ItemText, OPENING_LINE } from "../src/refinement.ts";
import * as S from "../src/schema.ts";

// Issue #216: the prompts of Bring Up to Date and the validation of what Claude Code returns, from one source.

const text = (title: string, body: string): ItemText => Result.getOrThrow(itemTextOf(title, body));
const INSTRUCTION = "> **The developer's instruction, 1 Nov 2026:** a refinement begins with a new phase that brings the issue up to date before any question is asked.";
const BEFORE = text("A refinement asks questions about the issue as it was filed", `${INSTRUCTION}\n\nThe file src/old.ts:42 holds the check.`);
const P: Protection = { before: BEFORE, protected: initialProtection(BEFORE) };
const response = (title: string, body: string, passages: readonly string[], outcome: S.UpdateOutcomeReply = { kind: "current" }): S.UpdateResponse => ({
  dispositions: [], self_corrections: [], reviewer_feedback: "", questions_for_user: [], issue: { title, text: body }, outcome, developer_passages: [...passages],
});
const write = (title: string, body: string, passages: readonly string[], decided: readonly S.DecidedChange[]): S.UpdateWrite => ({ issue: { title, text: body }, outcome: { kind: "current" }, developer_passages: [...passages], decided: [...decided], questions_for_user: [] });
const kinds = (r: Result.Result<unknown, Readonly<{ error: unknown; repair: string }>>): readonly string[] =>
  Result.isFailure(r) ? ((r.failure.error as { problems?: readonly { kind: string }[] }).problems ?? []).map((p) => p.kind) : [];

test("the prompts name every field the validation reads, from the schemas' own field names", () => {
  const respond = prompts.updateRespondPrompt(RUN_ROOT_FOR_TESTS, 1);
  for (const field of [...Object.keys(S.UpdateResponse.fields), ...Object.keys(S.IssueTextReply.fields)]) assert.ok(respond.includes(field), field);
  const apply = prompts.updateApplyDecisionsPrompt(RUN_ROOT_FOR_TESTS);
  for (const field of [...Object.keys(S.UpdateWrite.fields), ...Object.keys(S.DecidedChange.fields)]) assert.ok(apply.includes(field), field);
  for (const p of [respond, apply]) {
    assert.ok(p.includes("protected"));
    assert.ok(p.includes(OPENING_LINE) && p.includes(CLOSING_LINE), "the marker lines the validation refuses");
  }
  assert.ok(prompts.updateCheckPrompt(RUN_ROOT_FOR_TESTS, 1, "continued").includes(prompts.UPDATE_MARKER));
});

test("a passage of the developer's altered by one character is refused, and its repair prompt names it", () => {
  const altered = INSTRUCTION.replace("1 Nov 2026", "1 Nov 2025");
  const r = issueUpdateValidation(P)(response(BEFORE.title, `${altered}\n\nThe file src/new.ts:40 holds the check.`, [altered]));
  assert.ok(Result.isFailure(r));
  assert.ok(kinds(r).includes("protectedMissing"));
  assert.ok(r.failure.repair.includes(INSTRUCTION), r.failure.repair);
  const ok = issueUpdateValidation(P)(response(BEFORE.title, `${INSTRUCTION}\n\nThe file src/new.ts:40 holds the check.`, [INSTRUCTION]));
  assert.ok(Result.isSuccess(ok));
});

test("a marker line, a blank title and a blank obsolete reason are refused", () => {
  assert.ok(kinds(issueUpdateValidation(P)(response(BEFORE.title, `${INSTRUCTION}\n${OPENING_LINE}`, []))).includes("invalidText"));
  assert.ok(kinds(issueUpdateValidation(P)(response(" ", INSTRUCTION, []))).includes("invalidText"));
  assert.ok(kinds(issueUpdateValidation(P)(response(BEFORE.title, BEFORE.text, [], { kind: "obsolete", reason: " " }))).includes("blankReason"));
});

test("a quoted phrase in the title alone is protected, and a reply changing it in the title is refused", () => {
  const before = text('Use "the old service" everywhere', "body");
  const p: Protection = { before, protected: initialProtection(before) };
  assert.deepEqual([...p.protected], ['"the old service"']);
  assert.ok(kinds(issueUpdateValidation(p)(response('Use "the new service" everywhere', "body", []))).includes("protectedMissing"));
  assert.ok(Result.isSuccess(issueUpdateValidation(p)(response('Use "the old service" everywhere now', "body 2", ['"the old service"']))));
});

test("P1-R1-1: a passage declared in an earlier round cannot be dropped from both the text and the list", () => {
  const declared = "Never close an issue by yourself.";
  const before = text("T", `${declared}\n\nOld fact.`);
  const round1 = issueUpdateValidation({ before, protected: initialProtection(before) })(response("T", `${declared}\n\nNew fact.`, [declared]));
  assert.ok(Result.isSuccess(round1));
  const p2: Protection = { before, protected: protectionAfterResponse({ before, protected: initialProtection(before) }, round1.success.value) };
  assert.ok(p2.protected.includes(declared));
  assert.ok(kinds(issueUpdateValidation(p2)(response("T", "New fact.", []))).includes("protectedMissing"));
});

test("P1-R1-2: a decision's new wording becomes protected and declarable; without a decision it is refused", () => {
  const before = text("T", "He said “Use the old service” here.");
  const p: Protection = { before, protected: initialProtection(before) };
  const decided = write("T", "He said “Use the new service” here.", ["“Use the new service”"], [{ before: "“Use the old service”", after: "“Use the new service”" }]);
  assert.ok(Result.isSuccess(issueApplyValidation(p, before)(decided)));
  const after = protectionAfterDecisions(p, decided);
  assert.ok(after.includes("“Use the new service”") && !after.includes("“Use the old service”"));
  const p2: Protection = { before, protected: after };
  assert.ok(Result.isSuccess(issueUpdateValidation(p2)(response("T", "He said “Use the new service” here, now.", ["“Use the new service”"]))));
  assert.ok(Result.isFailure(issueUpdateValidation(p2)(response("T", "He said “Use the old service” here.", ["“Use the old service”"]))));
  assert.ok(kinds(issueUpdateValidation(p)(response("T", "He said “Use the old service” and “Use the new service” here.", ["“Use the new service”"]))).includes("notTheDevelopers"));
});

test("P1-R1-2, round 4: the same replacement where the quotation stands in the title alone", () => {
  const before = text("He said “Use the old service”", "body");
  const p: Protection = { before, protected: initialProtection(before) };
  const decided = write("He said “Use the new service”", "body", ["“Use the new service”"], [{ before: "“Use the old service”", after: "“Use the new service”" }]);
  assert.ok(Result.isSuccess(issueApplyValidation(p, before)(decided)));
  const p2: Protection = { before, protected: protectionAfterDecisions(p, decided) };
  assert.ok(Result.isSuccess(issueUpdateValidation(p2)(response("He said “Use the new service”", "body 2", ["“Use the new service”"]))));
});

test("protectedPassagesOf finds block quotes and quoted phrases, not quoted identifiers", () => {
  assert.deepEqual([...protectedPassagesOf('> one line\n  > two\nplain "word" and "two words" and “curly one”')], ["> one line", "  > two", '"two words"', "“curly one”"]);
});

test("the phase's texts to Codex and to the user say check, never review", () => {
  const texts = [prompts.updateCheckPrompt(RUN_ROOT_FOR_TESTS, 1, "continued"), prompts.updateCheckPrompt(RUN_ROOT_FOR_TESTS, 2, "continued"), prompts.updateCheckPrompt(RUN_ROOT_FOR_TESTS, 3, "new"), prompts.UPDATE_PHASE, prompts.PROCEED_WITHOUT_UPDATE];
  const prose = (t: string): string => t.replace(/\S*\/\S*|\S+\.(json|md|jsonl|diff|log)\b/gu, "").replace(/'review'/gu, "");
  for (const t of texts) assert.doesNotMatch(prose(t), /\breview(s|ed)?\b/iu, t.slice(0, 200));
});

// Issue #216 (W2-R1-1): the change report's lines are those of a shortest edit script, so a reordering is reported.
test("changeCounts and changeMarkdown report a reordering and a title change", () => {
  const before = { title: "T", text: "First\nSecond" };
  const after = { title: "T", text: "Second\nFirst" };
  assert.deepEqual(changeCounts(before, after), { added: 1, removed: 1 });
  const md = changeMarkdown(before, after, []);
  const section = (heading: string) => md.split(`### ${heading}`)[1]!.split("###")[0]!.trim();
  assert.notEqual(section("Lines removed"), "None.");
  assert.notEqual(section("Lines added"), "None.");
  assert.deepEqual(changeCounts({ title: "Old", text: "x" }, { title: "New", text: "x" }), { added: 1, removed: 1 });
});

// Issue #216 (S7): the phase Bring Up to Date over testLayer, with the fake tracker.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Cause, Effect, Exit, Option, Result } from "effect";
import { bringUpToDate } from "../src/bringUpToDate.ts";
import type { UpdateOutcome } from "../src/issueUpdate.ts";
import * as prompts from "../src/prompts.ts";
import { itemTextOf, type ItemText } from "../src/refinement.ts";
import type * as S from "../src/schema.ts";
import { type ItemId, itemIdOf } from "../src/tracker.ts";
import { runTrackerEnv } from "../src/trackerRetry.ts";
import { Store } from "../src/services.ts";
import type { FakeItem } from "./fakeTracker.ts";
import { fakeTrackerOf, issue, type PlanningStep, type ReviewStep, respond, type ScriptedAnswer, tempRepo, testLayer, userQuestion } from "./helpers.ts";

const id = (t: string): ItemId => Result.getOrThrow(itemIdOf(t));
const text = (title: string, body: string): ItemText => Result.getOrThrow(itemTextOf(title, body));
const QUOTE = "> Interloq never closes an issue by itself.";
const BEFORE = text("Bring the issue up to date", `${QUOTE}\n\nThe check is in src/old.ts.`);
const ITEM: FakeItem = { id: id("7"), title: BEFORE.title, body: BEFORE.text, state: "unrefined", open: true, url: Option.none() };

/** Claude Code's response to a check: the dispositions of `respond`, the issue's title and text, and the passages kept. */
const updateResponse = (dispositions: Parameters<typeof respond>[0], t: Readonly<{ title: string; text: string }>, passages: readonly string[], extra: Partial<S.UpdateResponse> = {}): S.UpdateResponse =>
  ({ ...respond(dispositions), issue: { title: t.title, text: t.text }, outcome: { kind: "current" }, developer_passages: [...passages], ...extra }) as S.UpdateResponse;

const phase = async (steps: PlanningStep[], reviews: ReviewStep[], options: Readonly<{ answers?: readonly ScriptedAnswer[]; items?: readonly FakeItem[]; before?: ItemText }> = {}) => {
  const repo = tempRepo();
  const tracker = fakeTrackerOf(options.items ?? [ITEM]);
  // maxIdleRounds raised so that a dispute repeated across rounds is not ended by the idle limit, which is the developer's question.
  const { layer, probe } = testLayer(repo, { steps, reviews, answers: options.answers ?? [], tracker, mode: "refinement", config: { maxIdleRounds: 5 } });
  const exit = await Effect.runPromiseExit(Effect.andThen(Effect.flatMap(Store, (store) => store.init("task")), Effect.flatMap(runTrackerEnv, (env) => bringUpToDate(id("7"), options.before ?? BEFORE, env))).pipe(Effect.provide(layer)));
  const read = (name: string) => fs.readFileSync(path.join(probe.dir, name), "utf8");
  return { exit, probe, tracker, read, json: (name: string) => JSON.parse(read(name)) };
};
const outcomeOf = (exit: Exit.Exit<UpdateOutcome, unknown>): UpdateOutcome => {
  assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");
  return exit.value;
};
const AMENDED = { title: BEFORE.title, text: `${QUOTE}\n\nThe check is in src/new.ts.` };

test("(a) a stale file name raised, amended and agreed: Amended, and the records keep the title and text before and after", async () => {
  const r = await phase([{ output: updateResponse([["U-R1-1", "accepted"]], AMENDED, [QUOTE]) }], [{ issues: [issue("U-R1-1", "src/old.ts no longer exists; the check is in src/new.ts")] }, { issues: [] }]);
  const outcome = outcomeOf(r.exit);
  assert.equal(outcome._tag, "Amended");
  assert.ok(outcome._tag === "Amended" && outcome.text.text === AMENDED.text);
  assert.deepEqual({ title: r.json("issue-before.json").title, text: r.json("issue-before.json").text }, { title: BEFORE.title, text: BEFORE.text });
  assert.equal(r.json("issue.json").text, AMENDED.text);
  const conversation = r.read("conversation.md");
  assert.match(conversation, /U-R1-1/u);
  assert.match(conversation, /### Lines removed[\s\S]*src\/old\.ts[\s\S]*### Lines added[\s\S]*src\/new\.ts/u);
  assert.ok(r.probe.reviewer.prompts.every((p) => p.includes(prompts.UPDATE_MARKER)));
});

test("(b) the first check raises nothing: Unchanged, and Claude Code is not called", async () => {
  const r = await phase([], [{ issues: [] }]);
  assert.equal(outcomeOf(r.exit)._tag, "Unchanged");
  assert.match(r.read("conversation.md"), new RegExp(prompts.UPDATE_UNCHANGED_LINE.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("(c, f) a point about the developer's instruction reaches him as a question; his decision's new wording is then kept and declared", async () => {
  const quoted = "He said “Use the old service” here.";
  const before = text("T", quoted);
  const question = userQuestion("Which service should the issue name?", [["Use the old service", "keep it"], ["Use the new service", "change it"]]);
  const decided: S.UpdateWrite = { issue: { title: "T", text: "He said “Use the new service” here." }, outcome: { kind: "current" }, developer_passages: ["“Use the new service”"], decided: [{ before: "“Use the old service”", after: "“Use the new service”" }], questions_for_user: [] };
  const r = await phase(
    [
      { output: updateResponse([["U-R1-1", "no_change_needed"]], { title: "T", text: quoted }, ["“Use the old service”"], { questions_for_user: [question] }) },
      { output: decided },
      { output: updateResponse([["U-R2-1", "accepted"]], { title: "T", text: "He said “Use the new service” here, today." }, ["“Use the new service”"]) },
    ],
    [{ issues: [issue("U-R1-1", "the old service was replaced")] }, { issues: [issue("U-R2-1", "a date is missing")] }, { issues: [] }],
    { answers: ["2"], before },
  );
  const outcome = outcomeOf(r.exit);
  assert.ok(r.probe.ui.notified.some((e) => e._tag === "QuestionPresented" && JSON.stringify(e).includes("Which service")), "the question reached the developer");
  assert.ok(outcome._tag === "Amended" && outcome.text.text.includes("“Use the new service”"));
  assert.ok(r.json("issue.json").protected.includes("“Use the new service”"));
});

test("(d) a response that drops a quoted passage gets the repair turn, and halts with PassageMissing on a second failure", async () => {
  const dropped = updateResponse([["U-R1-1", "accepted"]], { title: BEFORE.title, text: "The check is in src/new.ts." }, []);
  const r = await phase([{ output: dropped }, { output: dropped }], [{ issues: [issue("U-R1-1")] }]);
  assert.ok(Exit.isFailure(r.exit));
  const error = Cause.findErrorOption(r.exit.cause);
  assert.ok(Option.isSome(error) && error.value._tag === "PassageMissing");
});

test("(e) P1-R1-1: a passage declared in round 1 and dropped from both the text and the list in round 2 is refused with the repair turn", async () => {
  const instruction = "Never close an issue by yourself.";
  const before = text("T", `${instruction}\n\nOld fact.`);
  const r = await phase(
    [
      { output: updateResponse([["U-R1-1", "accepted"]], { title: "T", text: `${instruction}\n\nNew fact.` }, [instruction]) },
      { output: updateResponse([["U-R2-1", "accepted"]], { title: "T", text: "New fact, newer." }, []) },
      { output: updateResponse([["U-R2-1", "accepted"]], { title: "T", text: `${instruction}\n\nNew fact, newer.` }, [instruction]) },
    ],
    [{ issues: [issue("U-R1-1")] }, { issues: [issue("U-R2-1")] }, { issues: [] }],
    { before },
  );
  const outcome = outcomeOf(r.exit);
  assert.ok(outcome._tag === "Amended" && outcome.text.text.startsWith(instruction));
  assert.ok(r.probe.planner.prompts.some((p) => p.includes(instruction) && p.includes("no longer in the title or the text")), "the repair prompt names the dropped passage");
});

test("(g) a quoted phrase in the title alone, changed by the first response, is refused with the repair turn", async () => {
  const before = text('Use "the old service" now', "body");
  const r = await phase(
    [
      { output: updateResponse([["U-R1-1", "accepted"]], { title: 'Use "the new service" now', text: "body 2" }, []) },
      { output: updateResponse([["U-R1-1", "accepted"]], { title: 'Use "the old service" now', text: "body 2" }, ['"the old service"']) },
    ],
    [{ issues: [issue("U-R1-1")] }, { issues: [] }],
    { before },
  );
  const outcome = outcomeOf(r.exit);
  assert.ok(outcome._tag === "Amended" && outcome.text.title === 'Use "the old service" now');
});

test("(h) the cited issues are read two levels deep, each once, the item never; a closed one is named closed, an unreadable one named", async () => {
  const items: FakeItem[] = [
    { ...ITEM, body: `${BEFORE.text}\n\nSee #2, #3 and #9.` },
    { id: id("2"), title: "Two", body: "Cites #4 and #7.", state: "refined", open: true, url: Option.none() },
    { id: id("3"), title: "Three", body: "Cites #2.", state: "implemented", open: false, url: Option.none() },
    { id: id("4"), title: "Four", body: "Cites #5.", state: "unrefined", open: true, url: Option.none() },
    { id: id("5"), title: "Five", body: "", state: "unrefined", open: true, url: Option.none() },
  ];
  const r = await phase([], [{ issues: [] }], { items, before: text(ITEM.title, items[0]!.body) });
  outcomeOf(r.exit);
  const cited = r.read("cited-issues.md");
  assert.match(cited, /## #2 \(open\): Two/u);
  assert.match(cited, /## #3 \(closed\): Three\n\n```\nCites #2\.\n```/u);
  assert.match(cited, /## #4 \(open\): Four/u);
  assert.doesNotMatch(cited, /#5 \(/u);
  assert.match(cited, /## #9 \(unreadable\)/u);
  assert.equal((cited.match(/## #2 /gu) ?? []).length, 1);
  assert.match(r.read("conversation.md"), /cited issue 9 could not be read/u);
});

test("(i) a disputed fact is settled by the agents and recorded; a marked one raised again is asked", async () => {
  const kept = { title: BEFORE.title, text: BEFORE.text };
  const settled = await phase(
    [{ output: updateResponse([["U-R1-1", "rejected"]], kept, [QUOTE]) }, { output: updateResponse([["U-R1-1", "rejected"]], kept, [QUOTE]) }],
    [{ issues: [issue("U-R1-1")] }, { issues: [issue("U-R1-1")] }, { issues: [] }],
  );
  outcomeOf(settled.exit);
  assert.match(settled.read("conversation.md"), new RegExp(prompts.WORDING_DISPUTE_HEADING.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.equal(settled.probe.ui.asked.length, 0);
  const marked = await phase(
    [
      { output: updateResponse([["U-R1-1", "rejected", true]], kept, [QUOTE]) },
      { output: { issue: kept, outcome: { kind: "current" }, developer_passages: [QUOTE], decided: [], questions_for_user: [] } },
      { output: updateResponse([["U-R1-1", "rejected", true]], kept, [QUOTE]) },
    ],
    [{ issues: [issue("U-R1-1")] }, { issues: [issue("U-R1-1")] }, { issues: [] }],
    { answers: ["2"] },
  );
  outcomeOf(marked.exit);
  assert.ok(marked.probe.ui.asked.length > 0, "the marked dispute was asked");
});


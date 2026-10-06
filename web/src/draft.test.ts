import { describe, expect, test } from "vitest";
import * as prompts from "../../src/prompts.ts";
import type { RunEvent, ServerMessage, Stamped } from "../../src/protocol.ts";
import { promptOf } from "../../src/userPrompts.ts";
import type { ClientMessage } from "../../src/protocol.ts";
import { type Draft, draftFor, pendingKey, reconcile, restoreUnsent } from "./draft.ts";
import { initialState, reduce, type ViewState } from "./state.ts";

// Finding 5 of docs/gui-review.md: a draft belongs to (incarnation, run, prompt).
const started: RunEvent = { _tag: "Started", project: "/p", task: "t" };
const TIME = "2026-09-27T14:00:00.000Z";
const stamp = (events: readonly RunEvent[]): Stamped[] => events.map((event) => ({ time: TIME, event }));
const asked = (prompt: number): RunEvent => ({ _tag: "Asked", prompt, ...promptOf(prompts.decisionPrompt) });
const answered = (prompt: number): RunEvent => ({ _tag: "Answered", prompt, text: "" });
const hello = (incarnation = "a", current: number | null = 1): ServerMessage => ({ type: "hello", cwd: "/p", current, incarnation });
const fold = (messages: readonly ServerMessage[], from: ViewState = initialState): ViewState => messages.reduce(reduce, from);
const live = (events: readonly RunEvent[]): ViewState => fold([hello(), { type: "replay", ui: [], runs: [] }, ...events.map((event, seq): ServerMessage => ({ type: "event", run: 1, seq, time: TIME, event }))]);
const draft: Draft = { key: { incarnation: "a", run: 1, prompt: 1 }, text: "my unsent answer" };

describe("draft", () => {
  test("the pending prompt's key, and the draft's text only for its own key", () => {
    const view = live([started, asked(1)]);
    expect(pendingKey(view)).toEqual({ incarnation: "a", run: 1, prompt: 1 });
    expect(draftFor(draft, pendingKey(view))).toBe("my unsent answer");
    expect(draftFor(draft, { incarnation: "a", run: 1, prompt: 2 })).toBe("");
    expect(draftFor(null, pendingKey(view))).toBe("");
  });

  test("a live answer from another tab withdraws the draft with a notice", () => {
    expect(reconcile(draft, live([started, asked(1), answered(1), asked(2)]))).toEqual({ draft: null, notice: prompts.draftWithdrawnNotice("my unsent answer") });
  });

  test("a replay after a reconnection in which the prompt was answered meanwhile withdraws the draft with a notice", () => {
    const view = fold([hello(), { type: "replay", ui: [], runs: [{ id: 1, events: stamp([started, asked(1), answered(1), asked(2)]) }] }], live([started, asked(1)]));
    expect(reconcile(draft, view)).toEqual({ draft: null, notice: prompts.draftWithdrawnNotice("my unsent answer") });
  });

  test("a replay in which the same prompt is still pending keeps the draft", () => {
    const view = fold([hello(), { type: "replay", ui: [], runs: [{ id: 1, events: stamp([started, asked(1)]) }] }], live([started, asked(1)]));
    expect(reconcile(draft, view)).toEqual({ draft, notice: null });
  });

  test("another incarnation of the server withdraws the draft with a notice; an empty draft goes quietly", () => {
    const view = fold([hello("b"), { type: "replay", ui: [], runs: [{ id: 1, events: stamp([started, asked(1)]) }] }], live([started, asked(1)]));
    expect(reconcile(draft, view)).toEqual({ draft: null, notice: prompts.draftWithdrawnNotice("my unsent answer") });
    expect(reconcile({ ...draft, text: "" }, live([started, asked(1), answered(1)]))).toEqual({ draft: null, notice: null });
  });
});

// Defect B of docs/page-question-phase-defects.md, G-R1-1 and P1-R1-2: an answer the page could not send never
// overwrites text typed since; it goes back to an empty field or is quoted.
describe("an answer not sent", () => {
  const view = live([started, asked(1)]);
  const key = { incarnation: "a", run: 1, prompt: 1 };
  const answer = (text: string, prompt = 1): ClientMessage => ({ type: "answer", incarnation: "a", run: 1, prompt, text });

  test("goes back to the pending prompt's empty field", () => {
    expect(restoreUnsent(null, view, answer("A"))).toEqual({ draft: { key, text: "A" }, quoted: null });
    expect(restoreUnsent({ key, text: "" }, view, answer("A"))).toEqual({ draft: { key, text: "A" }, quoted: null });
  });

  test("leaves newer text in the field and is quoted", () => {
    expect(restoreUnsent({ key, text: "B" }, view, answer("A"))).toEqual({ draft: { key, text: "B" }, quoted: "A" });
  });

  test("two, in queue order: the first fills the empty field, the second is quoted", () => {
    const first = restoreUnsent(null, view, answer("A"));
    const second = restoreUnsent(first.draft, view, answer("C"));
    expect([first.quoted, second.draft, second.quoted]).toEqual([null, { key, text: "A" }, "C"]);
  });

  test("an answer to a prompt no longer pending is quoted", () => {
    expect(restoreUnsent(null, view, answer("old", 7))).toEqual({ draft: null, quoted: "old" });
  });

  test("an answer equal to the field's text, which was kept, quotes nothing", () => {
    expect(restoreUnsent({ key, text: "same" }, view, answer("same"))).toEqual({ draft: { key, text: "same" }, quoted: null });
  });

  test("a stop, a start and a listing leave the draft and quote nothing", () => {
    const d: Draft = { key, text: "B" };
    for (const m of [{ type: "stop", incarnation: "a", run: 1 }, { type: "start", project: "/p", task: "t" }, { type: "list", path: "/" }] as const) expect(restoreUnsent(d, view, m)).toEqual({ draft: d, quoted: null });
  });
});

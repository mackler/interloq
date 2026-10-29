import { describe, expect, test } from "vitest";
import * as prompts from "../../src/prompts.ts";
import type { RunEvent, ServerMessage, Stamped } from "../../src/protocol.ts";
import { promptOf } from "../../src/userPrompts.ts";
import type { ClientMessage } from "../../src/protocol.ts";
import { awaitedKey, carried, type Draft, draftFor, pendingKey, type Reconciled, reconcile, restoreUnsent } from "./draft.ts";
import fc from "fast-check";
import { plainPieces } from "../../src/pieces.ts";
import type { UiEvent } from "../../src/uiEvents.ts";
import { emptyRun, initialState, reduce, type Shown, shownRun, type ViewState } from "./state.ts";
import { helloChain } from "./testChain.ts";

// Finding 5 of docs/gui-review.md: a draft belongs to (incarnation, run, prompt).
const started: RunEvent = { _tag: "Started", project: "/p", location: "/p", task: "t", mode: "implementation", item: { id: "1", title: "t" } };
const TIME = "2026-09-27T14:00:00.000Z";
const stamp = (events: readonly RunEvent[]): Stamped[] => events.map((event) => ({ time: TIME, event }));
const asked = (prompt: number): RunEvent => ({ _tag: "Asked", prompt, ...promptOf(prompts.decisionPrompt), countdown: null, deciding: null });
const answered = (prompt: number): RunEvent => ({ _tag: "Answered", prompt, text: "" });
const hello = (incarnation = "a", current: number | null = 1): ServerMessage => ({ type: "hello", chain: helloChain, location: "/p", current: { refinement: [], implementation: current }, incarnation });
const fold = (messages: readonly ServerMessage[], from: ViewState = initialState): ViewState => messages.reduce(reduce, from);
const liveState = (events: readonly RunEvent[]): ViewState => fold([hello(), { type: "replay", ui: [], runs: [] }, ...events.map((event, seq): ServerMessage => ({ type: "event", run: 1, seq, time: TIME, event }))]);
/** The implementation tab's run, as the page keys its draft by (issue #120). */
const live = (events: readonly RunEvent[]): Shown => shownRun(liveState(events), "implementation");
const draft: Draft = { _tag: "Held", key: { incarnation: "a", run: 1, prompt: 1 }, text: "my unsent answer" };

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
    const view = shownRun(fold([hello(), { type: "replay", ui: [], runs: [{ id: 1, events: stamp([started, asked(1), answered(1), asked(2)]) }] }], liveState([started, asked(1)])), "implementation");
    expect(reconcile(draft, view)).toEqual({ draft: null, notice: prompts.draftWithdrawnNotice("my unsent answer") });
  });

  test("a replay in which the same prompt is still pending keeps the draft", () => {
    const view = shownRun(fold([hello(), { type: "replay", ui: [], runs: [{ id: 1, events: stamp([started, asked(1)]) }] }], liveState([started, asked(1)])), "implementation");
    expect(reconcile(draft, view)).toEqual({ draft, notice: null });
  });

  test("another incarnation of the server withdraws the draft with a notice; an empty draft goes quietly", () => {
    const view = shownRun(fold([hello("b"), { type: "replay", ui: [], runs: [{ id: 1, events: stamp([started, asked(1)]) }] }], liveState([started, asked(1)])), "implementation");
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
    expect(restoreUnsent(null, view, answer("A"))).toEqual({ draft: { _tag: "Held" as const, key, text: "A" }, quoted: null });
    expect(restoreUnsent({ _tag: "Held" as const, key, text: "" }, view, answer("A"))).toEqual({ draft: { _tag: "Held" as const, key, text: "A" }, quoted: null });
  });

  test("leaves newer text in the field and is quoted", () => {
    expect(restoreUnsent({ _tag: "Held" as const, key, text: "B" }, view, answer("A"))).toEqual({ draft: { _tag: "Held" as const, key, text: "B" }, quoted: "A" });
  });

  test("two, in queue order: the first fills the empty field, the second is quoted", () => {
    const first = restoreUnsent(null, view, answer("A"));
    const second = restoreUnsent(first.draft, view, answer("C"));
    expect([first.quoted, second.draft, second.quoted]).toEqual([null, { _tag: "Held" as const, key, text: "A" }, "C"]);
  });

  test("an answer to a prompt no longer pending is quoted", () => {
    expect(restoreUnsent(null, view, answer("old", 7))).toEqual({ draft: null, quoted: "old" });
  });

  test("an answer equal to the field's text, which was kept, quotes nothing", () => {
    expect(restoreUnsent({ _tag: "Held" as const, key, text: "same" }, view, answer("same"))).toEqual({ draft: { _tag: "Held" as const, key, text: "same" }, quoted: null });
  });

  test("a stop, a start and an items request leave the draft and quote nothing", () => {
    const d: Draft = { _tag: "Held" as const, key, text: "B" };
    for (const m of [{ type: "stop", incarnation: "a", run: 1 }, { type: "start", mode: "implementation", item: "1" }, { type: "items", mode: "refinement" }] as const) expect(restoreUnsent(d, view, m)).toEqual({ draft: d, quoted: null });
  });
});

// Issue #142: the text typed beside a question whose terms the user asked for stays in the field when the same question is
// asked again with its explanations; for another question it is withdrawn with a notice, never dropped silently.
describe("a draft carried across the request for terms", () => {
  const presented = (number: number): RunEvent => ({ _tag: "Notified", event: { _tag: "QuestionPresented", question: { number, origin: { kind: "relayed" }, context: { blocks: [], by: "agent" }, history: [], explanations: [], question: plainPieces("Q?"), options: [], attached: null, decision: null } } satisfies UiEvent });
  const termsAnswer = (prompt: number): RunEvent => ({ _tag: "Answered", prompt, text: "/terms" });
  const key = { incarnation: "a", run: 1, prompt: 1 };
  const carriedDraft = carried({ _tag: "Held", key, text: "half an answer" }, 3);

  test("it waits while the request runs and moves to the prompt that asks the same question again", () => {
    expect(draftFor(carriedDraft, key)).toBe("");
    expect(reconcile(carriedDraft, live([started, presented(3), asked(1), termsAnswer(1)]))).toEqual({ draft: carriedDraft, notice: null });
    const again = live([started, presented(3), asked(1), termsAnswer(1), presented(3), asked(2)]);
    const moved = reconcile(carriedDraft, again);
    expect(moved).toEqual({ draft: { _tag: "Held", key: { ...key, prompt: 2 }, text: "half an answer" }, notice: null });
    expect(draftFor(moved.draft, pendingKey(again))).toBe("half an answer");
  });

  test("it is withdrawn with a notice when another question is asked, or the server is another", () => {
    expect(reconcile(carriedDraft, live([started, presented(3), asked(1), termsAnswer(1), presented(4), asked(2)]))).toEqual({ draft: null, notice: prompts.draftWithdrawnNotice("half an answer") });
    const other = shownRun(fold([hello("b"), { type: "replay", ui: [], runs: [{ id: 1, events: stamp([started, presented(3), asked(2)]) }] }], liveState([started])), "implementation");
    expect(reconcile(carriedDraft, other)).toEqual({ draft: null, notice: prompts.draftWithdrawnNotice("half an answer") });
  });

  // W1-R1-1 of work review 1: a request for terms the page could not send restores the text it carried, not "/terms".
  test("an unsent request for terms gives the carried text back to its still pending prompt", () => {
    const view = live([started, presented(3), asked(1)]);
    const terms: ClientMessage = { type: "answer", incarnation: "a", run: 1, prompt: 1, text: "/terms" };
    const mine = carried({ _tag: "Held", key, text: "my unsent answer" }, 3);
    expect(restoreUnsent(mine, view, terms)).toEqual({ draft: { _tag: "Held", key, text: "my unsent answer" }, quoted: null });
    const another = carried({ _tag: "Held", key: { ...key, prompt: 2 }, text: "elsewhere" }, 3);
    expect(restoreUnsent(another, view, terms)).toEqual({ draft: { _tag: "Held", key, text: "/terms" }, quoted: null });
  });

  test("property: a non-empty carried draft is never dropped without a notice", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }).filter((t) => t.trim() !== ""), fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 5 }), fc.boolean(), (text, number, next, answeredFirst) => {
        const d = carried({ _tag: "Held", key, text }, number);
        const events = answeredFirst ? [started, presented(number), asked(1), termsAnswer(1), presented(next), asked(2)] : [started, presented(number), asked(1), termsAnswer(1)];
        const result = reconcile(d, live(events));
        const reconciled = result.draft !== null ? result.draft.text === text : result.notice === prompts.draftWithdrawnNotice(text);
        // W1-R1-1: the request for terms handed back unsent while its own prompt is still pending.
        const unsent = restoreUnsent(d, live([started, presented(number), asked(1)]), { type: "answer", incarnation: "a", run: 1, prompt: 1, text: "/terms" });
        return reconciled && (unsent.draft?.text === text || unsent.quoted === text);
      }),
    );
  });
});

// Issue #185: a draft whose question expired is withdrawn with the notice of what the expiry did, its text kept.
describe("a draft whose question expired (issue #185)", () => {
  test("each expiry withdraws the draft with its own notice", () => {
    for (const then of ["abandon", "extend"] as const) {
      const key = { incarnation: "a", run: 1, prompt: 1 };
      const view = { incarnation: "a", run: { ...emptyRun(1), expired: { prompt: 1, seconds: 120, then } } } as unknown as Parameters<typeof reconcile>[1];
      const { draft, notice } = reconcile({ _tag: "Held", key, text: "my answer" }, view);
      expect(draft).toBe(null);
      expect(notice).toBe(prompts.draftExpiredNotice(then, "my answer"));
      expect(notice).toContain("my answer");
    }
    expect(prompts.draftExpiredNotice("abandon", "x")).toContain("its run has ended");
    expect(prompts.draftExpiredNotice("extend", "x")).toContain("the review went on");
  });
});

// Issue #153: the text typed before Help me decide stays in the field through the wait and to the analysis.
describe("a draft through Help me decide", () => {
  const question = (number: number): RunEvent => ({
    _tag: "Notified",
    event: { _tag: "QuestionPresented", question: { number, origin: { kind: "relayed" }, context: { blocks: [], by: "agent" }, history: [], explanations: [], question: plainPieces("Q?"), options: ["A", "B"].map((l, i) => ({ label: plainPieces(l), description: plainPieces(""), answer: { token: String(i + 1) } })), attached: null, decision: null } },
  });
  const offered = (prompt: number): RunEvent => ({ _tag: "Asked", prompt, ...promptOf(prompts.withOffer(prompts.optionOrTextPrompt)), countdown: null, deciding: null });
  const frame = (prompt: number): RunEvent => ({ _tag: "Asked", prompt, ...promptOf(prompts.optionOrTextPrompt), countdown: null, deciding: 1 });
  const plain = (prompt: number): RunEvent => ({ _tag: "Asked", prompt, ...promptOf(prompts.optionOrTextPrompt), countdown: null, deciding: null });
  const decide: RunEvent = { _tag: "Answered", prompt: 1, text: "/decide" };
  const typed = (prompt: number, text = "my text"): Draft => ({ _tag: "Held", key: { incarnation: "a", run: 1, prompt }, text });
  const base = [started, question(1), offered(1), decide];
  /** The draft reconciled through each view in turn, as the page reconciles after every reduction. */
  const through = (d: Draft, views: readonly Shown[]): Reconciled => views.reduce<Reconciled>((r, v) => (r.draft === null ? r : reconcile(r.draft, v)), { draft: d, notice: null });

  test("after Help me decide the field still shows the text, its key the same prompt", () => {
    const view = live(base);
    expect(draftFor(typed(1), pendingKey(view))).toBe("my text");
    expect(reconcile(typed(1), view)).toEqual({ draft: typed(1), notice: null });
  });

  test("the text edited while starting follows the question to its frame, and to the question asked again", () => {
    const r = through(typed(1, "edited"), [live(base), live([...base, frame(2)])]);
    expect(r).toEqual({ draft: typed(2, "edited"), notice: null });
    const again = through(r.draft!, [live([...base, frame(2), { _tag: "PromptWithdrawn", prompt: 2 }]), live([...base, frame(2), { _tag: "PromptWithdrawn", prompt: 2 }, question(1), plain(3)])]);
    expect(again).toEqual({ draft: typed(3, "edited"), notice: null });
    expect(draftFor(again.draft, pendingKey(live([...base, frame(2), { _tag: "PromptWithdrawn", prompt: 2 }, question(1), plain(3)])))).toBe("edited");
  });

  test("an answer from another tab to the frame's prompt withdraws the draft with the notice", () => {
    expect(reconcile(typed(2), live([...base, frame(2), { _tag: "Answered", prompt: 2, text: "1" }]))).toEqual({ draft: null, notice: prompts.draftWithdrawnNotice("my text") });
  });

  test("a foreground question over the frame: the frame's draft waits for its question to return", () => {
    const over = live([...base, frame(2), question(2), plain(3)]);
    expect(reconcile(typed(2), over)).toEqual({ draft: typed(2), notice: null });
    const back = live([...base, frame(2), question(2), plain(3), { _tag: "Answered", prompt: 3, text: "1" }, frame(2)]);
    expect(through(typed(2), [over, back])).toEqual({ draft: typed(2), notice: null });
  });

  test("a draft followed to another question is withdrawn with the notice when non-empty, quietly when empty", () => {
    const other = live([...base, question(2), plain(3)]);
    expect(reconcile(typed(1), other)).toEqual({ draft: null, notice: prompts.draftWithdrawnNotice("my text") });
    expect(reconcile(typed(1, ""), other)).toEqual({ draft: null, notice: null });
  });

  test("an unsent /decide leaves the field as it is and quotes nothing", () => {
    const view = live([started, question(1), offered(1)]);
    const message: ClientMessage = { type: "answer", incarnation: "a", run: 1, prompt: 1, text: "/decide" };
    expect(restoreUnsent(typed(1), view, message)).toEqual({ draft: typed(1), quoted: null });
  });

  test("awaitedKey is the pending key only while the prompt waits for the developer", () => {
    expect(awaitedKey(live([started, question(1), offered(1)]))).toEqual({ incarnation: "a", run: 1, prompt: 1 });
    expect(awaitedKey(live(base))).toBeNull();
    expect(awaitedKey(live([...base, frame(2)]))).toBeNull();
  });
});

// The unsent text of the prompt widget (finding 5 of docs/gui-review.md), pure. A draft belongs to one prompt of one run
// of one start of the server; it is reconciled against the view after every reduction, live or replayed, so that
// another tab's answer withdraws it with a notice instead of leaving it attached to the next prompt.

import { isTermsRequest } from "../../src/input.ts";
import { draftExpiredNotice, draftWithdrawnNotice } from "../../src/prompts.ts";
import type { ClientMessage } from "../../src/protocol.ts";
import type { Shown } from "./state.ts";

export type DraftKey = Readonly<{ incarnation: string; run: number; prompt: number }>;
/**
 * The text of a prompt: held for the prompt of its key, or, issue #142, carried: the text of a prompt answered by a
 * request for its question's terms, waiting for that question, by its number, to be asked again.
 */
export type Draft = Readonly<{ _tag: "Held"; key: DraftKey; text: string }> | Readonly<{ _tag: "Carried"; key: DraftKey; text: string; question: number }>;
/** The held draft of a prompt answered by a request for the terms of the question with that number (issue #142). */
export const carried = (draft: Draft, question: number): Draft => ({ _tag: "Carried", key: draft.key, text: draft.text, question });
export type Reconciled = Readonly<{ draft: Draft | null; notice: string | null }>;


/** The key of the prompt the shown run waits on, or null (issue #120: each tab's run, shownRun of web/src/state.ts). */
export const pendingKey = (view: Shown): DraftKey | null =>
  view.incarnation === null || view.run === null || view.run.pending === null ? null : { incarnation: view.incarnation, run: view.run.id, prompt: view.run.pending.asked.prompt };

/** Whether two keys name the same prompt of the same run of the same start of the server. */
export const sameKey = (a: DraftKey, b: DraftKey): boolean => a.incarnation === b.incarnation && a.run === b.run && a.prompt === b.prompt;

/** The draft's text for that key; "" for another key or no draft. */
export const draftFor = (draft: Draft | null, key: DraftKey | null): string => (draft !== null && draft._tag === "Held" && key !== null && sameKey(draft.key, key) ? draft.text : "");

/**
 * The draft after a reduction of the view, and the notice when it was withdrawn. It is kept while its prompt is
 * pending; it is withdrawn when its prompt was answered (the tab's own send clears the draft first, so that answer
 * came from another tab), or when the server or the run is another one. A non-empty draft is never dropped silently.
 */
export const reconcile = (draft: Draft | null, view: Shown): Reconciled => {
  if (draft === null) return { draft, notice: null };
  if (draft._tag === "Carried") return reconcileCarried(draft, view);
  const pending = pendingKey(view);
  if (pending !== null && sameKey(pending, draft.key)) return { draft, notice: null };
  const sameRun = view.incarnation === draft.key.incarnation && view.run !== null && view.run.id === draft.key.run;
  // Issue #185: its prompt's wait ran out: withdrawn with the notice of what the expiry did, the text kept in it.
  const expired = sameRun ? view.run!.expired : null;
  if (expired !== null && expired.prompt === draft.key.prompt) return { draft: null, notice: draft.text.trim() === "" ? null : draftExpiredNotice(expired.then, draft.text) };
  const overtaken = !sameRun || view.run!.answered.includes(draft.key.prompt);
  // A prompt neither pending nor answered in the same run (for example not yet replayed): the draft waits.
  if (!overtaken) return { draft, notice: null };
  return withdrawn(draft);
};
const withdrawn = (draft: Draft): Reconciled => ({ draft: null, notice: draft.text.trim() === "" ? null : draftWithdrawnNotice(draft.text) });
/**
 * A carried draft (issue #142): it waits while no prompt is pending or its own still is; it is held for the next prompt
 * that asks the same question again; it is withdrawn, with a notice, for another question, run or start of the server.
 */
const reconcileCarried = (draft: Extract<Draft, { _tag: "Carried" }>, view: Shown): Reconciled => {
  const sameRun = view.incarnation === draft.key.incarnation && view.run !== null && view.run.id === draft.key.run;
  if (!sameRun) return withdrawn(draft);
  const pending = pendingKey(view);
  if (pending === null || pending.prompt === draft.key.prompt) return { draft, notice: null };
  if (view.run?.pending?.question?.number === draft.question) return { draft: { _tag: "Held", key: pending, text: draft.text }, notice: null };
  return withdrawn(draft);
};

/**
 * An action the page could not send (G-R1-1, P1-R1-2 of the defects' plan). An answer to the pending prompt goes back
 * to its field when the field is empty; when the field holds other text, or the prompt is no longer pending, it is
 * quoted, to be kept apart. An answer equal to the field's text (the field was not cleared) needs neither. It never
 * replaces text typed since. Other actions carry no text.
 */
export const restoreUnsent = (draft: Draft | null, view: Shown, message: ClientMessage): Readonly<{ draft: Draft | null; quoted: string | null }> => {
  if (message.type !== "answer") return { draft, quoted: null };
  // A request for terms (issue #142, W1-R1-1) is a command, not text the user wrote: the text it carried goes back to
  // its prompt, still pending, so that the request can be made again.
  const unsentKey = { incarnation: message.incarnation, run: message.run, prompt: message.prompt };
  if (draft !== null && draft._tag === "Carried" && sameKey(draft.key, unsentKey) && isTermsRequest(message.text)) return { draft: { _tag: "Held", key: draft.key, text: draft.text }, quoted: null };
  const pending = pendingKey(view);
  const own = pending !== null && sameKey(pending, unsentKey);
  if (!own) return { draft, quoted: message.text.trim() === "" ? null : message.text };
  const current = draftFor(draft, pending);
  if (current === "") return { draft: { _tag: "Held", key: pending, text: message.text }, quoted: null };
  if (current === message.text || message.text.trim() === "") return { draft, quoted: null };
  return { draft, quoted: message.text };
};

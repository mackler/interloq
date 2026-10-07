// The widget catalog of the prompts to the user (plan step 1.3): for each text of src/prompts.ts, its fixed
// choices with the exact text each sends, whether free text is meaningful, and the quit of its input mode.
// The web page renders a prompt from this entry. Pure.

import { DECIDE } from "./input.ts";
import * as prompts from "./prompts.ts";

export type Choice = Readonly<{ label: string; sends: string }>;
export type PromptKind = "decision" | "limit" | "limitNoProceed" | "unchanged" | "transport" | "execInput" | "optionOrText" | "permission" | "interviewMessage" | "confirmSummary" | "unknown";
/**
 * The widget of a prompt (S8): its kind, recognized by the prompt's fixed hint; the controls that are not options of the
 * question (continuing without a decision, finishing the clarification, confirming, starting, the offer, ending the run);
 * whether free text is meaningful; and the quit of its input mode. The options themselves come with the question
 * (`QuestionPresented`), each with the answer that chooses it.
 */
export type UserPrompt = Readonly<{
  kind: PromptKind;
  text: string;
  /** `ask` prompts quit on "q" (parseAskLine), `message` prompts on "/quit" (parseMessage). */
  mode: "ask" | "message";
  choices: readonly Choice[];
  free: "none" | "line" | "message";
}>;

const QUIT_ASK: Choice = { label: prompts.END_RUN_LABEL, sends: "q" };
const QUIT_MESSAGE: Choice = { label: prompts.END_RUN_LABEL, sends: "/quit" };
const entry = (kind: PromptKind, text: string, mode: UserPrompt["mode"], choices: readonly Choice[], free: UserPrompt["free"]): UserPrompt => ({
  kind,
  text,
  mode,
  choices: [...choices, mode === "ask" ? QUIT_ASK : QUIT_MESSAGE],
  free,
});

/** Each kind's hint, a fixed text of src/prompts.ts (S8): the one source of the text a prompt carries and the page recognizes. */
export const HINTS: Readonly<Record<Exclude<PromptKind, "unknown">, string>> = {
  decision: prompts.decisionPrompt,
  limit: prompts.limitPrompt,
  limitNoProceed: prompts.limitNoProceedPrompt,
  unchanged: prompts.unchangedPrompt,
  transport: prompts.transportPrompt,
  execInput: prompts.execInputPrompt,
  optionOrText: prompts.optionOrTextPrompt,
  permission: prompts.permissionPrompt,
  interviewMessage: prompts.interviewMessagePrompt,
  confirmSummary: prompts.confirmSummaryPrompt,
};

const FIXED: ReadonlyMap<string, (text: string) => UserPrompt> = new Map([
  [HINTS.decision, (t: string) => entry("decision", t, "ask", [{ label: prompts.CONTINUE_WITHOUT_DECIDING, sends: "" }], "line")],
  [HINTS.limit, (t: string) => entry("limit", t, "ask", [], "line")],
  [HINTS.limitNoProceed, (t: string) => entry("limitNoProceed", t, "ask", [], "line")],
  [HINTS.unchanged, (t: string) => entry("unchanged", t, "ask", [], "none")],
  [HINTS.transport, (t: string) => entry("transport", t, "ask", [], "none")],
  [HINTS.execInput, (t: string) => entry("execInput", t, "ask", [], "line")],
  [HINTS.optionOrText, (t: string) => entry("optionOrText", t, "ask", [], "line")],
  [HINTS.permission, (t: string) => entry("permission", t, "ask", [], "none")],
  [HINTS.interviewMessage, (t: string) => entry("interviewMessage", t, "message", [{ label: prompts.END_CLARIFICATION, sends: "/done" }], "message")],
  [HINTS.confirmSummary, (t: string) => entry("confirmSummary", t, "message", [{ label: prompts.CONFIRM_SUMMARY_LABEL, sends: "" }], "message")],
]);

/**
 * The widget of a prompt text. Total: a text that is not in the catalog is free text plus Quit. A text with the offer
 * line (decision support, D1) is the entry of the rest with "Help me decide" before Quit.
 */
export const promptOf = (text: string): UserPrompt => {
  const offer = prompts.withoutOffer(text);
  if (!offer.offered) return promptOfText(text);
  const entry = promptOfText(offer.text);
  const quit = entry.choices[entry.choices.length - 1];
  return { ...entry, text, choices: [...entry.choices.slice(0, -1), { label: prompts.HELP_ME_DECIDE, sends: DECIDE }, quit] };
};

const promptOfText = (text: string): UserPrompt => FIXED.get(text)?.(text) ?? entry("unknown", text, "ask", [], "line");

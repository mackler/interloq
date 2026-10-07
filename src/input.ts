// Pure interpretation of what the user types. No I/O; used by the page's Ui, the scripted Ui and the agent adapters.

import { LIMIT_ANSWERS, TRANSPORT_ANSWERS, UNCHANGED_ANSWERS } from "./prompts.ts";
import type { PromptKind } from "./userPrompts.ts";

/**
 * The option a reply chooses, as a zero-based index, or null when the reply is not a whole number in
 * 1..count. Only the entire (trimmed) reply counts: "1 please explain" and "1.5" are free text
 * (finding 18 of docs/functional-design-review.md).
 */
/** What a line typed at a one-line prompt means: the run ends on "q", anything else is the (trimmed) answer. */
export const parseAskLine = (line: string): { kind: "quit" } | { kind: "answer"; text: string } => {
  const text = line.trim();
  return text === "q" ? { kind: "quit" } : { kind: "answer", text };
};

/** What a message of the interview means: the run ends on "/quit", anything else is the (trimmed) message. */
export const parseMessage = (message: string): { kind: "quit" } | { kind: "message"; text: string } => {
  const text = message.trim();
  return text === "/quit" ? { kind: "quit" } : { kind: "message", text };
};

/**
 * The number of rounds the answer at the round limit adds, or null when the answer is not a whole number
 * in 1..2^31-1 (finding 5: a longer integer overflowed the limit).
 */
export const parseExtraRounds = (reply: string): number | null => {
  const trimmed = reply.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed) || trimmed.length > 10) return null;
  const value = Number(trimmed);
  return value <= 2 ** 31 - 1 ? value : null;
};

/** The answer at the pause of issue #30 (prompts.unchangedPrompt): its letter or its word; anything else is no answer. */
export const parseUnchangedAnswer = (reply: string): "retry" | "proceed" | "stop" | null => {
  const t = reply.trim().toLowerCase();
  const answers = ["retry", "proceed", "stop"] as const;
  return answers.find((a) => t === UNCHANGED_ANSWERS[a] || t === a) ?? null;
};

/** The answer at the pause of issue #26 (prompts.transportPrompt): its letter or its word; anything else is no answer. */
export const parseTransportAnswer = (reply: string): "retry" | "stop" | null => {
  const t = reply.trim().toLowerCase();
  const answers = ["retry", "stop"] as const;
  return answers.find((a) => t === TRANSPORT_ANSWERS[a] || t === a) ?? null;
};

export const chooseOption = (reply: string, count: number): number | null => {
  const trimmed = reply.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return null;
  const index = Number(trimmed) - 1;
  return index < count ? index : null;
};

/** What a message of the interview means beyond quitting: nothing, the end of the interview, or text. */
export const parseInterviewMessage = (message: string): { kind: "empty" } | { kind: "done" } | { kind: "text"; text: string } => {
  const text = message.trim();
  if (text === "") return { kind: "empty" };
  if (text === "/done") return { kind: "done" };
  return { kind: "text", text };
};

// ---- decision support ---------------------------------------------------------------------------

/** The offer's command (D1 of the decision-support plan): "Help me decide" sends it, and a user may type it. */
export const DECIDE = "/decide";
export const isDecide = (text: string): boolean => text.trim() === DECIDE;

/** The text a reply stands for when it chooses one of the options by number ("label: description"); any other reply is itself. */
export const answerOf = (reply: string, options: readonly Readonly<{ label: string; description: string }>[]): string => {
  const chosen = chooseOption(reply, options.length);
  if (chosen === null) return reply;
  const option = options[chosen];
  return option.description === "" ? option.label : `${option.label}: ${option.description}`;
};

// ---- the answers that end the run (S24, issue #25) -----------------------------------------------------------------

/**
 * Whether an answer at the cycle limit stops the run (P2-R1-1): every answer that is neither an offered p nor a count
 * of cycles parseExtraRounds accepts; the review loop halts on exactly these (onLimitAnswer in src/reviewState.ts), and
 * the Stop option of limitOptions in src/offer.ts matches them.
 */
export const limitStops = (answer: string, proceedOffered: boolean): boolean => !(proceedOffered && answer.trim() === LIMIT_ANSWERS.proceed) && parseExtraRounds(answer) === null;
/** How an answer ends the run: End the run (q, /quit), Stop at the cycle limit, or not at all (null). */
export type Ending = "endRun" | "limitStop";
export const endingOf = (kind: PromptKind, mode: "ask" | "message", text: string): Ending | null => {
  const t = text.trim();
  if (mode === "ask" ? t === "q" : t === "/quit") return "endRun";
  if ((kind === "limit" || kind === "limitNoProceed") && !isDecide(t) && limitStops(t, kind === "limit")) return "limitStop";
  return null;
};
/** Whether an answer ends the run, and so is confirmed first, in the page (ConfirmEndDialog). */
export const endsRun = (kind: PromptKind, mode: "ask" | "message", text: string): boolean => endingOf(kind, mode, text) !== null;
/** The reply to a confirmation: y confirms; anything else returns to the question. */
export const parseConfirmEnd = (reply: string): boolean => reply.trim().toLowerCase() === "y";

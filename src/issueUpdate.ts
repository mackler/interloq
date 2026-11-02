// What Bring Up to Date may change in the developer's title and text, and what it may not (issue #216): the passages of
// his own that a check on data can find, the protection baseline that advances only through what Claude Code declared
// and what his answers decided, the validation of a response and of the application of decisions, and the phase's
// outcome. Pure.
import { Result } from "effect";
import { PassageMissing } from "./errors.ts";
import { passageRepairPrompt, type IssueTextProblem } from "./prompts.ts";
import { itemTextOf, type ItemText } from "./refinement.ts";
import { bothValidations, userQuestionsValidation, type Validation } from "./review.ts";
import type { IssueFile, UpdateResponse, UpdateWrite } from "./schema.ts";

type TitleAndText = Readonly<{ title: string; text: string }>;

/** Whether a passage stands verbatim in the title or in the text. */
export const occursIn = (passage: string, t: TitleAndText): boolean => t.title.includes(passage) || t.text.includes(passage);

const unique = (xs: readonly string[]): readonly string[] => [...new Set(xs)];

/**
 * What a check on data can find of the developer's own words: every block-quote line (its first character other than a
 * space is `>`), and every span inside “…” or "…" holding a space (a quoted phrase, not a quoted identifier).
 */
export const protectedPassagesOf = (text: string): readonly string[] => {
  const quoteLines = text.split(/\r\n|\r|\n/u).filter((line) => /^\s*>/u.test(line));
  const phrases = [...text.matchAll(/“[^”\n]*”|"[^"\n]*"/gu)].map((m) => m[0]).filter((q) => /\s/u.test(q));
  return unique([...quoteLines, ...phrases]);
};

/** The protection baseline's start: the passages of the title and of the text, as read. */
export const initialProtection = (before: TitleAndText): readonly string[] => unique([...protectedPassagesOf(before.title), ...protectedPassagesOf(before.text)]);

/** The issue as read and the passages the title or text must keep verbatim at this point of the loop. */
export type Protection = Readonly<{ before: TitleAndText; protected: readonly string[] }>;

const touches = (a: string, b: string): boolean => a.includes(b) || b.includes(a);

/** The checks a response and an application share, given which passages may be missing and which declared ones are the developer's. */
const problemsOf = (
  reply: Readonly<{ issue: TitleAndText; outcome: UpdateResponse["outcome"]; developer_passages: readonly string[] }>,
  p: Protection,
  mayBeMissing: (passage: string) => boolean,
  givenByAnswer: readonly string[],
): readonly IssueTextProblem[] => {
  const text = itemTextOf(reply.issue.title, reply.issue.text);
  return [
    ...(Result.isFailure(text) ? [{ kind: "invalidText" as const, subject: text.failure.reason }] : []),
    ...(reply.outcome.kind === "obsolete" && reply.outcome.reason.trim() === "" ? [{ kind: "blankReason" as const, subject: "" }] : []),
    ...reply.developer_passages.flatMap((passage): IssueTextProblem[] => {
      if (passage.trim() === "") return [{ kind: "blankPassage", subject: "" }];
      if (!occursIn(passage, reply.issue)) return [{ kind: "passageNotInReply", subject: passage }];
      return occursIn(passage, p.before) || p.protected.includes(passage) || givenByAnswer.includes(passage) ? [] : [{ kind: "notTheDevelopers", subject: passage }];
    }),
    ...p.protected.filter((passage) => !occursIn(passage, reply.issue) && !mayBeMissing(passage)).map((passage) => ({ kind: "protectedMissing" as const, subject: passage })),
  ];
};

const checked = <T>(output: T, problems: readonly IssueTextProblem[]) =>
  problems.length === 0 ? Result.succeed({ value: output, notes: [] }) : Result.fail({ error: new PassageMissing({ problems }), repair: passageRepairPrompt(problems) });

/** A response or corrective turn: every protected passage kept, every declared passage the developer's already. */
export const issueUpdateValidation = (p: Protection): Validation<UpdateResponse> =>
  bothValidations((output: UpdateResponse) => checked(output, problemsOf(output, p, () => false, [])), userQuestionsValidation<UpdateResponse>());

/**
 * The application of the developer's answers: as a response, except that a protected passage a decision touches may
 * go, each decision's `before` stood in the issue before the call and its `after` stands in the reply, and a decided
 * `after` is the developer's.
 */
export const issueApplyValidation = (p: Protection, current: TitleAndText): Validation<UpdateWrite> =>
  bothValidations((output: UpdateWrite) => {
    const befores = output.decided.map((d) => d.before);
    const afters = output.decided.map((d) => d.after).filter((a) => a !== "");
    const decidedProblems = output.decided.flatMap((d): IssueTextProblem[] => [
      ...(d.before.trim() === "" || !occursIn(d.before, current) ? [{ kind: "decidedBeforeMissing" as const, subject: d.before }] : []),
      ...(d.after !== "" && !occursIn(d.after, output.issue) ? [{ kind: "decidedAfterMissing" as const, subject: d.after }] : []),
    ]);
    return checked(output, [...decidedProblems, ...problemsOf(output, p, (passage) => befores.some((b) => b.trim() !== "" && touches(passage, b)), afters)]);
  }, userQuestionsValidation<UpdateWrite>());

/** The baseline after a response: the declared passages added. */
export const protectionAfterResponse = (p: Protection, reply: UpdateResponse): readonly string[] => unique([...p.protected, ...reply.developer_passages]);

/** The baseline after the developer's decisions: each passage a decision touches dropped, then its new wording and the declared passages added. */
export const protectionAfterDecisions = (p: Protection, write: UpdateWrite): readonly string[] => {
  const befores = write.decided.map((d) => d.before).filter((b) => b.trim() !== "");
  return unique([...p.protected.filter((passage) => !befores.some((b) => touches(passage, b))), ...write.decided.map((d) => d.after).filter((a) => a !== ""), ...write.developer_passages]);
};

/** What the phase leaves: nothing to write, the amended title and text, the whole issue built or replaced, or no agreement. */
export type UpdateOutcome = Readonly<{ _tag: "Unchanged" }> | Readonly<{ _tag: "Amended"; text: ItemText }> | Readonly<{ _tag: "Obsolete"; reason: string }> | Readonly<{ _tag: "NotAgreed" }>;

/**
 * The outcome of the loop: agreed and obsolete is Obsolete; agreed with the title and text as read is Unchanged (where
 * the first check raised nothing, and where every change was withdrawn); agreed otherwise Amended; the round limit's
 * proceed choice NotAgreed, so nothing is written.
 */
export const updateOutcomeOf = (before: TitleAndText, file: IssueFile, ended: "agreed" | "notAgreed"): UpdateOutcome => {
  if (ended === "notAgreed") return { _tag: "NotAgreed" };
  if (file.outcome.kind === "obsolete") return { _tag: "Obsolete", reason: file.outcome.reason };
  if (file.title === before.title && file.text === before.text) return { _tag: "Unchanged" };
  const text = itemTextOf(file.title, file.text);
  // issue.json is written only from a validated reply, so its title and text are an ItemText; a hand-edited file is not.
  return Result.isSuccess(text) ? { _tag: "Amended", text: text.success } : { _tag: "NotAgreed" };
};

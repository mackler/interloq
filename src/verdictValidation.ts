// The validations of Claude Code's verdict that an item is not refined (issue #186), beyond its schema: pure. Each
// failure gets the validation repair turn of behavior 10, whose prompt comes from src/prompts.ts with the halt's text.
import { Result } from "effect";
import { VerdictInvalid } from "./errors.ts";
import { verdictRepairPrompt } from "./prompts.ts";
import type { Validation } from "./review.ts";

/** A verdict whose 'missing' has no character other than whitespace is refused. */
export const verdictValidation =
  <T extends Readonly<{ missing: string }>>(): Validation<T> =>
  (output) =>
    output.missing.trim() === "" ? Result.fail({ error: new VerdictInvalid({ problem: "blankMissing" }), repair: verdictRepairPrompt("blankMissing") }) : Result.succeed({ value: output, notes: [] });

/** A response to a review of the verdict asks the developer nothing: the verdict states what he must settle. */
export const noQuestionsValidation =
  <T extends Readonly<{ questions_for_user: readonly unknown[] }>>(): Validation<T> =>
  (output) =>
    output.questions_for_user.length > 0 ? Result.fail({ error: new VerdictInvalid({ problem: "questionsAsked" }), repair: verdictRepairPrompt("questionsAsked") }) : Result.succeed({ value: output, notes: [] });

// The Ui of an unattended preparation (issue #131): no one answers it, and it never answers on the developer's behalf
// (requirements: a review that stops for him sets the item aside). An edge only in that it holds a Ref.
import { Effect, Ref } from "effect";
import { type AskedQuestion, NoAnswer } from "./errors.ts";
import { piecesText } from "./pieces.ts";
import type { UiShape } from "./services.ts";

export type UnattendedUi = Readonly<{ ui: UiShape; lastQuestion: Effect.Effect<AskedQuestion | null> }>;

/**
 * Every question fails at once with NoAnswer whose `then` is "abandon", whatever expiry it was asked with: the review
 * loop turns only a NoAnswer with "extend" into an extension of a round or idle limit (behavior 7, issue #185), so a
 * limit's question ends the preparation instead of extending it unattended. The question named is the one last
 * presented (QuestionPresented), its text as pieces give it; `say` and the other events reach no page, since a
 * preparation has no run view. A question's frame runs its work and returns Done: it is reached only through Help me
 * decide, which no one can choose here.
 */
export const unattendedUi: Effect.Effect<UnattendedUi> = Effect.gen(function* () {
  const last = yield* Ref.make<AskedQuestion | null>(null);
  const numbers = yield* Ref.make(0);
  const unanswered = (prompt: string) =>
    Effect.flatMap(Ref.get(last), (question) => Effect.fail(new NoAnswer({ where: prompt.split(/\r\n|\r|\n/u)[0] ?? "", seconds: 0, question, then: "abandon" })));
  const ui: UiShape = {
    say: () => Effect.void,
    output: () => Effect.void,
    ask: (prompt) => unanswered(prompt),
    askMessage: (prompt) => unanswered(prompt),
    notify: (event) => (event._tag === "QuestionPresented" ? Ref.set(last, { number: event.question.number, text: piecesText(event.question.question) }) : Effect.void),
    nextQuestion: Ref.updateAndGet(numbers, (n) => n + 1),
    enterQuestion: () => Effect.succeed({ askDuring: (_prompt, _kind, work) => Effect.map(work, (value) => ({ _tag: "Done" as const, value })) }),
  };
  return { ui, lastQuestion: Ref.get(last) };
});

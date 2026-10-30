// Whether a refinement run presented the developer any question (issue #186, requirements Q5): the record its item
// carries, which the send-back's guard reads. Every question reaches the user as one QuestionPresented event
// (askOffering of src/offer.ts), so a Ui that notes that event is the one place that knows.
import { Effect, Ref } from "effect";
import type { UiShape } from "./services.ts";

/** The Ui with every call passed through, and `seen` set by each QuestionPresented it notifies. */
export const observingQuestions = (ui: UiShape, seen: Ref.Ref<boolean>): UiShape => ({
  // Each member read from the Ui, not spread: a Ui may be a class whose members are on its prototype.
  say: (text) => ui.say(text),
  ask: (prompt) => ui.ask(prompt),
  askMessage: (prompt) => ui.askMessage(prompt),
  nextQuestion: Effect.suspend(() => ui.nextQuestion),
  enterQuestion: (question) => ui.enterQuestion(question),
  output: (event) => ui.output(event),
  notify: (event) => (event._tag === "QuestionPresented" ? Effect.andThen(Ref.set(seen, true), ui.notify(event)) : ui.notify(event)),
});

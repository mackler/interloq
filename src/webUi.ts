// The Ui of a run in the web page (plan step 3.2): every call becomes a RunEvent for the page, and a prompt waits
// for the first answer any tab sends for it. The answers are interpreted by src/input.ts.
//
// Issue #185: a prompt of an implementation run in a chain counts down on the server's clock (`AnswerTiming`). Its wait
// is carried in the Asked event, so the page counts down exactly the length timed here. The wait ends with an answer,
// with the developer's hold (the countdown stops for good), with the end of the chain's claim on the run (it then waits
// as before), or with its expiry: AnswerExpired is published and the ask fails with NoAnswer. The deadline is enforced
// by every operation that reaches the prompt, not only by its timer, which may run late on a loaded server.

import { Clock, Deferred, Duration, Effect, Ref, Semaphore } from "effect";
import { type AskedQuestion, NoAnswer, UserStopped } from "./errors.ts";
import { isDecide, isTermsRequest, parseAskLine, parseMessage } from "./input.ts";
import { piecesText } from "./pieces.ts";
import type { Asked, OnExpiry, RunEvent } from "./protocol.ts";
import type { UiShape } from "./services.ts";
import { promptOf } from "./userPrompts.ts";

/**
 * Issue #185: how long a question of the run waits for an answer, read at each prompt and again at its deadline: null
 * means as long as it takes (not the chain's running run, or a refinement run).
 */
export type AnswerTiming = Readonly<{ limitMs: Effect.Effect<number | null> }>;
export const NO_TIMING: AnswerTiming = { limitMs: Effect.succeed(null) };

/** What became of an answer sent to a prompt (issue #185): taken, no such prompt waits, or that prompt's wait ran out. */
export type AnswerResult = "taken" | "notWaiting" | Readonly<{ _tag: "expired"; then: OnExpiry }>;

/** The web Ui of one run: the Ui, and the entry points of the answers from the page. */
export type WebUi = UiShape &
  Readonly<{
    /** The answer to a pending prompt; `notWaiting` when no prompt with that number waits (answered, interrupted, or never asked). */
    answer: (prompt: number, text: string) => Effect.Effect<AnswerResult>;
    /** Issue #185: the developer is working on the prompt; false when it does not wait, does not count down, or its wait ran out. */
    hold: (prompt: number) => Effect.Effect<boolean>;
    /** The prompt that waits, if any. */
    pending: Effect.Effect<Asked | null>;
  }>;

type Waiting = Readonly<{ asked: Asked; answer: Deferred.Deferred<string, NoAnswer>; held: boolean; where: string; question: AskedQuestion | null }>;
type Prompts = Readonly<{
  next: number;
  waiting: Waiting | null;
  /** Issue #185: the prompts whose wait ran out, with what their expiry did, so a late answer is told so. */
  expired: ReadonlyMap<number, OnExpiry>;
  /** Issue #185: the last answer asked for an analysis or the terms (/decide, /terms): the next prompt starts held. */
  carryHold: boolean;
  /** Issue #185: the last question presented, which a NoAnswer names. */
  lastPresented: AskedQuestion | null;
}>;

const secondsOf = (countdown: NonNullable<Asked["countdown"]>): number => Math.round((countdown.untilMs - countdown.fromMs) / 1000);

/** `sink` must not block: it records and offers the event (src/runManager.ts, makePublisher), so the answer's protected step stays short. */
export const makeWebUi = (sink: (event: RunEvent) => Effect.Effect<void>, timing: AnswerTiming = NO_TIMING): Effect.Effect<WebUi> =>
  Effect.gen(function* () {
    // The dialogue is serialized: a second concurrent prompt waits for the first answer, and is timed only when shown.
    const dialogue = yield* Semaphore.make(1);
    const prompts = yield* Ref.make<Prompts>({ next: 1, waiting: null, expired: new Map(), carryHold: false, lastPresented: null });
    const questions = yield* Ref.make(0);

    /** The prompt's wait has run out (decided in a Ref.modify): recorded as expired and withdrawn. */
    const expiring = (p: Prompts, w: Waiting): Prompts => ({ ...p, waiting: null, expired: new Map(p.expired).set(w.asked.prompt, w.asked.countdown!.then) });
    /** Publishes the expiry of a prompt already withdrawn and fails its ask. */
    const expire = (w: Waiting): Effect.Effect<void> =>
      Effect.gen(function* () {
        const countdown = w.asked.countdown!;
        const seconds = secondsOf(countdown);
        yield* sink({ _tag: "AnswerExpired", prompt: w.asked.prompt, seconds, then: countdown.then });
        yield* Deferred.fail(w.answer, new NoAnswer({ where: w.where, seconds, question: w.question, then: countdown.then }));
      });
    /** Whether the prompt counts down, unheld, and its deadline has passed at `now`. */
    const due = (w: Waiting, now: number): boolean => w.asked.countdown !== null && !w.held && now >= w.asked.countdown.untilMs;

    /** The timer's end: the prompt expires, or, where the run no longer counts down, it waits as before. */
    const deadline = (prompt: number): Effect.Effect<void> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const limit = yield* timing.limitMs;
          const action = yield* Ref.modify(prompts, (p): readonly [Readonly<{ _tag: "none" }> | Readonly<{ _tag: "expire" | "stop"; w: Waiting }>, Prompts] => {
            const w = p.waiting;
            if (w === null || w.asked.prompt !== prompt || w.held || w.asked.countdown === null) return [{ _tag: "none" }, p];
            return limit === null ? [{ _tag: "stop", w }, { ...p, waiting: { ...w, held: true } }] : [{ _tag: "expire", w }, expiring(p, w)];
          });
          if (action._tag === "expire") yield* expire(action.w);
          if (action._tag === "stop") yield* sink({ _tag: "CountdownStopped", prompt, reason: "chainOff" });
        }),
      );

    /** Shows the prompt and waits for its first answer, or its expiry; an interruption withdraws the prompt. */
    const waitFor = (text: string, onExpiry: OnExpiry): Effect.Effect<string, NoAnswer> =>
      Effect.gen(function* () {
        const answer = yield* Deferred.make<string, NoAnswer>();
        const limit = yield* timing.limitMs;
        const now = yield* Clock.currentTimeMillis;
        const asked = yield* Ref.modify(prompts, (p): readonly [Asked, Prompts] => {
          const countdown = limit !== null && !p.carryHold ? { fromMs: now, untilMs: now + limit, then: onExpiry } : null;
          const shown: Asked = { _tag: "Asked", prompt: p.next, ...promptOf(text), countdown };
          return [shown, { ...p, next: p.next + 1, carryHold: false, waiting: { asked: shown, answer, held: countdown === null, where: text, question: p.lastPresented } }];
        });
        yield* sink(asked);
        const wait = Deferred.await(answer).pipe(
          Effect.onInterrupt(() => Ref.update(prompts, (p) => (p.waiting?.asked.prompt === asked.prompt ? { ...p, waiting: null } : p))),
        );
        if (asked.countdown === null) return yield* wait;
        const timer = Effect.sleep(Duration.millis(Math.max(0, asked.countdown.untilMs - now))).pipe(Effect.andThen(deadline(asked.prompt)));
        // The timer lives as long as the wait: an answer, a hold or an interruption ends it with the scope.
        return yield* Effect.scoped(Effect.forkScoped(timer).pipe(Effect.andThen(wait)));
      }).pipe(dialogue.withPermits(1));

    const ask = (text: string, onExpiry: OnExpiry = "abandon"): Effect.Effect<string, UserStopped | NoAnswer> =>
      waitFor(text, onExpiry).pipe(
        Effect.flatMap((line) => {
          const parsed = parseAskLine(line);
          return parsed.kind === "quit" ? Effect.fail(new UserStopped({ where: text })) : Effect.succeed(parsed.text);
        }),
      );
    const askMessage = (text: string, onExpiry: OnExpiry = "abandon"): Effect.Effect<string, UserStopped | NoAnswer> =>
      waitFor(text, onExpiry).pipe(
        Effect.flatMap((message) => {
          const parsed = parseMessage(message);
          return parsed.kind === "quit" ? Effect.fail(new UserStopped({ where: text })) : Effect.succeed(parsed.text);
        }),
      );

    return {
      say: (text) => sink({ _tag: "Said", text }),
      notify: (event) =>
        (event._tag === "QuestionPresented" ? Ref.update(prompts, (p) => ({ ...p, lastPresented: { number: event.question.number, text: piecesText(event.question.question) } })) : Effect.void).pipe(
          Effect.andThen(sink({ _tag: "Notified", event })),
        ),
      nextQuestion: Ref.updateAndGet(questions, (n) => n + 1),
      ask,
      askMessage,
      // The take, the Answered event and the completion of the prompt are one uninterruptible step (finding 11 of
      // docs/gui-review.md): an interruption cannot leave a prompt taken but its asking fiber unresolved. Issue #185: an
      // answer that reaches a prompt past its deadline expires it, whether or not its timer has run.
      answer: (prompt, text) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const limit = yield* timing.limitMs;
            type Taken = Readonly<{ _tag: "take" | "expire"; w: Waiting }> | Readonly<{ _tag: "was"; then: OnExpiry }> | Readonly<{ _tag: "none" }>;
            const taken = yield* Ref.modify(prompts, (p): readonly [Taken, Prompts] => {
              const w = p.waiting;
              if (w !== null && w.asked.prompt === prompt) {
                if (due(w, now) && limit !== null) return [{ _tag: "expire", w }, expiring(p, w)];
                // /decide and /terms present the same question again: the developer is at the page, so it starts held.
                return [{ _tag: "take", w }, { ...p, waiting: null, carryHold: isDecide(text) || isTermsRequest(text) }];
              }
              const then = p.expired.get(prompt);
              return then === undefined ? [{ _tag: "none" }, p] : [{ _tag: "was", then }, p];
            });
            switch (taken._tag) {
              case "none":
                return "notWaiting";
              case "was":
                return { _tag: "expired", then: taken.then };
              case "expire":
                yield* expire(taken.w);
                return { _tag: "expired", then: taken.w.asked.countdown!.then };
              case "take":
                yield* sink({ _tag: "Answered", prompt, text });
                yield* Deferred.succeed(taken.w.answer, text);
                return "taken";
            }
          }),
        ),
      hold: (prompt) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const held = yield* Ref.modify(prompts, (p): readonly [boolean, Prompts] => {
              const w = p.waiting;
              if (w === null || w.asked.prompt !== prompt || w.held || w.asked.countdown === null || due(w, now)) return [false, p];
              return [true, { ...p, waiting: { ...w, held: true } }];
            });
            if (held) yield* sink({ _tag: "CountdownStopped", prompt, reason: "held" });
            return held;
          }),
        ),
      pending: Ref.get(prompts).pipe(Effect.map((p) => p.waiting?.asked ?? null)),
    };
  });

// The Ui of a run in the web page (plan step 3.2): every call becomes a RunEvent for the page, and a prompt waits
// for the first answer any tab sends for it. The answers are interpreted by src/input.ts.
//
// Issue #153: a question whose decision is being prepared stays open beside it in a frame (`enterQuestion`), outside
// the serialized dialogue; the frames form a stack, and the one publication rule (`reshown`) shows a frame again when
// nothing stands over it any more.
//
// Issue #185: a prompt of an implementation run in a chain counts down on the server's clock (`AnswerTiming`). Its wait
// is carried in the Asked event, so the page counts down exactly the length timed here. The wait ends with an answer,
// with the developer's hold (the countdown stops for good), with the end of the chain's claim on the run (it then waits
// as before), or with its expiry: AnswerExpired is published and the ask fails with NoAnswer. The deadline is enforced
// by every operation that reaches the prompt, not only by its timer, which may run late on a loaded server.

import { Clock, Deferred, Duration, Effect, Ref, Semaphore } from "effect";
import type { Scope } from "effect";
import { type AskedQuestion, NoAnswer, UserStopped } from "./errors.ts";
import { isDecide, isTermsRequest, parseAskLine, parseMessage } from "./input.ts";
import { piecesText } from "./pieces.ts";
import type { Asked, OnExpiry, RunEvent } from "./protocol.ts";
import type { AskKind, DuringAnswer, QuestionFrame, UiShape } from "./services.ts";
import { promptOf } from "./userPrompts.ts";
import type { OutputEvent } from "./liveOutput.ts";

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
/**
 * Issue #153: a question open beside its decision. `asking`: entered and not open, which blocks every frame beneath it;
 * `preparing`: its prompt shown (where nothing stands over it) and answerable while the decision is prepared;
 * `answered` and `analyzed`: its prompt taken or withdrawn, still blocking, until its Scope closes.
 */
type FrameState = Readonly<{ _tag: "asking" }> | Readonly<{ _tag: "preparing" | "answered" | "analyzed"; asked: Asked; answer: Deferred.Deferred<string> }>;
type Frame = Readonly<{ id: number; question: number; state: FrameState }>;
type Prompts = Readonly<{
  next: number;
  waiting: Waiting | null;
  /** Issue #153: the questions open beside their decisions, innermost last. */
  frames: readonly Frame[];
  nextFrame: number;
  /** Issue #185: the prompts whose wait ran out, with what their expiry did, so a late answer is told so. */
  expired: ReadonlyMap<number, OnExpiry>;
  /** Issue #185: the numbers of the questions answered /decide or /terms and not yet presented again, each of which starts held when
   * it is (W1-R1-3); kept per question, so a decision inside a decision keeps both (work review 3 of issue #185, W3-R1-1). */
  carryHold: ReadonlySet<number>;
  /** Issue #185: the last question presented, which a NoAnswer names. */
  lastPresented: AskedQuestion | null;
}>;

/** The set without one number, the set given never changed. */
const withoutNumber = (set: ReadonlySet<number>, n: number): ReadonlySet<number> => new Set([...set].filter((m) => m !== n));

/**
 * Issue #153: the prompt shown, the only one answerable: the foreground prompt that waits, else the innermost frame's
 * where it is open; a frame in any other state blocks every frame beneath it.
 */
const shownOf = (p: Prompts): Asked | null => {
  if (p.waiting !== null) return p.waiting.asked;
  const top = p.frames[p.frames.length - 1];
  return top !== undefined && top.state._tag === "preparing" ? top.state.asked : null;
};
/**
 * Issue #153, the one publication rule: after a transition, a frame's prompt that is now shown and was not before is
 * published again (the same Asked, its number unchanged), so the page follows which prompt is shown.
 */
const reshown = (before: Prompts, after: Prompts): Asked | null => {
  const now = shownOf(after);
  if (now === null || after.waiting !== null) return null;
  return shownOf(before)?.prompt === now.prompt ? null : now;
};
/** A frame of the stack changed, the others kept. */
const withFrame = (p: Prompts, id: number, change: (f: Frame) => Frame): Prompts => ({ ...p, frames: p.frames.map((f) => (f.id === id ? change(f) : f)) });

const secondsOf = (countdown: NonNullable<Asked["countdown"]>): number => Math.round((countdown.untilMs - countdown.fromMs) / 1000);

/** `sink` must not block: it records and offers the event (src/runManager.ts, makePublisher), so the answer's protected step stays short. */
/** Issue #49: `live` receives the Ui's output events, which never reach `sink`, so nothing of them is recorded. */
export const makeWebUi = (sink: (event: RunEvent) => Effect.Effect<void>, timing: AnswerTiming = NO_TIMING, live: (event: OutputEvent) => Effect.Effect<void> = () => Effect.void): Effect.Effect<WebUi> =>
  Effect.gen(function* () {
    // The dialogue is serialized: a second concurrent prompt waits for the first answer, and is timed only when shown.
    const dialogue = yield* Semaphore.make(1);
    const prompts = yield* Ref.make<Prompts>({ next: 1, waiting: null, frames: [], nextFrame: 1, expired: new Map(), carryHold: new Set<number>(), lastPresented: null });
    const questions = yield* Ref.make(0);
    /** Issue #153: a frame's prompt shown again by a transition, published after it. */
    const republish = (asked: Asked | null): Effect.Effect<void> => (asked === null ? Effect.void : sink(asked));
    /** Issue #153: a transition of the prompts with the publication rule applied to it. */
    const transition = <A>(f: (p: Prompts) => readonly [A, Prompts]): Effect.Effect<readonly [A, Asked | null]> =>
      Ref.modify(prompts, (p): readonly [readonly [A, Asked | null], Prompts] => {
        const [a, after] = f(p);
        return [[a, reshown(p, after)], after];
      });

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
          const [action, shown] = yield* transition((p): readonly [Readonly<{ _tag: "none" }> | Readonly<{ _tag: "expire" | "stop"; w: Waiting }>, Prompts] => {
            const w = p.waiting;
            if (w === null || w.asked.prompt !== prompt || w.held || w.asked.countdown === null) return [{ _tag: "none" }, p];
            return limit === null ? [{ _tag: "stop", w }, { ...p, waiting: { ...w, held: true } }] : [{ _tag: "expire", w }, expiring(p, w)];
          });
          if (action._tag === "expire") yield* expire(action.w);
          yield* republish(shown);
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
          // W1-R1-3: only a prompt presenting a question answered /decide or /terms again starts held, and clears that question's
          // carry; a question asked in between counts down and keeps the others (kept per question: work review 3 of issue #185, W3-R1-1).
          const carried = p.lastPresented !== null && p.carryHold.has(p.lastPresented.number);
          const countdown = limit !== null && !carried ? { fromMs: now, untilMs: now + limit, then: onExpiry } : null;
          const shown: Asked = { _tag: "Asked", prompt: p.next, ...promptOf(text), countdown, deciding: null };
          return [shown, { ...p, next: p.next + 1, carryHold: carried && p.lastPresented !== null ? withoutNumber(p.carryHold, p.lastPresented.number) : p.carryHold, waiting: { asked: shown, answer, held: countdown === null, where: text, question: p.lastPresented } }];
        });
        yield* sink(asked);
        const wait = Deferred.await(answer).pipe(
          Effect.onInterrupt(() =>
            transition((p): readonly [null, Prompts] => [null, p.waiting?.asked.prompt === asked.prompt ? { ...p, waiting: null } : p]).pipe(Effect.flatMap(([, shown]) => republish(shown))),
          ),
        );
        if (asked.countdown === null) return yield* wait;
        const timer = Effect.sleep(Duration.millis(Math.max(0, asked.countdown.untilMs - now))).pipe(Effect.andThen(deadline(asked.prompt)));
        // The timer lives as long as the wait: an answer, a hold or an interruption ends it with the scope.
        return yield* Effect.scoped(Effect.forkScoped(timer).pipe(Effect.andThen(wait)));
      }).pipe(dialogue.withPermits(1));

    /** An answer read as its kind reads it (src/input.ts): the answer that ends the run fails with UserStopped. */
    const parsedAs = (answer: string, kind: AskKind, where: string): Effect.Effect<string, UserStopped> => {
      const parsed = kind === "line" ? parseAskLine(answer) : parseMessage(answer);
      return parsed.kind === "quit" ? Effect.fail(new UserStopped({ where })) : Effect.succeed(parsed.text);
    };
    const ask = (text: string, onExpiry: OnExpiry = "abandon"): Effect.Effect<string, UserStopped | NoAnswer> =>
      waitFor(text, onExpiry).pipe(Effect.flatMap((line) => parsedAs(line, "line", text)));
    const askMessage = (text: string, onExpiry: OnExpiry = "abandon"): Effect.Effect<string, UserStopped | NoAnswer> =>
      waitFor(text, onExpiry).pipe(Effect.flatMap((message) => parsedAs(message, "message", text)));

    /**
     * Issue #153: the frame of one asking of one question, pushed blocking and removed when the Scope closes. The handle
     * closes over the frame's id: each call of `askDuring` reopens that frame in place, under a new prompt.
     */
    const enterQuestion = (question: number): Effect.Effect<QuestionFrame, never, Scope.Scope> =>
      Effect.gen(function* () {
        const id = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const [id] = yield* transition((p): readonly [number, Prompts] => [p.nextFrame, { ...p, nextFrame: p.nextFrame + 1, frames: [...p.frames, { id: p.nextFrame, question, state: { _tag: "asking" } }] }]);
            yield* Effect.addFinalizer(() =>
              transition((p): readonly [null, Prompts] => [null, { ...p, frames: p.frames.filter((f) => f.id !== id) }]).pipe(Effect.flatMap(([, shown]) => republish(shown))),
            );
            return id;
          }),
        );
        const askDuring = <A, E, R>(text: string, kind: AskKind, work: Effect.Effect<A, E, R>): Effect.Effect<DuringAnswer<A>, E | UserStopped, R> =>
          Effect.gen(function* () {
            const answer = yield* Deferred.make<string>();
            const [asked, shown] = yield* transition((p): readonly [Asked, Prompts] => {
              const opened: Asked = { _tag: "Asked", prompt: p.next, ...promptOf(text), countdown: null, deciding: question };
              return [opened, { ...withFrame(p, id, (f) => ({ ...f, state: { _tag: "preparing", asked: opened, answer } })), next: p.next + 1 }];
            });
            yield* republish(shown);
            // The work's end and an answer race; whichever changes the frame first decides (the requirements' default).
            const close = Effect.uninterruptible(
              Effect.gen(function* () {
                const taken = yield* Ref.modify(prompts, (p): readonly [boolean, Prompts] => {
                  const f = p.frames.find((g) => g.id === id);
                  if (f === undefined || f.state._tag !== "preparing" || f.state.asked.prompt !== asked.prompt) return [true, p];
                  return [false, withFrame(p, id, (g) => ({ ...g, state: { _tag: "analyzed", asked, answer } }))];
                });
                if (!taken) yield* sink({ _tag: "PromptWithdrawn", prompt: asked.prompt });
                return taken;
              }),
            );
            const finished = Effect.flatMap(work, (value) =>
              Effect.flatMap(close, (taken): Effect.Effect<DuringAnswer<A>> => (taken ? Effect.map(Deferred.await(answer), (t) => ({ _tag: "Answered", text: t })) : Effect.succeed({ _tag: "Done", value }))),
            );
            const answered = Effect.map(Deferred.await(answer), (t): DuringAnswer<A> => ({ _tag: "Answered", text: t }));
            const ended = yield* Effect.raceFirst(finished, answered);
            return ended._tag === "Done" ? ended : { _tag: "Answered" as const, text: yield* parsedAs(ended.text, kind, text) };
          });
        return { askDuring };
      });

    return {
      say: (text) => sink({ _tag: "Said", text }),
      notify: (event) =>
        (event._tag === "QuestionPresented" ? Ref.update(prompts, (p) => ({ ...p, lastPresented: { number: event.question.number, text: piecesText(event.question.question) } })) : Effect.void).pipe(
          Effect.andThen(sink({ _tag: "Notified", event })),
        ),
      nextQuestion: Ref.updateAndGet(questions, (n) => n + 1),
      enterQuestion,
      output: live,
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
            type Taken =
              | Readonly<{ _tag: "take" | "expire"; w: Waiting }>
              | Readonly<{ _tag: "frame"; answer: Deferred.Deferred<string> }>
              | Readonly<{ _tag: "was"; then: OnExpiry }>
              | Readonly<{ _tag: "none" }>;
            const [taken, shown] = yield* transition((p): readonly [Taken, Prompts] => {
              const w = p.waiting;
              if (w !== null && w.asked.prompt === prompt) {
                if (due(w, now) && limit !== null) return [{ _tag: "expire", w }, expiring(p, w)];
                // /decide and /terms present the same question again: the developer is at the page, so it starts held.
                // W1-R1-3: the carry adds the question presented for this prompt, nothing where none was presented; the carries of
                // other questions are kept (work review 3 of issue #185, W3-R1-1).
                const carryHold =
                  (isDecide(text) || isTermsRequest(text)) && w.question !== null ? new Set([...p.carryHold, w.question.number]) : p.carryHold;
                return [{ _tag: "take", w }, { ...p, waiting: null, carryHold }];
              }
              // Issue #153: the frame shown, open beside its decision, is taken and stays, blocking, until its Scope closes.
              const top = p.frames[p.frames.length - 1];
              if (w === null && top !== undefined && top.state._tag === "preparing" && top.state.asked.prompt === prompt) {
                const state = { ...top.state, _tag: "answered" as const };
                return [{ _tag: "frame", answer: top.state.answer }, { ...withFrame(p, top.id, (f) => ({ ...f, state })), carryHold: withoutNumber(p.carryHold, top.question) }];
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
                yield* republish(shown);
                return { _tag: "expired", then: taken.w.asked.countdown!.then };
              case "take":
                yield* sink({ _tag: "Answered", prompt, text });
                yield* Deferred.succeed(taken.w.answer, text);
                yield* republish(shown);
                return "taken";
              case "frame":
                yield* sink({ _tag: "Answered", prompt, text });
                yield* Deferred.succeed(taken.answer, text);
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
      pending: Ref.get(prompts).pipe(Effect.map(shownOf)),
    };
  });

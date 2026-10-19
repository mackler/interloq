// The first interview's requests to Claude Code (issue #184), an Effect module over the services: every answer the
// developer gives is queued at once, and one fiber sends the queue to Claude Code's interview session one request at a
// time, the answers given while a request is outstanding together in the next. Each reply is applied when it arrives:
// its message said and recorded, its follow-up questions added to the interview's state, its judgments of unnecessary
// questions said and recorded. The main fiber of src/conversation.ts never waits for a reply before an agreed question;
// it waits only in `drain`, when nothing is left to present. The opening is a request of its own, sent before the worker
// takes its queue, so an answer given before or during it waits in the queue and goes in the next request (work review 1
// of issue #184, W1-R1-1); the queue's items admit no opening that a batch could swallow.

import { Deferred, Effect, Latch, Queue, Ref } from "effect";
import { type ClarificationState, progressOf, withFollowUps } from "./clarificationState.ts";
import type { RunError } from "./errors.ts";
import * as prompts from "./prompts.ts";
import type { ClarificationEntry, ClarificationTrailer } from "./prompts.ts";
import { interviewSays } from "./render.ts";
import type { Exhaustion } from "./retry.ts";
import { planningCall } from "./review.ts";
import * as S from "./schema.ts";
import type { QuestionsFile } from "./schema.ts";
import { normalizeReply, type ReplyVariant } from "./schemaNormalize.ts";
import { type Services, Store, Ui } from "./services.ts";
import { replyValidation } from "./conversation.ts";

/** What `drain` found: follow-ups to present first, or the reply to the closing request. */
export type DrainResult = Readonly<{ kind: "followUps" }> | Readonly<{ kind: "reply"; reply: ReplyVariant }>;

export type InterviewWorker = Readonly<{
  /** Queues an answer, with the program's notes, for the next request; never waits for Claude Code. */
  send: (entry: ClarificationEntry, notes: readonly string[]) => Effect.Effect<void>;
  /**
   * Waits until every request sent has been replied to and applied; then, if follow-ups are pending, returns them
   * first; otherwise sends `trailer` as the only item of a closing request and returns its reply. While it waits, the
   * developer waits for Claude Code (`waiting`), so a request whose retries are used up is asked about.
   */
  drain: (trailer: ClarificationTrailer) => Effect.Effect<DrainResult>;
  /** The loop that sends the requests; it never succeeds, and ends by a halt or by interruption. */
  run: Effect.Effect<never, RunError, Services>;
  /** Whether the main fiber waits for Claude Code (issue #184, decision G-R1-1), and its wake-up. */
  waiting: Effect.Effect<boolean>;
  untilWaiting: Effect.Effect<void>;
}>;

type Item = Readonly<{ kind: "entry"; entry: ClarificationEntry; notes: readonly string[] }> | Readonly<{ kind: "trailer"; trailer: ClarificationTrailer }>;

export type WorkerSetup = Readonly<{
  questions: QuestionsFile["questions"];
  state: Ref.Ref<ClarificationState>;
  heading: string;
  /** How the requests' exhaustion is handled: ASK, or the background tries of decision G-R1-1 (built from the worker's own waiting). */
  exhaustion: (waiting: Effect.Effect<boolean>, untilWaiting: Effect.Effect<void>) => Exhaustion;
}>;

export const makeInterviewWorker = (setup: WorkerSetup): Effect.Effect<InterviewWorker, never, Store> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const queue = yield* Queue.unbounded<Item>();
    /** The opening and the items queued, not yet replied to and applied; the worker is idle when it is 0. */
    const outstanding = yield* Ref.make(1);
    const idle = yield* Latch.make(false);
    const waitingRef = yield* Ref.make(false);
    const waitingLatch = yield* Latch.make(false);
    /** Where the reply to a closing request goes. */
    const closingReply = yield* Ref.make<Deferred.Deferred<ReplyVariant> | null>(null);
    const agreedIds = setup.questions.map((q) => q.id);
    const waiting = Ref.get(waitingRef);
    const untilWaiting = waitingLatch.await;
    const exhaustion = setup.exhaustion(waiting, untilWaiting);

    const enqueue = (item: Item) => Ref.update(outstanding, (n) => n + 1).pipe(Effect.andThen(idle.close), Effect.andThen(Queue.offer(queue, item)), Effect.asVoid);

    const promptOf = (items: readonly Item[]): string => {
      const entries = items.flatMap((i) => (i.kind === "entry" ? [i.entry] : []));
      const notes = items.flatMap((i) => (i.kind === "entry" ? i.notes : []));
      const trailer = items.flatMap((i) => (i.kind === "trailer" ? [i.trailer] : []))[0] ?? null;
      return prompts.clarificationRequestPrompt(entries, notes, trailer);
    };

    /** Applies a reply when it arrives (decision Q1): Claude Code's message, its follow-ups and its judgments. */
    const apply = (reply: ReplyVariant) =>
      Effect.gen(function* () {
        const ui = yield* Ui;
        if (reply.kind === "acknowledged" && reply.followUps.length > 0) yield* Ref.update(setup.state, (s) => withFollowUps(s, reply.followUps, agreedIds));
        const count = progressOf(agreedIds, setup.questions, yield* Ref.get(setup.state));
        if (reply.message.trim() !== "" || reply.kind === "summary_proposed") {
          const text = reply.kind === "summary_proposed" ? { kind: "summary_proposed" as const, message: reply.message, summary: reply.summary } : { kind: "continuing" as const, message: reply.message };
          yield* ui.notify({ _tag: "InterviewTurn", heading: setup.heading, message: reply.message, summary: reply.kind === "summary_proposed" ? reply.summary : null, ...count });
          if (reply.message.trim() !== "") {
            yield* ui.say(interviewSays(text)[0]);
            yield* store.converse(`**Claude Code:** ${reply.message}\n\n`);
          }
        }
        if (reply.kind === "acknowledged" && reply.followUps.length > 0) yield* ui.notify({ _tag: "InterviewCounted", ...count });
        for (const u of reply.unnecessary) {
          const line = prompts.unnecessaryLine(u.id, u.reason);
          yield* ui.say(line);
          yield* store.converse(`**Note:** ${line}\n\n`);
        }
      });

    /** Sends one request, applies its reply and counts `count` items done, opening `idle` at 0. */
    const request = (prompt: string, closing: boolean, count: number) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(setup.state);
        const validate = replyValidation(agreedIds, state.askedFollowUps, { questions: setup.questions, answers: state.answers }, closing);
        const reply = normalizeReply((yield* planningCall(prompt, S.InterviewReply, "interview", "records", validate, null, exhaustion)).output, closing);
        yield* apply(reply);
        if (closing) {
          const deferred = yield* Ref.get(closingReply);
          if (deferred !== null) yield* Deferred.succeed(deferred, reply);
        }
        const left = yield* Ref.updateAndGet(outstanding, (n) => n - count);
        if (left === 0) yield* idle.open;
      });

    /** One request over every item queued since the previous one. */
    const batch = Queue.takeAll(queue).pipe(Effect.flatMap((items) => request(promptOf(items), items.some((i) => i.kind === "trailer"), items.length)));

    const run: Effect.Effect<never, RunError, Services> = request(prompts.clarificationOpenPrompt(store.root), false, 1).pipe(Effect.andThen(Effect.forever(batch)));

    const drain = (trailer: ClarificationTrailer): Effect.Effect<DrainResult> =>
      Effect.gen(function* () {
        yield* Ref.set(waitingRef, true);
        yield* waitingLatch.open;
        yield* idle.await;
        if ((yield* Ref.get(setup.state)).followUps.length > 0) return { kind: "followUps" } as const;
        const deferred = yield* Deferred.make<ReplyVariant>();
        yield* Ref.set(closingReply, deferred);
        yield* enqueue({ kind: "trailer", trailer });
        const reply = yield* Deferred.await(deferred);
        yield* Ref.set(closingReply, null);
        return { kind: "reply", reply } as const;
      }).pipe(Effect.ensuring(Ref.set(waitingRef, false).pipe(Effect.andThen(waitingLatch.close))));

    return {
      send: (entry, notes) => enqueue({ kind: "entry", entry, notes }),
      drain,
      run,
      waiting,
      untilWaiting,
    };
  });

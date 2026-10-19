// Codex through the Codex SDK, as the Reviewer service. One thread per review loop.

import type { ThreadEvent } from "@openai/codex-sdk";
import { Effect, Exit, Layer, Ref } from "effect";
import { CodexCallFailed, TransportFault } from "./errors.ts";
import { classifyCodex, errorCode } from "./transport.ts";
import { thrownText } from "./prompts.ts";
import { agentJsonSchema } from "./jsonSchema.ts";
import * as S from "./schema.ts";
import { reduceTurn, toolEventOf } from "./codexEvents.ts";
import type { SdkThread } from "./sdk.ts";
import { Reviewer, type ReviewerShape, type ReviewSession, RunConfig, Sdk, Store, type StoreShape, Ui, type UiShape } from "./services.ts";

const failedWith = (e: unknown): CodexCallFailed => new CodexCallFailed({ message: e instanceof Error ? e.message : String(e) });
/** A failure of a turn: TransportFault when src/transport.ts identifies a transport fault, CodexCallFailed otherwise (issue #26). */
const turnFailure = (message: string, code: string | null = null): CodexCallFailed | TransportFault =>
  classifyCodex(message, code) ? new TransportFault({ agent: "codex", message, status: null }) : new CodexCallFailed({ message });
/** A thrown value's text, with its code where the text does not name it (W1-R1-2). */
const turnFailedWith = (e: unknown): CodexCallFailed | TransportFault => {
  const code = errorCode(e);
  const message = typeof e === "object" && e !== null ? (e as { message?: unknown }).message : undefined;
  const text = typeof message === "string" ? message : typeof e === "object" && e !== null ? "" : String(e);
  return turnFailure(thrownText(text, code), code);
};

/**
 * The session over one thread: the thread is a closed-over value, so a call before the start is impossible.
 * A turn is streamed and its events consumed inside the Effect, as the Claude Code messages are: the tool uses
 * go to the activity line as they arrive, and on every early exit the turn is aborted and the stream closed.
 */
const session = (store: StoreShape, ui: UiShape, thread: SdkThread, nextCallId: Effect.Effect<string>): ReviewSession => ({
  review: (prompt) =>
    nextCallId.pipe(Effect.flatMap((callId) => Effect.gen(function* () {
      yield* ui.notify({ _tag: "AgentCallStarted", agent: "codex", purpose: "review", callId });
      const controller = new AbortController();
      const streamed = yield* Effect.tryPromise({
        try: () => thread.runStreamed(prompt, { outputSchema: agentJsonSchema(S.Review), signal: controller.signal }),
        catch: turnFailedWith,
      }).pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())));
      const events = streamed.events;
      const seen: ThreadEvent[] = [];
      const reported = new Set<string>();
      const consume = Effect.gen(function* () {
        for (;;) {
          const step = yield* Effect.tryPromise({ try: () => events.next(), catch: turnFailedWith });
          if (step.done === true) return;
          seen.push(step.value);
          if (step.value.type === "error") {
            yield* ui.notify({ _tag: "AgentReconnecting", agent: "codex", by: "sdk", attempt: null, of: null, delayMs: null, detail: step.value.message });
          }
          const tool = toolEventOf(reported, step.value);
          if (tool !== null) {
            reported.add(tool.id);
            yield* ui.notify(tool.event);
          }
        }
      });
      const close = Effect.promise(async () => {
        controller.abort();
        await events.return(undefined).catch(() => undefined);
      });
      yield* consume.pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : close)));
      const outcome = reduceTurn(seen);
      if (outcome.kind === "failed") return yield* Effect.fail(turnFailure(outcome.message));
      if (outcome.usage !== null) yield* store.recordUsage({ agent: "codex", thread: thread.id, inputTokens: outcome.usage.input_tokens, outputTokens: outcome.usage.output_tokens });
      return { text: outcome.finalResponse, inputTokens: outcome.usage?.input_tokens ?? null };
    }).pipe(Effect.onExit((exit) => ui.notify({ _tag: "AgentCallEnded", agent: "codex", ok: Exit.isSuccess(exit), callId }))))),
});

/** The Reviewer service over the SDK, Store and RunConfig services. */
export const makeCodexReviewer: Effect.Effect<ReviewerShape, never, Sdk | Store | Ui | RunConfig> = Effect.gen(function* () {
  const sdk = yield* Sdk;
  const ui = yield* Ui;
  const store = yield* Store;
  const config = yield* RunConfig;
  // Issue #184 (S13): every turn of every thread of this reviewer numbered by one counter, its id on its start and end.
  const callCount = yield* Ref.make(0);
  const nextCallId = Ref.updateAndGet(callCount, (n) => n + 1).pipe(Effect.map((n) => `codex-${n}`));

  return {
    // Bubblewrap cannot start in the container, so Codex's own sandbox is off. The container and its
    // firewall are the boundary, and the caller compares the project state after every turn.
    // Starting a thread can throw synchronously (for example when the SDK cannot start its CLI); that is
    // a typed failure, like a failed turn, not a defect (finding 11 of docs/functional-design-review.md).
    startPhase: Effect.try({
      try: () =>
        sdk.startThread({
          workingDirectory: store.project,
          sandboxMode: "danger-full-access",
          approvalPolicy: "never",
          ...(config.codexModel !== null ? { model: config.codexModel } : {}),
        }),
      catch: (e: unknown) => new CodexCallFailed({ message: e instanceof Error ? e.message : String(e) }),
    }).pipe(Effect.map((thread) => session(store, ui, thread, nextCallId))),
  };
});

export const codexReviewerLayer: Layer.Layer<Reviewer, never, Sdk | Store | Ui | RunConfig> = Layer.effect(Reviewer, makeCodexReviewer);

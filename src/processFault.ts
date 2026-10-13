// The process's first uncaught exception or unhandled rejection (an edge over an event emitter given as a parameter;
// issue #158). Such an error cannot be traced to one run: by the user's decision Q1, src/web.ts halts every run in
// progress with its record and then ends the server. The listeners stay registered for the rest of the process's
// life, so a second error during that shutdown cannot end the process before the records are written.

import { Effect } from "effect";
import { thrownText } from "./prompts.ts";
import { errorCode } from "./transport.ts";

/** What reached the process with no handler, as one line of text. */
export type ProcessFault = Readonly<{ kind: "uncaughtException" | "unhandledRejection"; text: string }>;
const KINDS: readonly ProcessFault["kind"][] = ["uncaughtException", "unhandledRejection"];

/** A value read without letting a throwing getter or conversion escape, or the fallback. */
const guarded = <A>(read: () => A, fallback: A): A => {
  try {
    return read();
  } catch {
    return fallback;
  }
};

/**
 * A thrown or rejected value as text (pure): its message, and its code where the message does not name it, as
 * src/codex.ts says a failed turn; a value with no message as its own text. Never throws, never empty.
 */
export const faultText = (value: unknown): string => {
  const message = guarded(() => (typeof value === "object" && value !== null ? (value as { message?: unknown }).message : undefined), undefined);
  const code = guarded(() => errorCode(value), null);
  const text = typeof message === "string" ? message : guarded(() => String(value), "a value that cannot be shown as text");
  return thrownText(text, code);
};

/** The first uncaught exception or unhandled rejection the target emits. */
export const firstProcessFault = (target: Pick<NodeJS.EventEmitter, "on">): Effect.Effect<ProcessFault> =>
  Effect.callback<ProcessFault>((resume) => {
    const first = { done: false };
    for (const kind of KINDS) {
      target.on(kind, (value: unknown) => {
        if (first.done) return;
        first.done = true;
        resume(Effect.succeed({ kind, text: faultText(value) }));
      });
    }
  });

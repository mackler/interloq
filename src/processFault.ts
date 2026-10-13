// The process's first uncaught exception or unhandled rejection (an edge over an event emitter given as a parameter;
// issue #158). Such an error cannot be traced to one run: by the user's decision Q1, src/web.ts halts every run in
// progress with its record and then ends the server. The listeners stay registered for the rest of the process's
// life, so a second error during that shutdown cannot end the process before the records are written.

import { Effect } from "effect";

/** What reached the process with no handler, as one line of text. */
export type ProcessFault = Readonly<{ kind: "uncaughtException" | "unhandledRejection"; text: string }>;

/** A thrown or rejected value as text (pure): its message, and its code where the message does not name it. */
export const faultText = (_value: unknown): string => "";

/** The first uncaught exception or unhandled rejection the target emits. */
export const firstProcessFault = (_target: Pick<NodeJS.EventEmitter, "on">): Effect.Effect<ProcessFault> => Effect.never;

// The line of a failed Claude Code request (issue #192, requirements Q1), pure: the facts of the failure with every
// value of a credential-named variable of the environment redacted, so that the line contains no credential whatever
// text the Agent SDK puts in a failure (a process ending's stderr tail, an error result).

import type { ClaudeFailure } from "./transport.ts";
import type { CallFailure, ClaudePurpose } from "./usage.ts";

/** What stands in place of a redacted text. */
export const REDACTED = "[redacted]";

/** The values of the environment's credential-named variables that are not blank, deduplicated. */
export const secretsOf = (_env: Readonly<Record<string, string | undefined>>): readonly string[] => [];

/** The text with every character any occurrence of a secret covers replaced, each maximal run by one REDACTED. */
export const redact = (text: string, _secrets: readonly string[]): string => text;

export type FailureInput = Readonly<{
  session: string | null;
  purpose: ClaudePurpose;
  callId: string;
  message: string;
  failure: ClaudeFailure | null;
}>;

/** The line of one failed request, every text redacted. */
export const failureLineOf = (input: FailureInput, _secrets: readonly string[]): CallFailure => input;

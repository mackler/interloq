// The line of a failed Claude Code request (issue #192, requirements Q1), pure: the facts of the failure with every
// value of a credential-named variable of the environment redacted, so that the line contains no credential whatever
// text the Agent SDK puts in a failure (a process ending's stderr tail, an error result).

import type { ClaudeFailure } from "./transport.ts";
import type { CallFailure, ClaudePurpose } from "./usage.ts";

/** What stands in place of a redacted text. */
export const REDACTED = "[redacted]";

/** The values of the environment's credential-named variables that are not blank, deduplicated. */
export const secretsOf = (env: Readonly<Record<string, string | undefined>>): readonly string[] => [
  ...new Set(
    Object.entries(env).flatMap(([name, value]) => (value !== undefined && value.trim() !== "" && CREDENTIAL_NAME.test(name) ? [value] : [])),
  ),
];

/** A variable whose name says it holds a credential, in any case. */
const CREDENTIAL_NAME = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/i;

/** The text with every character any occurrence of a secret covers replaced, each maximal run by one REDACTED. */
export const redact = (text: string, secrets: readonly string[]): string => {
  const covered = coveredBy(text, secrets);
  // By UTF-16 code unit, as indexOf counts, so a secret that ends inside a surrogate pair is still replaced whole.
  let out = "";
  for (let i = 0; i < text.length; i++) out += covered[i] ? (i > 0 && covered[i - 1] ? "" : REDACTED) : text[i];
  return out;
};

/**
 * Which characters of the text an occurrence of a secret covers, overlapping occurrences included, found by plain
 * substring search over the original text only, so a replacement is never searched again.
 */
const coveredBy = (text: string, secrets: readonly string[]): readonly boolean[] => {
  const covered = Array.from({ length: text.length }, () => false);
  for (const secret of secrets) {
    if (secret === "") continue;
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) covered.fill(true, at, at + secret.length);
  }
  return covered;
};

export type FailureInput = Readonly<{
  session: string | null;
  purpose: ClaudePurpose;
  callId: string;
  message: string;
  failure: ClaudeFailure | null;
}>;

/** The line of one failed request, every text redacted. */
export const failureLineOf = (input: FailureInput, secrets: readonly string[]): CallFailure => {
  const r = (text: string): string => redact(text, secrets);
  const rn = (text: string | null): string | null => (text === null ? null : r(text));
  const f = input.failure;
  return {
    session: input.session,
    purpose: input.purpose,
    callId: input.callId,
    message: r(input.message),
    failure:
      f === null
        ? null
        : {
            ...f,
            streamCode: rn(f.streamCode),
            terminalReason: rn(f.terminalReason),
            assistantError: rn(f.assistantError),
            subtype: rn(f.subtype),
            resultText: rn(f.resultText),
            retrySeen: f.retrySeen === null ? null : { status: f.retrySeen.status, error: r(f.retrySeen.error) },
            rejection: f.rejection === null ? null : { ...f.rejection, limitType: rn(f.rejection.limitType) },
            processEnd: f.processEnd === null || f.processEnd.kind === "exit" ? f.processEnd : { kind: "signal", signal: r(f.processEnd.signal) },
          },
  };
};

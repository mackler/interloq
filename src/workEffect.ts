// Each agent's statement of a disputed point's effect on the work (issue #183), as the program holds it. Pure.
// The agents write `work_effect` (WorkEffectReply of src/schema.ts) on the issues of the plan's and the work's reviews and
// on the dispositions of their responses; workEffectOf builds the program's value, refusing a blank difference, and
// changesNothing is the one statement of when a dispute is settled without the user.

import { Result, Schema } from "effect";
import * as S from "./schema.ts";

/** The program's value of a statement: `none`, or `differs` with a difference that is not blank; a blank one is refused. */
export const workEffectOf = (reply: S.WorkEffectReply): Result.Result<S.WorkEffect, "blank"> =>
  reply.kind === "none"
    ? Result.succeed({ kind: "none" })
    : Result.match(decodeEffectText(reply.difference), { onFailure: () => Result.fail("blank" as const), onSuccess: (difference) => Result.succeed({ kind: "differs" as const, difference }) });
const decodeEffectText = Schema.decodeUnknownResult(S.EffectText);

/** True exactly when both agents state that nothing in the work would differ. */
export const changesNothing = (effects: S.WorkEffects): boolean => effects.reviewer.kind === "none" && effects.planner.kind === "none";

/** An issue whose review carries the statement: only the plan's and the work's reviews keep the field when decoded. */
export const isEffectIssue = Schema.is(S.EffectIssue);
/** A disposition whose response carries the statement: only the plan's and the work's responses keep the field when decoded. */
export const isEffectDisposition = Schema.is(S.EffectDisposition);

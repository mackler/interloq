// Each agent's position and Claude Code's resolution of both concerns (issue #38), as data. Pure: no file access, no
// agent calls, no Effect services. The one place that builds a position or a resolution from a reply, says whether a
// resolution would change something only the developer may change, and reads the investigations the issue log keeps.

import { Result } from "effect";
import type { IssueId, Investigation, LogEntry, Position, Resolution, ResolutionReply } from "./schema.ts";
import type * as S from "./schema.ts";

type ReviewEntry = typeof S.ReviewEntry.Type;

/** A position from a reply's concern and remedy: both must hold a character other than whitespace. */
export const positionOf = (_reply: Readonly<{ concern: string; remedy: string }>): Result.Result<Position, "blank"> => Result.fail("blank");

/** A resolution from a reply's: null stays null; a blank text or any blank change is `"blank"`. */
export const resolutionOf = (_reply: ResolutionReply | null): Result.Result<Resolution | null, "blank"> => Result.fail("blank");

/** Whether a resolution would change a requirement, a decision of the developer or a decided behavior: only he may authorize it. */
export const changesAuthority = (_r: Resolution): boolean => false;

/** The latest (phase, round) of the log's entries strictly before the given one, in that order; null where none. */
export const previousRound = (_log: readonly LogEntry[], _phase: number, _round: number): Readonly<{ phase: number; round: number }> | null => null;

/** The resolutions of the previous round that Codex did not raise again: agreed, or put to the developer. */
export type ResolutionOutcome = Readonly<{ agreed: readonly Readonly<{ id: IssueId; resolution: Resolution }>[]; authority: readonly ReviewEntry[] }>;

export const resolutionOutcomes = (_log: readonly LogEntry[], _raised: readonly string[], _phase: number, _round: number): ResolutionOutcome => ({ agreed: [], authority: [] });

/** The ids of every entry whose `investigations` is not empty. */
export const investigatedIds = (_log: readonly LogEntry[]): ReadonlySet<string> => new Set();

/** A dispute that had its investigation and still stands, with its kind and the entry of its own id. */
export type StandingDispute = Readonly<{ id: IssueId; investigation: Investigation; entry: LogEntry }>;

export const standingDisputes = (_log: readonly LogEntry[]): readonly StandingDispute[] => [];

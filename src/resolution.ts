// Each agent's position and Claude Code's resolution of both concerns (issue #38), as data. Pure: no file access, no
// agent calls, no Effect services. The one place that builds a position or a resolution from a reply, says whether a
// resolution would change something only the developer may change, and reads the investigations the issue log keeps.

import { Result } from "effect";
import type { IssueId, Investigation, LogEntry, Position, Resolution, ResolutionReply } from "./schema.ts";
import type * as S from "./schema.ts";

type ReviewEntry = typeof S.ReviewEntry.Type;

const blank = (t: string): boolean => !/\S/u.test(t);
const NOT_ACCEPTED_IN_FULL: ReadonlySet<string> = new Set(["rejected", "partially_accepted", "no_change_needed"]);
const currentOf = (log: readonly LogEntry[]): readonly LogEntry[] => log.filter((e) => !e.superseded);

/** A position from a reply's concern and remedy: both must hold a character other than whitespace. */
export const positionOf = (reply: Readonly<{ concern: string; remedy: string }>): Result.Result<Position, "blank"> =>
  blank(reply.concern) || blank(reply.remedy) ? Result.fail("blank") : Result.succeed({ concern: reply.concern as S.PositionText, remedy: reply.remedy as S.PositionText });

/** A resolution from a reply's: null stays null; a blank text or any blank change is `"blank"`. */
export const resolutionOf = (reply: ResolutionReply | null): Result.Result<Resolution | null, "blank"> => {
  if (reply === null) return Result.succeed(null);
  if (blank(reply.text) || reply.changes.some(blank)) return Result.fail("blank");
  return Result.succeed({ text: reply.text as S.PositionText, changes: reply.changes.map((c) => c as S.PositionText) });
};

/** Whether a resolution would change a requirement, a decision of the developer or a decided behavior: only he may authorize it. */
export const changesAuthority = (r: Resolution): boolean => r.changes.length > 0;

const earlier = (a: Readonly<{ phase: number; round: number }>, b: Readonly<{ phase: number; round: number }>): boolean => a.phase < b.phase || (a.phase === b.phase && a.round < b.round);

/** The latest (phase, round) of the log's entries strictly before the given one, in that order; null where none. */
export const previousRound = (log: readonly LogEntry[], phase: number, round: number): Readonly<{ phase: number; round: number }> | null =>
  log.reduce<Readonly<{ phase: number; round: number }> | null>((best, e) => (earlier(e, { phase, round }) && (best === null || earlier(best, e)) ? { phase: e.phase, round: e.round } : best), null);

/** The resolutions of the previous round that Codex did not raise again: agreed, or put to the developer. */
export type ResolutionOutcome = Readonly<{ agreed: readonly Readonly<{ id: IssueId; resolution: Resolution }>[]; authority: readonly ReviewEntry[] }>;

/**
 * The current review and self-correction entries of the round before (phase, round) that carry a resolution and whose id
 * Codex did not raise in this review (`raised`): agreed where the resolution changes nothing only the developer may change;
 * put to him where a review entry's would. A self-correction's resolution that would is asked as its disputed
 * self-correction, through standingDisputes.
 */
export const resolutionOutcomes = (log: readonly LogEntry[], raised: readonly string[], phase: number, round: number): ResolutionOutcome => {
  const prev = previousRound(log, phase, round);
  if (prev === null) return { agreed: [], authority: [] };
  const raisedIds = new Set(raised);
  const candidates = currentOf(log).flatMap((e) =>
    e.source !== "user" && e.phase === prev.phase && e.round === prev.round && e.resolution !== null && !raisedIds.has(e.id) ? [{ entry: e, resolution: e.resolution }] : [],
  );
  return {
    agreed: candidates.filter((c) => !changesAuthority(c.resolution)).map((c) => ({ id: c.entry.id, resolution: c.resolution })),
    authority: candidates.flatMap((c) => (c.entry.source === "review" && changesAuthority(c.resolution) ? [c.entry] : [])),
  };
};

/** The ids of every entry whose `investigations` is not empty. */
export const investigatedIds = (log: readonly LogEntry[]): ReadonlySet<string> => new Set(log.flatMap((e) => (e.source !== "user" && e.investigations.length > 0 ? [e.id] : [])));

/** A dispute that had its investigation and still stands, with its kind and the entry of its own id. */
export type StandingDispute = Readonly<{ id: IssueId; investigation: Investigation; entry: LogEntry }>;

/**
 * One element per record of a current entry's `investigations` whose dispute still stands, by its kind: a point raised
 * again not accepted in full; a repetition whose earlier id is still not accepted in full; a reversal still naming the
 * id it reverses; a clarification still requested; a self-correction still disputed. An id whose current entry is a
 * decision of the developer's stands for nothing.
 */
export const standingDisputes = (log: readonly LogEntry[]): readonly StandingDispute[] => {
  const current = currentOf(log);
  const byId = new Map(current.map((e) => [e.id as string, e] as const));
  const stands = (entry: LogEntry, investigation: Investigation): boolean => {
    switch (investigation.pause) {
      case "reraised":
        return entry.source === "review" && NOT_ACCEPTED_IN_FULL.has(entry.action);
      case "repeatedUnderNewId": {
        const other = investigation.other === null ? undefined : byId.get(investigation.other);
        return entry.source === "review" && other !== undefined && NOT_ACCEPTED_IN_FULL.has(other.action);
      }
      case "reversal":
        return entry.source === "review" && entry.reverses !== null;
      case "secondClarification":
        return entry.source === "review" && entry.action === "clarification_requested";
      case "disputedSelfCorrection":
        return entry.source === "self_correction" && entry.action === "correction_disputed";
    }
  };
  return current.flatMap((entry) => (entry.source === "user" ? [] : entry.investigations.filter((i) => stands(entry, i)).map((investigation) => ({ id: entry.id, investigation, entry }))));
};

// The run's disputes put to the developer beside the run (issue #243, requirements Q1), as a pure registry.
import type { SubjectId } from "./artifacts.ts";
import type { IssueId } from "./round.ts";
import { type BesideKey, keepsPlannerPosition, type Option } from "./reviewState.ts";

export type DisputeOwner = Readonly<{ _tag: "Run" }> | Readonly<{ _tag: "Decision"; decision: number }>;
export type OpenDispute = Readonly<{
  key: BesideKey;
  heading: string;
  subject: SubjectId;
  phase: number;
  round: number;
  id: IssueId | null;
  recordSubject: string;
  reviewer: string;
  planner: string;
  options: readonly Option[];
  owner: DisputeOwner;
}>;
type EntryState = Readonly<{ _tag: "Open" }> | Readonly<{ _tag: "Answered"; text: string }>;
export type Entry = Readonly<{ dispute: OpenDispute; inLoop: boolean; state: EntryState }>;
export type Registry = readonly Entry[];
export type Answered = Readonly<{ dispute: OpenDispute; text: string; applies: boolean }>;
export type Withdrawn = Readonly<{ withdrawn: readonly OpenDispute[]; answered: readonly Answered[] }>;
export const EMPTY_REGISTRY: Registry = [];

/** The answered entries among `entries`, each with whether it applies anything (an answer for Claude Code's position does not). */
const answeredOf = (entries: readonly Entry[]): readonly Answered[] =>
  entries.flatMap((e) => (e.state._tag === "Answered" ? [{ dispute: e.dispute, text: e.state.text, applies: !keepsPlannerPosition(e.dispute.options, e.state.text) }] : []));
const has = (keys: readonly BesideKey[]) => (e: Entry): boolean => keys.includes(e.dispute.key);
const owns = (owner: DisputeOwner) => (e: Entry): boolean => (owner._tag === "Run" ? e.dispute.owner._tag === "Run" : e.dispute.owner._tag === "Decision" && e.dispute.owner.decision === owner.decision);
/** The entries `pick` selects removed: those still open withdrawn, those answered returned with their answers. */
const withdrawing = (r: Registry, pick: (e: Entry) => boolean): readonly [Withdrawn, Registry] => {
  const taken = r.filter(pick);
  return [{ withdrawn: taken.filter((e) => e.state._tag === "Open").map((e) => e.dispute), answered: answeredOf(taken) }, r.filter((e) => !pick(e))];
};

/** A dispute registered, in its loop, before its question is presented. */
export const opened = (r: Registry, d: OpenDispute): readonly [null, Registry] => [null, [...r, { dispute: d, inLoop: true, state: { _tag: "Open" } }]];
/** Whether a dispute is still in the registry, open or answered (W7-R1-1: its producer may then be attached). */
export const isRegistered = (r: Registry, key: BesideKey): boolean => r.some((e) => e.dispute.key === key);
/** An answer the Ui took: kept on its entry, or too late where the entry was withdrawn first. */
export const answered = (r: Registry, key: BesideKey, text: string): readonly ["kept" | "tooLate", Registry] =>
  r.some((e) => e.dispute.key === key) ? ["kept", r.map((e) => (e.dispute.key === key ? { ...e, state: { _tag: "Answered", text } } : e))] : ["tooLate", r];
/** The answered entries among `keys`, read without consuming them (the loop's boundary). */
export const peeked = (r: Registry, keys: readonly BesideKey[]): readonly [readonly Answered[], Registry] => [answeredOf(r.filter(has(keys))), r];
/** The entries the loop recorded, removed. */
export const acknowledged = (r: Registry, keys: readonly BesideKey[]): readonly [null, Registry] => [null, r.filter((e) => !has(keys)(e))];
/** The loop of `keys` ended: their answers are now the run's to apply at its next point. */
export const loopEnded = (r: Registry, keys: readonly BesideKey[]): readonly [null, Registry] => [null, r.map((e) => (has(keys)(e) ? { ...e, inLoop: false } : e))];
/**
 * Every answered dispute owned by the run whose loop ended, removed. A decision's dispute is never taken: the question its
 * decision serves withdraws it, so none reaches a plan revision or an application to the requirements.
 */
export const takenAfterLoop = (r: Registry): readonly [readonly Answered[], Registry] => {
  const pick = (e: Entry): boolean => e.state._tag === "Answered" && !e.inLoop && e.dispute.owner._tag === "Run";
  return [answeredOf(r.filter(pick)), r.filter((e) => !pick(e))];
};
/** Every dispute of an owner withdrawn; one answered before is returned with its answer, never as withdrawn. */
export const withdrawnOwned = (r: Registry, owner: DisputeOwner): readonly [Withdrawn, Registry] => withdrawing(r, owns(owner));
/** Every dispute withdrawn (the run's end, a send-back), the same way. */
export const withdrawnAll = (r: Registry): readonly [Withdrawn, Registry] => withdrawing(r, () => true);

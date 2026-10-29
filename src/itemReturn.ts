// Whether an implementation run that ends without finishing returns its item to refined (issue #192, decision Q5 of its
// requirements): pure. A run that halts (1) or is stopped (130) having made no commit, HEAD still naming the commit it
// began at, gives its item back to the Implementation tab; a run that committed, or whose leftovers the chain parks on a
// branch, keeps it implementing.

/** How the run ended: halted (exit code 1) or stopped (Stop task or End the run, 130). */
export type RunEnding = "halted" | "stopped";

/**
 * Whether the chain has committed to parking the run's uncommitted files on a branch (behavior 15). The program asks
 * for the claim only where a halted run left files uncommitted, so a claim carries that fact.
 */
export type Parking = Readonly<{ _tag: "NotParked" }> | Readonly<{ _tag: "ParkingClaimed" }>;

/**
 * What the decision rests on: no baseline.json (the run ended before it, which is after its item was labeled
 * implementing), or the commit the run began at, HEAD now (each null on an unborn branch) and the parking.
 */
export type ReturnFacts =
  | Readonly<{ _tag: "NoBaseline" }>
  | Readonly<{ _tag: "Baseline"; startCommit: string | null; head: string | null; parking: Parking }>;

/** Return the item to refined, or keep it where it is and why. */
export type ItemReturn = Readonly<{ _tag: "Return" }> | Readonly<{ _tag: "Keep"; reason: "noBaseline" | "committed" | "parkedWork" }>;

export const itemReturnOf = (facts: ReturnFacts): ItemReturn => {
  if (facts._tag === "NoBaseline") return { _tag: "Keep", reason: "noBaseline" };
  // Strict equality of the nullable values: an unborn branch still unborn made no commit, and a baseline written before
  // start_commit existed (read as null) never matches a real HEAD.
  if (facts.head !== facts.startCommit) return { _tag: "Keep", reason: "committed" };
  return facts.parking._tag === "ParkingClaimed" ? { _tag: "Keep", reason: "parkedWork" } : { _tag: "Return" };
};

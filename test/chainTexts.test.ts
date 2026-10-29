// Issue #147 (S3): the chain's texts in src/prompts.ts: one for every case, the turned-off texts distinct, the cutoff in
// the reader's time, and no cost anywhere (requirements Q2).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AbandonLabel, Chain, ChainEndReason, ChainEntry, ChainState, Cutoff, ParkNote, RunLimit } from "../src/chain.ts";
import { DEFAULT_SETTINGS, OFF_SETTINGS } from "../src/chain.ts";
import { chainEndedText, chainEntryText, chainParkingText, chainSaveRefusedText, chainStatusText, earlierRunParkedLine } from "../src/prompts.ts";
import type { ItemId } from "../src/tracker.ts";
import type { RunRoot } from "../src/artifacts.ts";

const item = "7" as ItemId;
const time = (iso: string) => `<${iso}>`;
const common = { generation: 1, count: 2, halts: [], history: [] };
const reasons: readonly ChainEndReason[] = [
  { _tag: "NoItems" },
  { _tag: "RunLimitReached", limit: 3 as RunLimit },
  { _tag: "CutoffPassed", cutoff: Date.parse("2026-10-21T07:00:00.000Z") as Cutoff },
  { _tag: "StoppedByDeveloper", item },
  { _tag: "HaltedTwice", item },
  { _tag: "ServerEnded", item },
  { _tag: "TurnedOff", running: item },
  { _tag: "TurnedOff", running: null },
  { _tag: "StartRefused", item, reason: "the tracker could not be reached" },
  { _tag: "ParkFailed", item, message: "error: Entry 'a' would be overwritten" },
  { _tag: "SaveFailed", message: "ENOSPC" },
  { _tag: "Unreadable", message: "not JSON" },
  { _tag: "ChainChanged", item },
  { _tag: "ListingFailed", message: "the tracker could not be reached" },
];
const chains: readonly Chain[] = [
  { _tag: "Idle", ended: null, history: [] },
  { _tag: "Running", run: 4, item, title: "seven", claim: { _tag: "Unclaimed" }, ...common },
  { _tag: "Parking", item, root: "runs/r" as RunRoot, then: null, ...common },
  { _tag: "Ready", ...common },
  { _tag: "Starting", item, title: "seven", ...common },
];
const entries: readonly ChainEntry[] = [
  { item, title: "t", root: null, outcome: { _tag: "Finished" }, returned: null },
  { item, title: "t", root: null, outcome: { _tag: "Stopped", park: null }, returned: null },
  ...(["Pending", "NothingParked"] as const).map((t) => ({ item, title: "t", root: null, outcome: { _tag: "Halted" as const, park: { _tag: t } }, returned: null })),
  { item, title: "t", root: null, outcome: { _tag: "Halted", park: { _tag: "Parked", branch: "interloq/halted/7/r", commit: "c" } }, returned: null },
  { item, title: "t", root: null, outcome: { _tag: "Halted", park: { _tag: "ParkFailed", message: "m" } }, returned: null },
  // Issue #186: a send-back with its branch or nothing parked, and a stop after the run's own parking.
  { item, title: "t", root: null, outcome: { _tag: "SentBack", park: { _tag: "Parked", branch: "interloq/halted/7/r", commit: "c" } }, returned: null },
  { item, title: "t", root: null, outcome: { _tag: "SentBack", park: { _tag: "NothingParked" } }, returned: null },
  { item, title: "t", root: null, outcome: { _tag: "Stopped", park: { _tag: "Parked", branch: "interloq/halted/7/r", commit: "c" } }, returned: null },
];

const all = (): readonly string[] => [
  ...reasons.map((r) => chainEndedText(r, time)),
  ...chains.flatMap((chain) => [DEFAULT_SETTINGS, OFF_SETTINGS].map((settings) => chainStatusText({ settings, chain, generation: 1 } satisfies ChainState))),
  ...entries.map(chainEntryText),
  chainParkingText("7"),
  chainSaveRefusedText("m"),
  earlierRunParkedLine("runs/r" as RunRoot, "interloq/halted/7/r"),
];

test("every reason, chain and entry has a text that is not blank", () => {
  for (const text of all()) assert.notEqual(text.trim(), "");
});

test("turned off with a run in progress and without one say different things, the first naming the run", () => {
  const withRun = chainEndedText({ _tag: "TurnedOff", running: item }, time);
  const without = chainEndedText({ _tag: "TurnedOff", running: null }, time);
  assert.notEqual(withRun, without);
  assert.ok(withRun.includes("#7"));
});

test("the cutoff's text is the formatter's output", () => {
  assert.ok(chainEndedText(reasons[2]!, time).includes("<2026-10-21T07:00:00.000Z>"));
});

test("no text names a cost", () => {
  for (const text of all()) assert.ok(!text.includes("$") && !/cost/i.test(text), text);
});

test("a running chain names its count, and the limit where one is set", () => {
  const running = chains[1]!;
  assert.ok(chainStatusText({ settings: DEFAULT_SETTINGS, chain: running, generation: 1 }).startsWith("Run 2 of the chain"));
  assert.ok(chainStatusText({ settings: { enabled: true, limits: { runs: 3 as RunLimit, cutoff: null } }, chain: running, generation: 1 }).startsWith("Run 2 of 3"));
});

// Issue #186: a send-back's entry says the item went back to refinement and names its branch where work was parked.
test("a send-back's entry names the send-back and its branch, and a stop after its own parking names the branch", () => {
  const [sentParked, sentNothing, stoppedParked] = entries.slice(-3).map(chainEntryText);
  assert.match(sentParked!, /sent back to refinement/);
  assert.ok(sentParked!.includes("interloq/halted/7/r"));
  assert.match(sentNothing!, /sent back to refinement/);
  assert.ok(!sentNothing!.includes("branch"));
  assert.ok(stoppedParked!.includes("interloq/halted/7/r") && /Stop task/.test(stoppedParked!));
  assert.equal(chainEntryText(entries[1]!), "Item #7 t: stopped with Stop task.");
});

// Issue #185: an abandoned run's entry, one text per AbandonLabel; never a label the item does not carry.
test("each AbandonLabel of an abandoned entry says what became of the label", () => {
  const parkedNote = { _tag: "Parked", branch: "interloq/halted/7/r", commit: "c" } as const;
  const entry = (label: AbandonLabel, park: ParkNote | null = parkedNote): ChainEntry => ({ item, title: "t", root: null, outcome: { _tag: "Abandoned", park, label }, returned: null });
  const set = chainEntryText(entry({ _tag: "SetRefined" }));
  assert.ok(set.includes("interloq/halted/7/r") && set.includes("label was set to `refined`"), set);
  const held = chainEntryText(entry({ _tag: "StillHeld", state: "implementing", cause: "GitHub answered 502" }));
  assert.ok(held.includes("`implementing`") && held.includes("GitHub answered 502") && !held.includes("set to `refined`"), held);
  const unconfirmed = chainEntryText(entry({ _tag: "Unconfirmed", cause: "the tracker could not be reached" }));
  assert.ok(unconfirmed.includes("could not be confirmed as `refined`") && unconfirmed.includes("the tracker could not be reached"), unconfirmed);
  const kept = chainEntryText(entry({ _tag: "KeptImplementing" }, { _tag: "ParkFailed", message: "git commit failed: index.lock exists" }));
  assert.ok(kept.includes("`implementing`") && kept.includes("git commit failed: index.lock exists") && !kept.includes("`refined`"), kept);
  const unchanged = chainEntryText(entry({ _tag: "Unchanged" }, null));
  assert.ok(unchanged.includes("kept the label `refined`"), unchanged);
  for (const step of ["comment", "label"] as const) {
    const text = chainEntryText(entry({ _tag: "SendBackUnfinished", step }));
    assert.ok(text.includes(step === "comment" ? "comment" : "`unrefined`") && text.includes("set no label"), text);
  }
});

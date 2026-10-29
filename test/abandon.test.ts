// Issue #185 (requirements Q1, G-R1-1): abandonRun over testLayer, the fake tracker and a temporary repository: the work
// moved to the item's branch, the working branch reset, the label set to refined; a git step that fails leaves the work
// and the label; a label that cannot be set is said with what the tracker last reported, and nothing is asked.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Cause, Effect, Exit, Layer, Result } from "effect";
import { abandonedAfterFailure, abandonRun } from "../src/abandon.ts";
import { FileSystemError, TrackerUnreachable } from "../src/errors.ts";
import { parkBranchOf } from "../src/park.ts";
import * as prompts from "../src/prompts.ts";
import { type Services, Store, type StoreShape, Tracker } from "../src/services.ts";
import type { FakeItem, FakeTracker } from "./fakeTracker.ts";
import { fakeTrackerOf, scriptedItem, tempRepo, testLayer, TEST_ROOT } from "./helpers.ts";

const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const implementing: FakeItem = { ...scriptedItem, state: "implementing" };
const branch = Result.getOrThrow(parkBranchOf(scriptedItem.id, TEST_ROOT));
const serverError = (message: string) => new TrackerUnreachable({ tracker: "GitHub", message, status: 502 });
const unreached = (message: string) => new TrackerUnreachable({ tracker: "GitHub", message, status: null });

const setup = (tracker: FakeTracker, options: { work?: boolean; leftover?: boolean; lock?: boolean; failWrites?: boolean | "exceptParking" } = {}) => {
  const repo = tempRepo();
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  // W1-R1-2: every write to conversation.md fails once the run's state is prepared.
  let armed = false;
  const store = (s: StoreShape): StoreShape => ({
    ...s,
    // W2-R1-1: "exceptParking" lets the parking's own line through, so the parking completes and the label's
    // repeats are what meets the failing writes.
    converse: (markdown) => (armed && !(options.failWrites === "exceptParking" && markdown.includes(prompts.parkedLineOpening("abandoned"))) ? Effect.fail(new FileSystemError({ operation: "append", path: "conversation.md", message: "disk full" })) : s.converse(markdown)),
  });
  const { layer, probe } = testLayer(repo, { tracker, config: { maxTrackerRetries: 1, trackerRetryDelaySeconds: 0.01 }, store });
  const start = git(repo, "rev-parse", "HEAD");
  const prepared = Effect.gen(function* () {
    const store = yield* Store;
    yield* store.init("task");
    yield* store.writeBaseline();
    if (options.work ?? true) {
      fs.writeFileSync(path.join(repo, "committed.txt"), "c\n");
      git(repo, "add", "committed.txt");
      git(repo, "commit", "-qm", "the run's commit");
      if (options.leftover ?? true) fs.writeFileSync(path.join(repo, "left.txt"), "l\n");
    }
    if (options.lock === true) fs.writeFileSync(path.join(repo, ".git", "index.lock"), "");
    if (options.failWrites !== undefined && options.failWrites !== false) armed = true;
  });
  const runIt = () =>
    Effect.runPromiseExit(Effect.andThen(prepared, abandonRun(scriptedItem.id)).pipe(Effect.provide(Layer.merge(layer as Layer.Layer<Services>, Layer.succeed(Tracker, tracker.tracker)))));
  const conversation = () => fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
  return { repo, probe, start, runIt, conversation };
};
const held = async (tracker: FakeTracker) => (await Effect.runPromise(tracker.items))[0]!;
const success = <A, E>(exit: Exit.Exit<A, E>): A => {
  assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");
  return exit.value;
};

test("the work is moved to the branch, the working branch reset, and the label set to refined, each said and written", async () => {
  const tracker = fakeTrackerOf([implementing]);
  const s = setup(tracker);
  const abandoned = success(await s.runIt());
  const tip = git(s.repo, "rev-parse", `refs/heads/${branch}`);
  assert.deepEqual(abandoned, { park: { _tag: "Parked", branch, commit: tip }, label: { _tag: "SetRefined" } });
  assert.equal(git(s.repo, "rev-parse", "HEAD"), s.start);
  assert.equal((await held(tracker)).state, "refined");
  const line = prompts.abandonLabelSetLine(scriptedItem.id, branch);
  assert.ok(s.conversation().includes(line) && s.probe.ui.said.includes(line));
  assert.ok(s.conversation().includes(prompts.PARK_UNCHECKED_SENTENCE));
  assert.deepEqual(s.probe.ui.asked, []);
});

test("nothing to park: the label is set and no branch made", async () => {
  const tracker = fakeTrackerOf([implementing]);
  const s = setup(tracker, { work: false });
  assert.deepEqual(success(await s.runIt()), { park: { _tag: "NothingParked" }, label: { _tag: "SetRefined" } });
  assert.equal(git(s.repo, "branch", "--list", branch), "");
  assert.equal((await held(tracker)).state, "refined");
});

test("a parking refused by a held index.lock keeps the label implementing, sends no tracker request, and names git's message", async () => {
  const tracker = fakeTrackerOf([implementing]);
  const s = setup(tracker, { lock: true });
  const abandoned = success(await s.runIt());
  assert.equal(abandoned.park._tag, "ParkFailed");
  assert.deepEqual(abandoned.label, { _tag: "KeptImplementing" });
  assert.equal((await held(tracker)).state, "implementing");
  assert.match(s.conversation(), /git add.*index\.lock/s);
  assert.ok(s.conversation().includes("keeps the label `implementing`"));
});

test("the label request failing for good, read back as implementing: StillHeld with the last error, nothing asked, no decision", async () => {
  const tracker = fakeTrackerOf([implementing]);
  const s = setup(tracker);
  await Effect.runPromise(tracker.failNext("setState", serverError("GitHub answered with status 502, first")));
  await Effect.runPromise(tracker.failNext("setState", serverError("GitHub answered with status 502, last")));
  const abandoned = success(await s.runIt());
  const cause = "GitHub answered with status 502, last";
  assert.equal(abandoned.label._tag, "StillHeld");
  assert.ok(abandoned.label._tag === "StillHeld" && abandoned.label.state === "implementing" && abandoned.label.cause.includes(cause));
  assert.deepEqual(s.probe.ui.asked, []);
  const text = s.conversation();
  assert.ok(text.includes("still carries the label `implementing`") && text.includes(cause), text);
  assert.ok(s.probe.ui.said.some((l) => l.includes("still carries the label `implementing`")));
  assert.ok(text.includes("asked nothing, because the run was abandoned"));
  assert.ok(!text.includes("**User decision:**"));
});

test("the label request and its read-back failing: Unconfirmed with the last error, the label never claimed", async () => {
  const tracker = fakeTrackerOf([implementing]);
  const s = setup(tracker);
  for (const m of ["first", "last"]) {
    await Effect.runPromise(tracker.failNext("setState", unreached(`no answer, ${m}`)));
  }
  const abandoned = success(await s.runIt());
  assert.ok(abandoned.label._tag === "Unconfirmed" && abandoned.label.cause.includes("no answer, last"));
  const text = s.conversation();
  assert.ok(text.includes("could not be confirmed as `refined`") && text.includes("no answer, last"), text);
  assert.ok(!text.includes("**User decision:**"));
});

// Work review 1 of issue #185 (W1-R1-2): a parking that failed is never lost to a record that cannot be written.
test("a failed parking whose line cannot be written still returns ParkFailed with the label implementing kept", async () => {
  const tracker = fakeTrackerOf([implementing]);
  const s = setup(tracker, { lock: true, failWrites: true });
  const abandoned = success(await s.runIt());
  assert.equal(abandoned.park._tag, "ParkFailed");
  assert.deepEqual(abandoned.label, { _tag: "KeptImplementing" });
  assert.equal((await held(tracker)).state, "implementing");
});

test("abandonedAfterFailure: a parking not recorded Parked or Nothing is ParkFailed with the label kept; a completed one keeps its note", () => {
  const cause = "the tracker failed";
  const failed = { park: { _tag: "ParkFailed", message: cause }, label: { _tag: "KeptImplementing" } };
  assert.deepEqual(abandonedAfterFailure(null, cause), failed);
  const time = "2026-10-29T00:00:00.000Z";
  const start_commit = "a".repeat(40);
  assert.deepEqual(abandonedAfterFailure({ _tag: "Intended", version: 2, branch, start_commit, time, ending: "abandoned" }, cause), failed);
  const parked = { _tag: "Parked" as const, version: 2 as const, branch, commit: "b".repeat(40), start_commit, committed: ["left.txt"], recorded: true, time, ending: "abandoned" as const };
  assert.deepEqual(abandonedAfterFailure(parked, cause), {
    park: { _tag: "Parked", branch, commit: "b".repeat(40) },
    label: { _tag: "Unconfirmed", cause },
  });
  assert.deepEqual(abandonedAfterFailure({ _tag: "Nothing", version: 2, time, ending: "abandoned" }, cause), { park: { _tag: "NothingParked" }, label: { _tag: "Unconfirmed", cause } });
});

// Work review 1 of issue #185 (W1-R1-4): the page, as conversation.md does, says that the parking commit skipped the
// project's hooks and that the committed work was not checked.
test("an abandonment with leftovers says on the page that the commit skipped the hooks; conversation.md holds the parking line once", async () => {
  const tracker = fakeTrackerOf([implementing]);
  const s = setup(tracker);
  success(await s.runIt());
  const said = s.probe.ui.said.filter((l) => l.includes(prompts.PARK_UNCHECKED_SENTENCE));
  assert.equal(said.length, 1, s.probe.ui.said.join("\n"));
  assert.ok(said[0]!.includes(branch));
  const opening = prompts.parkedLineOpening("abandoned");
  assert.equal(s.conversation().split(opening).length - 1, 1, s.conversation());
});

test("an abandonment whose run committed everything itself does not say the hooks were skipped", async () => {
  const tracker = fakeTrackerOf([implementing]);
  const s = setup(tracker, { leftover: false });
  const abandoned = success(await s.runIt());
  assert.equal(abandoned.park._tag, "Parked");
  assert.ok(!s.probe.ui.said.some((l) => l.includes(prompts.PARK_UNCHECKED_SENTENCE)));
});

// Work review 2 of issue #185 (W2-R1-1): a write to conversation.md that fails never cuts the label's repeats short.
test("a label request failing once while conversation.md cannot be written is repeated and sets the label", async () => {
  const tracker = fakeTrackerOf([implementing]);
  const s = setup(tracker, { failWrites: "exceptParking" });
  await Effect.runPromise(tracker.failNext("setState", serverError("GitHub answered with status 502, once")));
  const abandoned = success(await s.runIt());
  assert.deepEqual(abandoned.label, { _tag: "SetRefined" });
  assert.equal((await held(tracker)).state, "refined");
});

test("a label request failing for good while conversation.md cannot be written is StillHeld with the last error", async () => {
  const tracker = fakeTrackerOf([implementing]);
  const s = setup(tracker, { failWrites: "exceptParking" });
  await Effect.runPromise(tracker.failNext("setState", serverError("GitHub answered with status 502, first")));
  await Effect.runPromise(tracker.failNext("setState", serverError("GitHub answered with status 502, last")));
  const abandoned = success(await s.runIt());
  assert.ok(abandoned.label._tag === "StillHeld" && abandoned.label.state === "implementing" && abandoned.label.cause.includes("502, last"), JSON.stringify(abandoned.label));
});

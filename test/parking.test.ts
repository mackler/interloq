// Issue #147 (S8): parking a halted run's work over a real store and temporary repositories, and finishing it after a
// restart at each boundary between its recorded phases.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { platformLayer } from "../src/platform.ts";
import { makeStore } from "../src/store.ts";
import type { StoreShape } from "../src/services.ts";
import { parkHalted } from "../src/parking.ts";
import type { ParkNote } from "../src/chain.ts";
import { parkBranchOf, parkTrailerOf } from "../src/park.ts";
import { parkCommitMessage, parkedRecordLine } from "../src/prompts.ts";
import { itemIdOf } from "../src/tracker.ts";
import { tempRepo, TEST_ROOT } from "./helpers.ts";

const run = Effect.runPromise;
const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const item = Result.getOrThrow(itemIdOf("147"));
const branch = Result.getOrThrow(parkBranchOf(item, TEST_ROOT));
const write = (repo: string, name: string, text: string) => fs.writeFileSync(path.join(repo, name), text);

type Halted = { repo: string; store: StoreShape; start: string };
/** A run that began, committed one change of its own and left another uncommitted, then halted. */
const halted = async (options: { baseline?: boolean; work?: boolean } = {}): Promise<Halted> => {
  const repo = tempRepo();
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  const store = await run(makeStore(repo, TEST_ROOT, []).pipe(Effect.provide(platformLayer)));
  await run(store.init("task"));
  if (options.baseline ?? true) await run(store.writeBaseline());
  const start = git(repo, "rev-parse", "HEAD");
  if (options.work ?? true) {
    write(repo, "committed.txt", "the run's commit\n");
    git(repo, "add", "committed.txt");
    git(repo, "commit", "-qm", "the run's own commit");
    write(repo, "left.txt", "left uncommitted\n");
  }
  return { repo, store, start };
};
const parked = (store: StoreShape) => run(store.loadParked());
const conversation = (store: StoreShape) => fs.readFileSync(path.join(store.dir, "conversation.md"), "utf8");

/** The end state every completed parking reaches. */
const assertParked = async ({ repo, store, start }: Halted, note: ParkNote) => {
  const tip = git(repo, "rev-parse", `refs/heads/${branch}`);
  assert.deepEqual(note, { _tag: "Parked", branch, commit: tip });
  assert.equal(git(repo, "rev-parse", "HEAD"), start);
  assert.ok(!fs.existsSync(path.join(repo, "left.txt")) && !fs.existsSync(path.join(repo, "committed.txt")));
  assert.equal(git(repo, "log", "--format=%H", `--grep=${parkTrailerOf(TEST_ROOT)}`, "--fixed-strings", `${start}..${branch}`).split("\n").filter((l) => l !== "").length, 1);
  assert.deepEqual(git(repo, "show", "--name-only", "--format=", branch).split("\n"), ["left.txt"]);
  const record = await parked(store);
  assert.ok(record?._tag === "Parked" && record.recorded);
  assert.deepEqual(record?._tag === "Parked" && record.committed, ["left.txt"]);
  assert.ok(record?._tag === "Parked" && conversation(store).includes(parkedRecordLine({ ...record, recorded: false })));
};

test("a halted run's commits and leftovers go to its branch, HEAD returns to the start, and the record and line are written", async () => {
  const h = await halted();
  await assertParked(h, await run(parkHalted(h.store, item)));
  assert.match(git(h.repo, "log", "-1", "--format=%B", branch), /--no-verify/);
});

test("no baseline: nothing to park, recorded as such", async () => {
  const h = await halted({ baseline: false, work: false });
  assert.deepEqual(await run(parkHalted(h.store, item)), { _tag: "NothingParked" });
  assert.equal((await parked(h.store))?._tag, "Nothing");
});

test("a run that committed nothing and left nothing parks nothing and makes no branch", async () => {
  const h = await halted({ work: false });
  assert.deepEqual(await run(parkHalted(h.store, item)), { _tag: "NothingParked" });
  assert.equal(git(h.repo, "branch", "--list", branch), "");
});

test("a reset that would overwrite the developer's change is ParkFailed with git's message", async () => {
  const h = await halted({ work: false });
  write(h.repo, "a.txt", "the run's change\n");
  git(h.repo, "commit", "-qam", "the run changed a.txt");
  // The developer's file appears after the leftovers' commit: a change to a.txt that the reset would overwrite.
  const store: StoreShape = { ...h.store, branchTip: (b) => h.store.branchTip(b).pipe(Effect.tap(() => Effect.sync(() => write(h.repo, "a.txt", "the developer's\n")))) };
  const note = await run(parkHalted(store, item));
  assert.equal(note._tag, "ParkFailed");
  assert.match(note._tag === "ParkFailed" ? note.message : "", /a\.txt|overwritten|not uptodate/i);
});

test("a branch of that name at another commit is refused, not overwritten", async () => {
  const h = await halted();
  git(h.repo, "branch", branch, h.start);
  const note = await run(parkHalted(h.store, item));
  assert.equal(note._tag, "ParkFailed");
  assert.equal(git(h.repo, "rev-parse", branch), h.start);
});

// The restart boundaries: the phases run by hand up to each, then parkHalted called again.
const intended = async (h: Halted) => run(h.store.saveParked({ _tag: "Intended", version: 2, branch, start_commit: h.start, time: "t" }));
const committedLeftovers = async (h: Halted) => {
  await intended(h);
  await run(h.store.commitLeftovers(parkCommitMessage(item, TEST_ROOT, branch)));
};
const branched = async (h: Halted) => {
  await committedLeftovers(h);
  await run(h.store.createBranch(branch));
};
const reset = async (h: Halted) => {
  await branched(h);
  await run(h.store.resetTo(h.start));
};
const unrecorded = async (h: Halted) => {
  await reset(h);
  await run(h.store.saveParked({ _tag: "Parked", version: 2, branch, commit: git(h.repo, "rev-parse", branch), start_commit: h.start, committed: ["left.txt"], recorded: false, time: "t" }));
};

for (const [name, upTo] of [["Intended", intended], ["the commit", committedLeftovers], ["the branch", branched], ["the reset", reset], ["Parked unrecorded", unrecorded]] as const) {
  test(`a restart after ${name} finishes the parking`, async () => {
    const h = await halted();
    await upTo(h);
    await assertParked(h, await run(parkHalted(h.store, item)));
  });
}

test("a parking already recorded returns its note and changes nothing", async () => {
  const h = await halted();
  const first = await run(parkHalted(h.store, item));
  const text = conversation(h.store);
  assert.deepEqual(await run(parkHalted(h.store, item)), first);
  assert.equal(conversation(h.store), text);
});

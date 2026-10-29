// Issue #147 (S2): the parked branch's name, the park record and the texts that name the commit (src/park.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result, Schema } from "effect";
import { branchNameOf, PARK_NO_VERIFY, parkBranchOf, type ParkRecord, ParkRecordSchema, parkTrailerOf } from "../src/park.ts";
import { PARK_UNCHECKED_SENTENCE, parkCommitMessage, parkedRecordLine } from "../src/prompts.ts";
import { PARKED_ENDINGS } from "../src/runEnding.ts";
import { runRootOf } from "../src/artifacts.ts";
import { itemIdOf } from "../src/tracker.ts";

const item = Result.getOrThrow(itemIdOf("147"));
const root = runRootOf("implementation", "147", "2026-10-20T09:32:05.469Z");

test("the branch is the item and the run's records directory under Interloq's prefix", () => {
  assert.equal(Result.getOrThrow(parkBranchOf(item, root)), "interloq/halted/147/2026-10-20T09-32-05-469Z-implementation-147");
});

test("every form git refuses is refused", () => {
  for (const bad of ["a/.b", "a..b", "a@{b", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a/b.lock", "a/", "a//b", "a.", "@", "a\u0001b", "a\u007fb"]) {
    assert.equal(Result.isFailure(branchNameOf(bad)), true, bad);
  }
  assert.equal(Result.isSuccess(branchNameOf("interloq/halted/x/y")), true);
});

test("each park record round-trips through its schema", () => {
  const decode = Schema.decodeUnknownSync(ParkRecordSchema);
  for (const ending of [null, ...PARKED_ENDINGS]) {
    const records: readonly ParkRecord[] = [
      { _tag: "Intended", version: 2, branch: "b", start_commit: "s", time: "t", ending },
      { _tag: "Parked", version: 2, branch: "b", commit: "c", start_commit: "s", committed: ["a.txt"], recorded: false, time: "t", ending },
      { _tag: "Nothing", version: 2, time: "t", ending },
    ];
    for (const r of records) assert.deepEqual(decode(JSON.parse(JSON.stringify(r))), r);
  }
});

// Issue #185: a parked.json written before the ending was recorded decodes with the ending null.
test("a park record without its ending decodes with null", () => {
  const decode = Schema.decodeUnknownSync(ParkRecordSchema);
  for (const r of [
    { _tag: "Intended", version: 2, branch: "b", start_commit: "s", time: "t" },
    { _tag: "Parked", version: 2, branch: "b", commit: "c", start_commit: "s", committed: [], recorded: true, time: "t" },
    { _tag: "Nothing", version: 2, time: "t" },
  ])
    assert.equal(decode(r).ending, null, r._tag);
});

// Issue #185 (G-R1-1): the commit message and the conversation.md line both say the hooks were skipped and the work unchecked.
test("for every ending the commit message and the record line name the flag and that the work was not checked", () => {
  const branch = Result.getOrThrow(parkBranchOf(item, root));
  for (const ending of PARKED_ENDINGS) {
    const message = parkCommitMessage(item, root, branch, ending);
    const line = parkedRecordLine({ _tag: "Parked", version: 2, branch, commit: "c1", start_commit: "s1", committed: ["a.txt"], recorded: false, time: "t", ending }, ending);
    for (const text of [message, line]) {
      assert.ok(text.includes(PARK_NO_VERIFY), text);
      assert.ok(text.includes(PARK_UNCHECKED_SENTENCE), text);
    }
  }
});

test("the commit message ends with the trailer, and it and the record line name the flag and the branch from one source", () => {
  const branch = Result.getOrThrow(parkBranchOf(item, root));
  const message = parkCommitMessage(item, root, branch);
  assert.equal(message.split("\n").at(-1), parkTrailerOf(root));
  const line = parkedRecordLine({ _tag: "Parked", version: 2, branch, commit: "c1", start_commit: "s1", committed: ["a.txt"], recorded: false, time: "t", ending: "halted" });
  for (const text of [message, line]) {
    assert.ok(text.includes(PARK_NO_VERIFY), text);
    assert.ok(text.includes(branch), text);
  }
  assert.ok(line.includes("s1") && line.includes("c1") && line.includes("a.txt"));
});

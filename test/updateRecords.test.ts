import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Option, Schema } from "effect";
import { guardedRecord, pathOf, reviewedFile, subjectDir, subjectOf } from "../src/artifacts.ts";
import { ServerMessageSchema } from "../src/protocol.ts";
import { idPrefixOf } from "../src/reviewState.ts";
import { subjectHeading } from "../src/render.ts";
import { documentLabel, passNoun } from "../src/prompts.ts";
import { Store } from "../src/services.ts";
import { itemTextOf } from "../src/refinement.ts";
import { Result } from "effect";
import { tempRepo, testLayer } from "./helpers.ts";

// Issue #216 (S6): the update subject's identity, records and phase.

test("the update subject: directory, its inverse, log, reviewed file, records, id prefix and headings", () => {
  assert.equal(subjectDir("update"), "update-check");
  assert.equal(subjectOf(subjectDir("update")), "update");
  assert.equal(pathOf({ kind: "log", subject: "update" }), "update-log.json");
  assert.deepEqual(reviewedFile("update"), { kind: "issue" });
  assert.equal(pathOf({ kind: "issue" }), "issue.json");
  assert.equal(pathOf({ kind: "issueBefore" }), "issue-before.json");
  assert.equal(pathOf({ kind: "cited" }), "cited-issues.md");
  for (const kind of ["issue", "issueBefore", "cited"] as const) assert.ok(guardedRecord(pathOf({ kind })));
  assert.equal(idPrefixOf("update"), "U");
  assert.equal(subjectHeading("update"), "Bring Up to Date");
  assert.equal(documentLabel("update"), "Issue brought up to date");
  assert.equal(passNoun("update"), "check");
  assert.equal(passNoun("questions"), "review");
});

test("an event of the phase and its subject crosses the protocol", () => {
  const frame = { type: "event", run: 1, seq: 1, time: "2026-11-02T00:00:00Z", event: { _tag: "Notified", event: { _tag: "PhaseBegan", phase: { kind: "update" } } } };
  assert.ok(Result.isSuccess(Schema.decodeUnknownResult(ServerMessageSchema)(frame)));
});

test("the store writes issue-before.json, issue.json and cited-issues.md, and loadIssue reads back saveIssue", async () => {
  const repo = await tempRepo();
  const before = Result.getOrThrow(itemTextOf("T", "x"));
  const file = { version: 2 as const, title: "T2", text: "y", outcome: { kind: "current" as const }, developer_passages: ["p"], protected: ["q"] };
  const [read, readBefore] = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.saveIssueBefore(before);
      yield* store.saveIssue(file);
      yield* store.saveCitedIssues("# Cited issues\n");
      return [yield* store.loadIssue(), yield* store.loadIssueBefore()] as const;
    }).pipe(Effect.provide(testLayer(repo).layer)),
  );
  assert.deepEqual(read, file);
  assert.deepEqual(readBefore, { title: "T", text: "x" });
  void Option;
});

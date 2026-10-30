import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { commentDateOf, commentKeyOf, commentsTaskText, commentText, parseComment } from "../src/itemComments.ts";
import { COMMENTS_TASK_HEADING, commentTaskLine } from "../src/prompts.ts";
import { seededId } from "./fakeTracker.ts";

// Issue #186: examples of Interloq's comments on an item.
const key = (t: string) => Result.getOrThrow(commentKeyOf(t));

test("a developer's comment that quotes a marker in its middle is not Interloq's", () => {
  assert.equal(parseComment("I saw\n<!-- interloq:sent-back key=a/verdict-1 -->\nin the log, and it is wrong"), null);
  assert.equal(parseComment("plain words"), null);
  assert.equal(parseComment(""), null);
});

test("a marker followed by blank lines is still the last non-blank line", () => {
  assert.deepEqual(parseComment("words\n<!-- interloq:refinement key=r asked=no -->\n\n  \n"), { _tag: "RefinementRecord", key: "r", asked: false });
});

test("a key with whitespace, an arrow's end, or nothing in it is refused", () => {
  for (const bad of ["a b", "a-->b", "", "a\nb"]) assert.ok(Result.isFailure(commentKeyOf(bad)), bad);
  assert.ok(Result.isSuccess(commentKeyOf("2026-10-29T09-40-49-531Z-implementation-186/verdict-1")));
});

test("the comments of a refinement's task: none is empty, records and markers left out, the developer's included", () => {
  assert.equal(commentsTaskText([]), "");
  const record = { id: seededId(), body: commentText({ _tag: "RefinementRecord", key: key("r"), date: "2026-10-01", asked: true }), created: "2026-10-01T10:00:00Z" };
  assert.equal(commentsTaskText([record]), "");
  const sent = { id: seededId(), body: commentText({ _tag: "SentBack", key: key("i/verdict-1"), date: "2026-10-02", missing: "The retention period." }), created: "2026-10-02T10:00:00Z" };
  const mine = { id: seededId(), body: "Keep them 30 days.", created: "2026-10-03T08:00:00Z" };
  const text = commentsTaskText([record, sent, mine]);
  assert.ok(text.startsWith(COMMENTS_TASK_HEADING));
  assert.ok(text.includes(commentTaskLine("2026-10-02")) && text.includes("The retention period."));
  assert.ok(text.indexOf("The retention period.") < text.indexOf("Keep them 30 days."));
  assert.ok(!text.includes("interloq:"));
  assert.ok(!text.includes(commentTaskLine("2026-10-01")));
});

test("a comment's date is the instant's UTC day", () => {
  assert.equal(commentDateOf(Date.UTC(2026, 9, 29, 23, 59)), "2026-10-29");
});

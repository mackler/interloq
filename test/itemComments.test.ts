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

// Issue #131: the preparation's two markers, recognized here, so the retry reconciles their writes by key.
test("the preparation's two marker lines parse to their kind and key", async () => {
  const { keyOf, preparationMarkerLine, runCommentKey } = await import("../src/itemComments.ts");
  const own = runCommentKey("2026-10-30T00-00-00-000Z-preparation-131");
  const question = runCommentKey("2026-10-30T00-00-00-000Z-preparation-131", "q-1");
  assert.deepEqual(parseComment(`words\n\n${preparationMarkerLine("Preparation", own)}`), { _tag: "Preparation", key: own });
  assert.deepEqual(parseComment(`words\n\n${preparationMarkerLine("PreparedQuestion", question)}`), { _tag: "PreparedQuestion", key: question });
  assert.equal(keyOf(`x\n${preparationMarkerLine("PreparedQuestion", question)}`), question);
});
test("commentsTaskText leaves the preparation's comments out", async () => {
  const { preparationMarkerLine, runCommentKey } = await import("../src/itemComments.ts");
  const sent = { id: seededId("1"), body: commentText({ _tag: "SentBack", key: Result.getOrThrow(commentKeyOf("i/verdict-1")), date: "2026-10-02", missing: "The retention period." }), created: "2026-10-02T10:00:00Z" };
  const mine = { id: seededId("2"), body: "Keep them 30 days.", created: "2026-10-03T08:00:00Z" };
  const prepared = { id: seededId("3"), body: `A prepared question\n\n${preparationMarkerLine("PreparedQuestion", runCommentKey("p", "q-1"))}`, created: "2026-10-04T08:00:00Z" };
  const own = { id: seededId("4"), body: `Prepared\n\n${preparationMarkerLine("Preparation", runCommentKey("p"))}`, created: "2026-10-04T08:00:01Z" };
  const text = commentsTaskText([sent, prepared, mine, own]);
  assert.equal(text, commentsTaskText([sent, mine]));
  assert.ok(!text.includes("prepared question") && !text.includes("Prepared"));
});

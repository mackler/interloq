import assert from "node:assert/strict";
import { test } from "node:test";
import { Option, Result, Schema } from "effect";
import { GithubIssue, isPullRequest, issueNumberOf, itemOf, labelNamesOf, nextPage, relabeled, stateOf } from "../src/githubIssues.ts";
import { type ItemId, itemIdOf } from "../src/tracker.ts";
import { LABELS } from "./githubLabels.ts";

// Issue #120, part 1: what the GitHub adapter decides without I/O.
const id = (text: string): ItemId => Result.getOrThrow(itemIdOf(text));
const decode = Schema.decodeUnknownSync(GithubIssue);

test("an issue as GitHub returns it decodes, its labels objects or strings, unknown fields ignored", () => {
  const issue = decode({ number: 7, title: "t", body: null, state: "open", labels: [{ id: 1, name: "bug", color: "f00" }, "stage: refined"], user: { login: "x" } });
  assert.deepEqual(labelNamesOf(issue), ["bug", "stage: refined"]);
  assert.equal(isPullRequest(issue), false);
  assert.equal(isPullRequest(decode({ number: 8, title: "pr", body: "", state: "open", labels: [], pull_request: { url: "u" } })), true);
});

test("stateOf: one stage label is its state, other labels ignored", () => {
  assert.deepEqual(stateOf(LABELS, { open: true, labelNames: ["bug", "stage: refined"] }), Result.succeed("refined"));
  assert.deepEqual(stateOf(LABELS, { open: false, labelNames: ["stage: implemented"] }), Result.succeed("implemented"));
});

test("stateOf: no stage label is unrefined when open and no state when closed", () => {
  assert.deepEqual(stateOf(LABELS, { open: true, labelNames: ["bug"] }), Result.succeed("unrefined"));
  const closed = stateOf(LABELS, { open: false, labelNames: [] });
  assert.ok(Result.isFailure(closed));
  assert.equal(closed.failure._tag, "NoState");
});

test("stateOf: two stage labels are ambiguous, naming them", () => {
  const two = stateOf(LABELS, { open: true, labelNames: ["stage: implementing", "bug", "stage: refined"] });
  assert.ok(Result.isFailure(two));
  assert.deepEqual(two.failure, { _tag: "Ambiguous", labels: ["stage: implementing", "stage: refined"] });
});

test("itemOf: the id is the decimal number, a null body the empty string", () => {
  const item = itemOf(LABELS, decode({ number: 42, title: "title", body: null, state: "open", labels: [] }));
  assert.deepEqual(item, Result.succeed({ id: id("42"), title: "title", body: "", state: "unrefined", url: Option.none() }));
});

test("itemOf: an issue's html_url is its address; none without one or with an address that is not https, and the item stands", () => {
  const page = "https://github.com/mackler/interloq/issues/42";
  const of = (more: Record<string, unknown>) => Result.getOrThrow(itemOf(LABELS, decode({ number: 42, title: "title", body: null, state: "open", labels: [], ...more }))).url;
  assert.deepEqual(of({ html_url: page }), Option.some(page));
  assert.deepEqual(of({}), Option.none());
  assert.deepEqual(of({ html_url: "javascript:alert(1)" }), Option.none());
});

test("nextPage finds rel=\"next\" in a Link header as GitHub sends it", () => {
  const link = '<https://api.github.com/repositories/1/issues?state=open&per_page=100&page=2>; rel="next", <https://api.github.com/repositories/1/issues?state=open&per_page=100&page=5>; rel="last"';
  assert.deepEqual(nextPage(link), Option.some("https://api.github.com/repositories/1/issues?state=open&per_page=100&page=2"));
  assert.deepEqual(nextPage('<https://x/?page=1>; rel="prev", <https://x/?page=1>; rel="first"'), Option.none());
  assert.deepEqual(nextPage(undefined), Option.none());
  assert.deepEqual(nextPage(""), Option.none());
});

test("issueNumberOf: a positive decimal without leading zeros, else none", () => {
  assert.deepEqual(issueNumberOf(id("120")), Option.some(120));
  for (const text of ["0", "012", "-1", "1.5", "abc", "1e3", "99999999999999999999", " 1"]) assert.deepEqual(issueNumberOf(id(text)), Option.none(), text);
});

test("relabeled removes every stage label, adds the new state's, and keeps the others in order", () => {
  assert.deepEqual(relabeled(["bug", "stage: implementing", "ui"], LABELS, "refined"), ["bug", "ui", "stage: refined"]);
  assert.deepEqual(relabeled([], LABELS, "implementing"), ["stage: implementing"]);
  assert.deepEqual(relabeled(["stage: implementing", "stage: refined"], LABELS, "refined"), ["stage: refined"]);
});

// Issue #131: every comment carries its id, so Interloq can delete its own.
test("a GitHub comment as the port's comment carries its id as a string", async () => {
  const { commentOf, GithubComment } = await import("../src/githubIssues.ts");
  const comment = commentOf(Schema.decodeUnknownSync(GithubComment)({ id: 77, body: "b", created_at: "2026-10-01T00:00:00Z" }));
  assert.deepEqual(comment, { id: "77", body: "b", created: "2026-10-01T00:00:00Z" });
});

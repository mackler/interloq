import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionTooLongText } from "../src/prompts.ts";
import { ClaudeSessionTooLong, ConfigInvalid, DecisionFormatUnreadable, decodeRunError, GitError, haltMessage, ProjectChanged, RecordsChanged, RoundInvalid, RoundLimitStop } from "../src/errors.ts";

test("haltMessage reports a typed error with its description", () => {
  const error = new ProjectChanged({ during: "planning", fileLabel: null, changes: [{ kind: "content_changed", path: "a.txt" }] });
  const message = haltMessage(error);
  assert.match(message ?? "", /^HALTED: the project outside plan-review\/ changed during a planning-phase call/);
  assert.match(message ?? "", /a\.txt/);
});

test("haltMessage returns null for an unrelated error", () => {
  assert.equal(haltMessage(new TypeError("x is not a function")), null);
});

test("haltMessage reports ConfigInvalid with the file and field path", () => {
  const error = new ConfigInvalid({ file: "/p/plan-review/config.json", path: "maxRounds", message: "Expected number" });
  assert.equal(haltMessage(error), "HALTED: /p/plan-review/config.json is not a valid configuration: Expected number (at maxRounds)");
});

// Finding 10: a value that only carries one of our tags is not one of our errors; the payload is validated.
test("haltMessage returns null for a tagged value without the payload of its tag", () => {
  assert.equal(haltMessage({ _tag: "GitError" }), null);
  assert.equal(haltMessage({ _tag: "ProjectChanged", during: "planning", fileLabel: null, changes: "none" }), null);
  assert.equal(haltMessage({ _tag: "NotOurs", message: "m" }), null);
});

test("decodeRunError accepts an instance and a plain payload alike, and haltMessage renders both", () => {
  const instance = new GitError({ args: ["status"], message: "not a repository" });
  assert.equal(haltMessage(instance), "HALTED: git status failed: not a repository");
  const plain = { _tag: "GitError", args: ["status"], message: "not a repository" };
  assert.equal(decodeRunError(plain)?._tag, "GitError");
  assert.equal(haltMessage(plain), "HALTED: git status failed: not a repository");
  assert.equal(decodeRunError(null), null);
});

// Stage A (finding 1 of docs/gui-review.md).
test("RecordsChanged names the changed records, round-trips through decodeRunError and is rendered by haltMessage", () => {
  const error = new RecordsChanged({ changes: [{ kind: "content_changed", path: "plan.md" }, { kind: "added", path: "notes/x.md" }] });
  const message = haltMessage(error);
  assert.match(message ?? "", /^HALTED: a record under plan-review\/ changed during a read-only response/);
  assert.match(message ?? "", /content changed: plan\.md/);
  assert.match(message ?? "", /added: notes\/x\.md/);
  assert.deepEqual(decodeRunError({ _tag: "RecordsChanged", changes: [{ kind: "removed", path: "requirements.md" }] }), { _tag: "RecordsChanged", changes: [{ kind: "removed", path: "requirements.md" }] });
});

// Issue #14: the user reads "cycle" where the program says "round".
test("the cycle limit's stop and an invalid cycle are described in cycles", () => {
  assert.equal(haltMessage(new RoundLimitStop({ heading: "Planning phase 1" })), "HALTED: stopped by the user at the cycle limit of Planning phase 1");
  const invalid = new RoundInvalid({ duplicateIssues: ["A"], missing: [], duplicateDispositions: [], unknownDispositions: [], emptyIds: [], collidingIds: [] });
  assert.match(haltMessage(invalid) ?? "", /^HALTED: the cycle is invalid: /);
});

// Decision support, plan step 2.1: the format of docs/decision-making.md is read before the run.
test("DecisionFormatUnreadable names the file, round-trips through decodeRunError and is rendered by haltMessage", () => {
  const error = new DecisionFormatUnreadable({ file: "/opt/interloq/docs/decision-making.md", message: "ENOENT" });
  assert.equal(haltMessage(error), "HALTED: the decision-making format /opt/interloq/docs/decision-making.md could not be read: ENOENT");
  assert.equal(decodeRunError({ _tag: "DecisionFormatUnreadable", file: "f", message: "m" })?._tag, "DecisionFormatUnreadable");
});

// Issue #122: a session too long for Claude Code to accept is a halt of its own, naming its cause.
test("ClaudeSessionTooLong names the cause, round-trips through decodeRunError and is rendered by haltMessage", () => {
  const error = new ClaudeSessionTooLong({ message: "Prompt is too long" });
  assert.equal(haltMessage(error), `HALTED: ${sessionTooLongText("Prompt is too long")}`);
  assert.match(sessionTooLongText("Prompt is too long"), /session/);
  assert.equal(decodeRunError({ _tag: "ClaudeSessionTooLong", message: "Prompt is too long" })?._tag, "ClaudeSessionTooLong");
});

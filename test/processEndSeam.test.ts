import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { processEndOf } from "../src/transport.ts";

// Issue #157: the seam between the Agent SDK's error for a Claude Code process that ended abnormally and what
// processEndOf reads. The SDK's own source (its entry, sdk.mjs) is read, so an upgrade that rewords the texts or drops the fields fails here.

const source = readFileSync(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"), "utf8");

const prefix = (phrase: string): string => {
  const m = source.match(new RegExp("Error\\(`(" + phrase + ")\\$\\{"));
  assert.ok(m !== null, `the SDK no longer throws "${phrase}"`);
  return m[1] ?? "";
};

test("the SDK's exit text reads back as the exit code", () => {
  const p = prefix("Claude Code process exited with code ");
  assert.deepEqual(processEndOf(new Error(`${p}3`)), { kind: "exit", code: 3 });
  assert.deepEqual(processEndOf(new Error(`${p}3. stderr: boom`)), { kind: "exit", code: 3 });
});

test("the SDK's signal text reads back as the signal", () => {
  const p = prefix("Claude Code process terminated by signal ");
  assert.deepEqual(processEndOf(new Error(`${p}SIGBUS`)), { kind: "signal", signal: "SIGBUS" });
  assert.deepEqual(processEndOf(new Error(`${p}SIGBUS. stderr: bus error`)), { kind: "signal", signal: "SIGBUS" });
});

test("the own fields the SDK attaches read back as the ending", () => {
  assert.match(source, /errorClass:"process_exited_nonzero",exitCode:/, "the SDK no longer attaches exitCode");
  assert.match(source, /errorClass:"process_killed_by_signal",signal:/, "the SDK no longer attaches signal");
  assert.deepEqual(processEndOf(Object.assign(new Error("reworded"), { errorClass: "process_exited_nonzero", exitCode: 7 })), { kind: "exit", code: 7 });
  assert.deepEqual(processEndOf(Object.assign(new Error("reworded"), { errorClass: "process_killed_by_signal", signal: "SIGSEGV" })), { kind: "signal", signal: "SIGSEGV" });
});

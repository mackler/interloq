import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProcessStatus } from "../src/liveOutput.ts";
import { outputEndedLine, outputRunningHeader } from "../src/prompts.ts";

// Issue #49: the panel's ended line names the process and, where given, its code or signal.

const STATUSES: readonly ProcessStatus[] = [
  { _tag: "Exited", code: 3 }, { _tag: "Signaled", signal: "SIGTERM" }, { _tag: "TimedOut" }, { _tag: "NotStarted" },
  { _tag: "Failed" }, { _tag: "Succeeded" }, { _tag: "Stopped" }, { _tag: "Unknown" },
];

test("outputEndedLine names the process for every status, and the code or signal where given", () => {
  for (const s of STATUSES) {
    const line = outputEndedLine("npm test", s);
    assert.ok(line.startsWith("npm test "), line);
    assert.ok(line.includes("ended"), line);
    if (s._tag === "Exited") assert.ok(line.includes("3"), line);
    if (s._tag === "Signaled") assert.ok(line.includes("SIGTERM"), line);
  }
  assert.equal(new Set(STATUSES.map((s) => outputEndedLine("x", s))).size, STATUSES.length);
});

test("outputRunningHeader names every running process, with its time where known", () => {
  const h = outputRunningHeader([{ name: "suite", seconds: null }, { name: "npm test", seconds: 65 }]);
  assert.ok(h.includes("suite") && h.includes("npm test") && /running/iu.test(h), h);
});

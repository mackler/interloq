import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProcessStatus } from "../src/liveOutput.ts";
import fc from "fast-check";
import { durationText, LIVE_OUTPUT_RESIZE_LABEL, LIVE_PROCESSES_NAME, outputEndedDetail, outputEndedLine, outputRunningName, panelHeightText } from "../src/prompts.ts";

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

// Issue #221: the accessible names of the panel's state icons and the short detail after an ended one.
test("outputRunningName names the process, and its time only where known", () => {
  assert.equal(outputRunningName("npm test", null), "npm test: running");
  assert.equal(outputRunningName("npm test", 42), `npm test: running for ${durationText(42000)}`);
});

test("outputEndedDetail gives the code or the signal in at most two words, and nothing for the other statuses", () => {
  assert.equal(outputEndedDetail({ _tag: "Exited", code: 3 }), "exit 3");
  assert.equal(outputEndedDetail({ _tag: "Signaled", signal: "SIGTERM" }), "SIGTERM");
  for (const s of STATUSES.filter((s) => s._tag !== "Exited" && s._tag !== "Signaled")) assert.equal(outputEndedDetail(s), "");
  for (const s of STATUSES) assert.ok(outputEndedDetail(s).split(" ").filter((w) => w !== "").length <= 2);
  assert.ok(LIVE_PROCESSES_NAME.length > 0 && LIVE_OUTPUT_RESIZE_LABEL.length > 0);
  assert.equal(panelHeightText(12), "12 lines");
});

test("outputEndedLine contains the code or signal its detail shows", () => {
  const arbStatus = fc.oneof(
    fc.integer({ min: -255, max: 255 }).map((code): ProcessStatus => ({ _tag: "Exited", code })),
    fc.constantFrom("SIGTERM", "SIGKILL", "SIGINT", "SIGBUS").map((signal): ProcessStatus => ({ _tag: "Signaled", signal })),
  );
  fc.assert(
    fc.property(arbStatus, (s) => {
      const word = outputEndedDetail(s).split(" ").at(-1) ?? "";
      assert.ok(outputEndedLine("x", s).includes(word));
    }),
    { numRuns: 100, seed: 20261102 },
  );
});

// Issue #171: the class of every status of a tracker's answer, for both adapters. A 2xx is no failure; a 4xx is a
// permanent failure (the credential refused, the item not found, or the request refused), never repeated; anything else
// is TrackerUnreachable carrying that status, which the tracker retry repeats.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { statusFailure, type Target } from "../src/github.ts";
import { gitlabStatusFailure, type GitlabTarget } from "../src/gitlabIssues.ts";
import type { TrackerError } from "../src/services.ts";
import type { ItemId } from "../src/tracker.ts";

const PERMANENT_4XX = new Set(["TrackerAuthRefused", "TrackerItemNotFound", "TrackerRequestRefused"]);
const classOf = (status: number, failure: TrackerError | null): boolean => {
  if (status >= 200 && status <= 299) return failure === null;
  if (status >= 400 && status <= 499) return failure !== null && PERMANENT_4XX.has(failure._tag);
  return failure !== null && failure._tag === "TrackerUnreachable" && failure.status === status;
};
const item = { kind: "item", id: "7" as ItemId } as const;
const listing = { kind: "listing", what: "the refined issues" } as const;

test("every status of GitHub's answer maps to its class", () => {
  fc.assert(fc.property(fc.integer({ min: 100, max: 599 }), fc.constantFrom<Target>(item, listing), (status, target) => classOf(status, statusFailure(status, "GET", target))), { numRuns: 500 });
});

test("every status of GitLab's answer maps to its class", () => {
  fc.assert(fc.property(fc.integer({ min: 100, max: 599 }), fc.constantFrom<GitlabTarget>(item, listing), (status, target) => classOf(status, gitlabStatusFailure(status, "GET", target))), { numRuns: 500 });
});

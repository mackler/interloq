import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { citationFormOf, citedIdsOf, citedIssuesMarkdown } from "../src/citations.ts";
import type { ItemId } from "../src/tracker.ts";
import { LABELS } from "./githubLabels.ts";

const RUNS = { numRuns: 200, seed: 20261102 };
const FORM = citationFormOf({ kind: "github", owner: "mackler", repo: "interloq", labels: LABELS, prepareLabel: null, obsoleteLabel: null });
const arbN = fc.integer({ min: 1, max: 9999 });

test("an id is returned once whatever the number of its citations, and an excluded id never", () => {
  fc.assert(fc.property(fc.array(arbN, { maxLength: 8 }), fc.option(arbN, { nil: undefined }), (ns, ex) => {
    const text = ns.map((n) => `see #${n}.`).join(" ");
    const got = citedIdsOf(text, FORM, ex === undefined ? [] : [String(ex) as ItemId]);
    const want = [...new Set(ns.map(String))].filter((n) => n !== String(ex));
    assert.deepEqual([...got], want);
  }), RUNS);
});

test("any body appears verbatim inside its fence", () => {
  fc.assert(fc.property(fc.array(fc.oneof(fc.string({ maxLength: 5 }), fc.constantFrom("`", "```", "````", "\n")), { maxLength: 10 }).map((ps) => ps.join("")), (body) => {
    const md = citedIssuesMarkdown([{ _tag: "Read", id: "1" as ItemId, title: "t", body, open: true }]);
    const longest = Math.max(0, ...(body.match(/`+/gu) ?? []).map((r) => r.length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    return md.includes(`${fence}\n${body}\n${fence}`);
  }), RUNS);
});

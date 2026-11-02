import assert from "node:assert/strict";
import { test } from "node:test";
import { citationFormOf, citedIdsOf, citedIssuesMarkdown } from "../src/citations.ts";
import type { ItemId } from "../src/tracker.ts";
import { LABELS } from "./githubLabels.ts";
import { GITLAB_LABELS, PROJECT } from "./gitlabLabels.ts";

// Issue #216 (requirements Q6): the issues an item cites, recognized in its text.
const GH = citationFormOf({ kind: "github", owner: "mackler", repo: "interloq", labels: LABELS, prepareLabel: null, obsoleteLabel: null });
const GL = citationFormOf({ kind: "gitlab", project: PROJECT, labels: GITLAB_LABELS, prepareLabel: null, obsoleteLabel: null });
const ids = (xs: readonly ItemId[]): string[] => [...xs];

test("#n and the own project's issue URLs count, once each, in order, without the excluded ids", () => {
  assert.deepEqual(ids(citedIdsOf("See #22, issue #4 and (#22). Also https://github.com/mackler/interloq/issues/7 and #216.", GH, ["216" as ItemId])), ["22", "4", "7"]);
  assert.deepEqual(ids(citedIdsOf(`#3 and https://gitlab.com/${PROJECT}/-/issues/9`, GL, [])), ["3", "9"]);
});

test("ids, entities, fragments, headings and other repositories do not count", () => {
  assert.deepEqual(ids(citedIdsOf("W1-R1-1 &#32; abc#5 ## Heading https://github.com/other/repo/issues/5 x/#6 #0 #012", GH, [])), []);
  assert.deepEqual(ids(citedIdsOf("https://gitlab.com/other/proj/-/issues/5", GL, [])), []);
});

test("the cited issues' file names each issue open or closed with its whole body, and an unreadable one with its reason", () => {
  const md = citedIssuesMarkdown([
    { _tag: "Read", id: "2" as ItemId, title: "Two", body: "text ```with``` fences", open: true },
    { _tag: "Read", id: "3" as ItemId, title: "Three", body: "", open: false },
    { _tag: "Unreadable", id: "4" as ItemId, reason: "the issue tracker has no item 4" },
  ]);
  assert.match(md, /## #2 \(open\): Two/u);
  assert.match(md, /## #3 \(closed\): Three/u);
  assert.match(md, /````\ntext ```with``` fences\n````/u);
  assert.match(md, /## #4 \(unreadable\)\n\nthe issue tracker has no item 4/u);
});

// The paragraphs of the "longChoices" scenario (issue #12), the long step label of the "planSteps" scenario (issue
// #116), and the long item of every scenario's tracker (issue #125), shared by e2e/server.ts, e2e/ports.ts and
// e2e/layout.spec.ts.

/** A plan step's label long enough to wrap in the rail's 14rem column, as the live run's labels did (issue #116). */
export const LONG_STEP_LABEL = "The store, which keeps the plan and its records on disk between two runs";

/**
 * An item's title long enough to wrap in a tab's list at every tested width, 1280 px included, where the list is at
 * most 56rem wide, and a body whose excerpt wraps too (issue #125): a row sized for one line of each overlapped the next.
 */
export const LONG_ITEM_TITLE = "A tab's item list overlaps its rows when a title is long enough to wrap onto a second line, so its supporting text is drawn over the next item's title and a reader cannot tell which excerpt belongs to which issue";
export const LONG_ITEM_BODY = "Every item in a tab's list whose title wraps to a second line has its supporting text drawn on top of the next item's title. The list is unreadable where it overlaps, and the overlapping text belongs to two different issues. A fix must keep every title readable.";

/** Three numbered answers of a paragraph each, one with a long unbroken path (issue #12). */
export const LONG_ANSWERS = [
  "1. Absolute clock time: the local time the message was published, shown in the message header. It never changes, so it needs no timer and no screen-reader handling for changing text, and it reads the same in the replay as it did live.",
  "2. Relative time: how long ago the message was published, such as five minutes ago, updated by a timer while the page is open. It answers the question of recency at a glance but changes under the reader, which needs care for assistive technology.",
  "3. Both, with the absolute time in the header and the relative time as its title; the configuration lives in /workspace/plan-review/archive-2026-09-27T19-14-30-277Z/work-review-1/changes.diff and nowhere else, so that nothing else has to change.",
] as const;

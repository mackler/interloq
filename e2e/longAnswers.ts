// The paragraphs of the "longChoices" scenario (issue #12), and the long step label of the "planSteps" scenario (issue
// #116), shared by e2e/server.ts and e2e/layout.spec.ts.

/** A plan step's label long enough to wrap in the rail's 14rem column, as the live run's labels did (issue #116). */
export const LONG_STEP_LABEL = "The store, which keeps the plan and its records on disk between two runs";

/** Three numbered answers of a paragraph each, one with a long unbroken path (issue #12). */
export const LONG_ANSWERS = [
  "1. Absolute clock time: the local time the message was published, shown in the message header. It never changes, so it needs no timer and no screen-reader handling for changing text, and it reads the same in the replay as it did live.",
  "2. Relative time: how long ago the message was published, such as five minutes ago, updated by a timer while the page is open. It answers the question of recency at a glance but changes under the reader, which needs care for assistive technology.",
  "3. Both, with the absolute time in the header and the relative time as its title; the configuration lives in /workspace/plan-review/archive-2026-09-27T19-14-30-277Z/work-review-1/changes.diff and nowhere else, so that nothing else has to change.",
] as const;

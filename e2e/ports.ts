import { type Option, Result } from "effect";
import type { RunMode } from "../src/runMode.ts";
import { type ItemId, type ItemUrl, itemUrlOf } from "../src/tracker.ts";
import { LONG_ITEM_BODY, LONG_ITEM_TITLE } from "./longAnswers.ts";
import type { FakeItem } from "../test/fakeTracker.ts";

// The scenario servers of the end-to-end tests and their ports, the one source for playwright.config.ts (which starts
// them) and the two spec files (which open them). Issue #75: the tests run in parallel, and a server holds one run at a
// time, so no server is used by both files: e2e/layout.spec.ts has servers of its own over the same scenarios, and
// within each file the tests of one server form one group that runs in order in one worker.

/** The servers of e2e/run.spec.ts, by scenario. */
export const RUN_PORTS = { twoModes: 8123, noTracker: 8124, converge: 8101, decision: 8102, stop: 8103, interview: 8104, workCorrection: 8105, tabs: 8106, drop: 8107, long: 8108, questionReview: 8109, longChoices: 8110, decide: 8111, decideLong: 8112, decideRevise: 8113, decideBlank: 8114, planSteps: 8115, transportRetry: 8116, unchangedPause: 8117, longQuestion: 8118, permissionLong: 8119, whitespace: 8120, transportLong: 8121, emptyQuestions: 8122 } as const;
/** The servers of e2e/layout.spec.ts, by scenario. */
export const LAYOUT_PORTS = { tabs: 8206, long: 8208, longChoices: 8210, decide: 8211, decideLong: 8212, planSteps: 8215, longQuestion: 8218, permissionLong: 8219, whitespace: 8220, transportLong: 8221, longContextShortAnswers: 8222, decideBlank: 8223 } as const;

export type RunScenario = keyof typeof RUN_PORTS;
export type LayoutScenario = keyof typeof LAYOUT_PORTS;
export const runUrl = (scenario: RunScenario): string => `http://127.0.0.1:${RUN_PORTS[scenario]}/`;
export const layoutUrl = (scenario: LayoutScenario): string => `http://127.0.0.1:${LAYOUT_PORTS[scenario]}/`;
/** Every server to start: its scenario and its port. */
export const SERVERS: readonly (readonly [scenario: string, port: number])[] = [...Object.entries(RUN_PORTS), ...Object.entries(LAYOUT_PORTS)];

/**
 * The mode a scenario's runs are of (issue #120): the scenarios of the question phase are refinement runs, the others
 * implementation runs; the server of two modes runs both, one in each tab.
 */
const REFINEMENT_SCENARIOS: readonly string[] = ["interview", "decideBlank", "emptyQuestions", "longChoices", "questionReview"];
export const modeOf = (scenario: string): RunMode => (REFINEMENT_SCENARIOS.includes(scenario) ? "refinement" : "implementation");

/**
 * The items of every scenario server's tracker (issue #120): 40 refined ones (1 to 40) and 40 unrefined ones (101 to
 * 140), each with a title of its own and an empty body, so that every test of a server can start a run from an item no
 * earlier test has moved on; then (issue #125) one refined (41) and one unrefined (141) item whose title and excerpt
 * wrap at every tested width, last, so that a test starting the first item listed starts the same item as before.
 * Every item has its page in the tracker.
 */
export const E2E_ITEMS: readonly FakeItem[] = [
  ...Array.from({ length: 40 }, (_, i) => i + 1).flatMap((n): FakeItem[] => [
    { id: `${n}` as ItemId, title: `Refined item ${n}`, body: "", state: "refined", open: true, url: e2eItemUrl(n) },
    { id: `${100 + n}` as ItemId, title: `Unrefined item ${100 + n}`, body: "", state: "unrefined", open: true, url: e2eItemUrl(100 + n) },
  ]),
  { id: "41" as ItemId, title: LONG_ITEM_TITLE, body: LONG_ITEM_BODY, state: "refined", open: true, url: e2eItemUrl(41) },
  { id: "141" as ItemId, title: LONG_ITEM_TITLE, body: LONG_ITEM_BODY, state: "unrefined", open: true, url: e2eItemUrl(141) },
];
/** An e2e item's page in its tracker. */
function e2eItemUrl(n: number): Option.Option<ItemUrl> {
  return Result.getSuccess(itemUrlOf(`https://tracker.example/issues/${n}`));
}

// The scenario servers of the end-to-end tests and their ports, the one source for playwright.config.ts (which starts
// them) and the two spec files (which open them). Issue #75: the tests run in parallel, and a server holds one run at a
// time, so no server is used by both files: e2e/layout.spec.ts has servers of its own over the same scenarios, and
// within each file the tests of one server form one group that runs in order in one worker.

/** The servers of e2e/run.spec.ts, by scenario. */
export const RUN_PORTS = { converge: 8101, decision: 8102, stop: 8103, interview: 8104, workCorrection: 8105, tabs: 8106, drop: 8107, long: 8108, questionReview: 8109, longChoices: 8110, decide: 8111, decideLong: 8112, decideRevise: 8113, decideBlank: 8114, planSteps: 8115, transportRetry: 8116, unchangedPause: 8117, longQuestion: 8118, permissionLong: 8119, whitespace: 8120, transportLong: 8121, emptyQuestions: 8122 } as const;
/** The servers of e2e/layout.spec.ts, by scenario. */
export const LAYOUT_PORTS = { tabs: 8206, long: 8208, longChoices: 8210, decide: 8211, decideLong: 8212, planSteps: 8215, longQuestion: 8218, permissionLong: 8219, whitespace: 8220, transportLong: 8221, longContextShortAnswers: 8222 } as const;

export type RunScenario = keyof typeof RUN_PORTS;
export type LayoutScenario = keyof typeof LAYOUT_PORTS;
export const runUrl = (scenario: RunScenario): string => `http://127.0.0.1:${RUN_PORTS[scenario]}/`;
export const layoutUrl = (scenario: LayoutScenario): string => `http://127.0.0.1:${LAYOUT_PORTS[scenario]}/`;
/** Every server to start: its scenario and its port. */
export const SERVERS: readonly (readonly [scenario: string, port: number])[] = [...Object.entries(RUN_PORTS), ...Object.entries(LAYOUT_PORTS)];

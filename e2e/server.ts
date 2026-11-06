// The server of the end-to-end tests (plan step 5.1): the real web server and run manager over the scripted
// agents of test/helpers.ts, in a temporary repository, so that no agent is reached. SCENARIO chooses the script
// of every run: "converge" (one accepted issue, then convergence), "decision" (a question from Claude Code),
// "stop" (a planning call that waits until it is interrupted), and those of finding 10 of docs/gui-review.md:
// "clarification", "workCorrection", "tabs", "drop", "long"; and "questionReview", the question phase whose review raises
// an issue, so that Claude Code's response carries the amended list (defect A of docs/page-question-phase-defects.md);
// "longChoices", a clarification turn whose numbered answers are paragraphs (issue #12); "decide", a plan writer's question
// with two options on which the user takes "Help me decide" (decision support); "decideLong", the same with a
// recommendation of several paragraphs (W1-R1-3); "decideRevise", an analysis whose first review raises an issue that
// Claude accepts with an amended analysis (W2-R1-1); "decideBlank", a clarification turn with numbered answers on which the
// user takes "Help me decide" and then sends an empty message, which the run rejects (W3-R1-1); "planSteps" (issue #6),
// a plan of two stages whose execution reports its steps and stops, a revision with a new step whose text is long, and
// a second execution that reports a step and then waits until it is stopped; "termsWait" (issue #217), a refinement
// whose request for a question's terms, asked on request, waits until an answer given beside it interrupts it.
// PORT is the port.

import { Effect, Result } from "effect";
import { HttpServer } from "effect/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { platformLayer } from "../src/platform.ts";
import { makeRunManager } from "../src/runManager.ts";
import { makeWebServer } from "../src/webServer.ts";
import { ARGUMENT_TIMING_MARKER, LIVE_LONG_LINE, LIVE_LONG_NAME, LIVE_RED_TEXT, LIVE_TICK_MS, LONG_ANSWERS, LONG_RUN_QUESTION, LONG_STEP_LABEL, NARRATION_LONG_COMMAND } from "./longAnswers.ts";
import type { OutputEvent, ProcessKey } from "../src/liveOutput.ts";
import { E2E_ITEMS, PREPARED_ITEM } from "./ports.ts";
import { NoTracker } from "../src/errors.ts";
import type { RunMode } from "../src/runMode.ts";
import { askedInPlanReview, fakeTrackerOf, finished, issue, respond, type TestOptions, tempRepo, testWiring, trackerAccessOf, questionOf, entryOf, para, ack, summaryReply } from "../test/helpers.ts";
import { DEFAULT_SETTINGS, OFF_SETTINGS } from "../src/chain.ts";
import { FIGURE_NARROW, FIGURE_WIDE } from "./figures.ts";

const noQuestions = { questions_for_user: [] };
// S39 (W2-R1-2): a context long enough to overflow its region beside the analysis.
const LONG_DECISION_CONTEXT = Array.from({ length: 8 }, (_, i) => `Paragraph ${i + 1} of the context: the service keeps its data in a database, and the choice decides what runs beside it.`).join("\n\n");
/** Issue #133: the history of the decideLong scenario's question, shown under its own heading on the decision page. */
const DECISION_HISTORY = "You decided on 9 Oct 2026 to keep the service on one machine, and the first prototype ran on SQLite.";
const LONG = 60;
/** An analysis of the "decide" scenario: two columns, a counterargument with a defense, one equivalence, a recommendation. */
const element = (text: string, counterarguments: unknown[] = []) => ({ text, counterarguments });
const entry = (id: string, title: string, counterarguments: unknown[] = []) => ({
  id,
  title,
  comparative_condition: element(`The comparative condition of ${id}.`, counterarguments),
  starting_cause: element(`The starting cause of ${id}.`),
  intermediate_steps: element(`The intermediate steps of ${id}.`),
  threshold: element(`The threshold of ${id}.`),
  effect_on_persons: element(`The effect on persons of ${id}.`),
  reason_the_effect_matters: element(`Why the effect of ${id} matters.`),
  extent: { per_person: element("Per person."), persons_affected: element("Persons affected."), likelihood: element("Likelihood."), timing: element("Timing.") },
});
const DECIDE_ANALYSIS = {
  decision: "Which database should the service use?",
  columns: [
    {
      kind: "argued" as const,
      option: "SQLite",
      advantages: [entry("E1", "Developers set up the service sooner, because no database server is needed.", [{ id: "A1", text: "But the container already runs a database server.", equivalent_to: "", replies: [{ id: "A2", text: "On the other hand, the server needs its own configuration.", equivalent_to: "E2", replies: [] }] }])],
      disadvantages: [],
    },
    { kind: "argued" as const, option: "PostgreSQL", advantages: [], disadvantages: [entry("E2", "Operators maintain one more server, so outages are more likely.")] },
  ],
  recommendation: { option: "", reason: "" },
};
/** A recommendation of twelve paragraphs, the last one marked so that a test can find it. */
const LONG_RECOMMENDATION = [
  ...Array.from({ length: 11 }, (_, i) => `Paragraph ${i + 1}: the advantage that developers set up the service sooner outweighs, for every developer and from the first day, the disadvantage that operators maintain one more server, because the service has one operator and many developers.`),
  "The last paragraph of the recommendation.",
].join("\n\n");
/**
 * Issue #41: the representative example the developer judges: long elements, a threshold disputed three levels deep, a
 * counterargument under the steps and one under the persons affected, and all four statements of the extent long; the
 * PostgreSQL column's disadvantage has a counterargument under its threshold, so the error color alternates both ways.
 */
const ARGUMENT_STRUCTURE_ANALYSIS = {
  decision: "Which database should the service use?",
  columns: [
    {
      kind: "argued" as const,
      option: "SQLite",
      advantages: [
        {
          id: "E1",
          title: "Developers set up the service sooner, because no database server has to be installed or configured.",
          comparative_condition: element("If the service keeps its data in SQLite, its database is one file beside the service, whereas with PostgreSQL it is a separate server that must be installed, started and given a user before the service can start. Nothing else about the service's setup differs between the two options."),
          starting_cause: element("A developer who clones the repository can run the service at once, because the database file is created on its first start. The schema is applied by the service itself when it finds the file empty, so no migration command has to be run by hand. Nothing outside the repository has to exist first."),
          intermediate_steps: element("No server has to be installed, no port opened and no password shared, so the developer's first hour goes to the service itself. Each new developer repeats the setup, so the saving recurs with every person who joins.", [
            { id: "A1", text: "But the development container already includes a PostgreSQL server, so installing it costs nothing extra.", equivalent_to: "", replies: [] },
          ]),
          threshold: element("This matters only if setting up a database server takes long enough to delay the developer's first working run, which is the case when the server needs a configuration of its own. A server that started with defaults and accepted the service's connection unchanged would not delay anyone. The service needs its own user, database and extension, so the defaults are not enough.", [
            {
              id: "A2",
              text: "But a configured server takes only a few minutes to start, which is too short to delay anyone's first run.",
              equivalent_to: "",
              replies: [
                {
                  id: "A3",
                  text: "On the other hand, the configuration has to be written and kept in step with the service's settings, which takes far longer than starting the server.",
                  equivalent_to: "",
                  replies: [{ id: "A4", text: "Then again, the configuration is written once and committed, so later developers only copy it.", equivalent_to: "", replies: [] }],
                },
              ],
            },
          ]),
          effect_on_persons: element("Each developer reaches a running service on the first day instead of spending part of it on a database server's setup. The first change they make is tried against a service that runs, rather than against one they are still trying to start. Questions about the setup stop reaching the developers who already know it."),
          reason_the_effect_matters: element("A developer who sees the service run early understands it sooner and makes fewer mistakes in the first changes they write. Those first changes are the ones most often reviewed by someone else, so a mistake in them costs two people's time. A slow start also tends to be remembered as a reason the project is hard to work on."),
          extent: {
            per_person: element("About one hour saved per developer, once, at the start; more where the developer has never configured PostgreSQL before, less where they have. The estimate comes from the time the last two developers spent before their first run. It does not count the time other people spent answering their questions."),
            persons_affected: element("Every developer who joins the project, which is three people this year and perhaps ten over the service's life. Contributors who change only the documentation are not counted, since they never run the service. Operators are not counted either, since they set up the production database whichever option is chosen.", [
              { id: "A5", text: "But only one developer joins this year, so the number affected is small.", equivalent_to: "", replies: [] },
            ]),
            likelihood: element("Certain for every new developer, since every one of them has to reach a running service before changing it. No developer can skip the setup by working on another part of the project, because every part of it calls the database. Only a developer who already has a configured PostgreSQL server would not benefit."),
            timing: element(`At once, on each developer's first day, and for as long as the service keeps its data in one file. The saving does not grow or shrink later. ${ARGUMENT_TIMING_MARKER}`),
          },
        },
      ],
      disadvantages: [],
    },
    {
      kind: "argued" as const,
      option: "PostgreSQL",
      advantages: [],
      disadvantages: [
        {
          ...entry("E2", "Operators maintain one more server, so outages are more likely."),
          threshold: element("This matters only if the server is run by the same people who run the service, which is the case on one machine.", [
            { id: "B1", text: "But the hosting provider runs the database server, so no operator of the service maintains it.", equivalent_to: "", replies: [] },
          ]),
        },
      ],
    },
  ],
  recommendation: { option: "SQLite", reason: "Developers set up the service sooner." },
};
export const SCENARIOS: Record<string, TestOptions> = {
  converge: {
    steps: [{ output: noQuestions, plan: "1. [ ] the step\n" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "1. [ ] the step, amended\n" }],
    reviews: [{ issues: [issue("P1-R1-1", "The step names no file.")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  },
  decision: askedInPlanReview({
    steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which database should the service use?", terms: [], options: [] })] }, plan: "1. [ ] the step\n" }, { output: noQuestions }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  }),
  stop: { steps: [{ output: noQuestions, plan: "1. [ ] the step\n" }, { hang: true }], reviews: [{ issues: [issue("P1-R1-1")] }] },
  // Issue #139: the decision scenario with its first planning call held 20 s, so the implementation run works before it
  // waits on the plan writer's question; a timed gate, since the test cannot reach into the server to release one.
  tabStates: askedInPlanReview({
    steps: [
      { output: { questions_for_user: [questionOf({ context: "c", question: "Which database should the service use?", terms: [], options: [] })] }, plan: "1. [ ] the step\n", gate: () => new Promise<void>((r) => setTimeout(r, 20_000)) },
      { output: noQuestions },
    ],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  }),

  // Finding 10 of docs/gui-review.md: the scenarios the review names.
  // The question phase: a question list, a clarification message, /done, a proposed summary.
  clarification: {
    steps: [
      { output: { questions: [entryOf({ id: "Q1", context: "c", question: "Which database should the service use?", reason: "r", proposed_answers: [{ label: "PostgreSQL", description: "p" }, { label: "SQLite", description: "s" }], default_answer: "PostgreSQL" })] } },
    ],
    // Issue #184: the first clarification presents Q1 itself; Claude Code's reply to the answer and its closing reply.
    // Issue #184: once the agreed question is answered, the closing reply asks the developer for anything further, and
    // after /done the next closing reply proposes the summary.
    closings: [{ output: ack("Anything else?") }, { output: summaryReply("# Requirements\n\nThe service uses PostgreSQL.", "That is all I need.") }],
    // Issue #120: a refinement run, the question phase alone: the question review and the requirements review.
    reviews: [{ issues: [] }, { issues: [] }],
  },
  // W3-R1-1: an empty message after the analysis is rejected and asked again; the analysis stays shown.
  decideBlank: {
    steps: [
      { output: { questions: [entryOf({ id: "Q1", context: "c", question: "Which database should the service use?", reason: "r", proposed_answers: [{ label: "PostgreSQL", description: "p" }, { label: "SQLite", description: "s" }], default_answer: "PostgreSQL" })] } },
      { output: { ...DECIDE_ANALYSIS, columns: [{ ...DECIDE_ANALYSIS.columns[1], option: "PostgreSQL" }, { ...DECIDE_ANALYSIS.columns[0], option: "SQLite" }] } },
    ],
    closings: [{ output: summaryReply("# Requirements\n\nThe service uses PostgreSQL.", "That is all I need.") }],
    // The question review, the analysis's review, the requirements review.
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
  },
  // Issue #217: the terms on request of the one agreed question wait until the answer given beside them interrupts them.
  termsWait: {
    steps: [
      { output: { questions: [entryOf({ id: "Q1", context: "c", question: "Which database should the service use?", reason: "r", proposed_answers: [{ label: "PostgreSQL", description: "p" }, { label: "SQLite", description: "s" }], default_answer: "PostgreSQL" })] } },
    ],
    terms: [{ output: { entries: [] }, gate: () => new Promise<void>(() => {}) }],
    closings: [{ output: summaryReply("# Requirements\n\nThe service uses PostgreSQL.", "That is all I need.") }],
    // The question review, the requirements review.
    reviews: [{ issues: [] }, { issues: [] }],
  },
  // Issue #83: an empty agreed question list, which the review accepts; issue #120: the refinement then ends at once.
  emptyQuestions: {
    steps: [{ output: { questions: [] } }],
    reviews: [{ issues: [] }],
  },
  // Issue #12: the clarification's numbered answers are paragraphs.
  longChoices: {
    steps: [
      { output: { questions: [entryOf({ id: "Q1", context: "c", question: "How should a message show its time?", reason: "r", proposed_answers: LONG_ANSWERS.map((a) => { const [label, ...rest] = a.replace(/^\d+\. /, "").split(": "); return { label, description: rest.join(": ") }; }), default_answer: "Absolute clock time" })] } },
    ],
    replies: [{ output: ack("Anything else?") }],
    closings: [{ output: summaryReply("# Requirements\n\nRelative time.", "That is all I need.") }],
    reviews: [{ issues: [] }, { issues: [] }],
  },
  // Defect A of docs/page-question-phase-defects.md: the question list, its review with one issue, Claude Code's
  // response with the amended list, a second round without an issue, one clarification turn with numbered answers, the
  // user's answer, a summary and the requirements review; issue #120: a refinement run ends there.
  questionReview: {
    steps: [
      { output: { questions: [entryOf({ id: "Q1", context: "c", question: "Which database should the service use?", reason: "r", proposed_answers: [{ label: "PostgreSQL", description: "p" }, { label: "SQLite", description: "s" }], default_answer: "PostgreSQL" })] } },
      {
        output: {
          ...respond([["Q-R1-1", "accepted"]]),
          questions: [
            entryOf({ id: "Q1", context: "c", question: "Which database should the service use?", reason: "r", proposed_answers: [{ label: "PostgreSQL", description: "p" }, { label: "SQLite", description: "s" }], default_answer: "PostgreSQL" }),
            entryOf({ id: "Q2", context: "c", question: "Which port?", reason: "r", proposed_answers: [{ label: "8080", description: "p" }], default_answer: "8080" }),
          ],
        },
      },
    ],
    closings: [{ output: summaryReply("# Requirements\n\nThe service uses PostgreSQL on port 8080.", "That is all I need.") }],
    reviews: [{ issues: [issue("Q-R1-1", "The list does not ask for the port.")] }, { issues: [] }, { issues: [] }],
  },
  // A work correction: work review 1 raises an issue that Claude Code accepts, so planning, execution and the work
  // review run a second time, and the second work review converges.
  workCorrection: {
    steps: [{ output: noQuestions, plan: "1. [ ] the step\n" }, { output: respond([["W1-R1-1", "accepted"]]) }, { output: noQuestions, plan: "1. [x] the step\n2. [ ] the fix\n" }],
    // Issue #252: the work review collects, so a cycle that raises nothing follows the accepted one before it leaves.
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1", "The step misses its test.")] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
  },
  // Two decisions in a row, for two tabs and a dropped connection.
  tabs: askedInPlanReview({
    steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which database should the service use?", terms: [], options: [] }), questionOf({ context: "c", question: "Which cache should the service use?", terms: [], options: [] })] }, plan: "1. [ ] the step\n" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  }),
  drop: askedInPlanReview({
    steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which database should the service use?", terms: [], options: [] })] }, plan: "1. [ ] the step\n" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  }),
  // Decision support: a question with two options, one analysis that converges in its first cycle, then the answer.
  // Issue #79: a context of about ten lines at 1280 px and a short recommendation, which fit beside the columns.
  decide: askedInPlanReview({
    steps: [
      { output: { questions_for_user: [questionOf({ context: LONG_DECISION_CONTEXT, question: "Which database should the service use?", terms: [], options: [{ label: "SQLite", description: "one file, no server" }, { label: "PostgreSQL", description: "a database server" }] })] }, plan: "1. [ ] the step\n" },
      { output: { ...DECIDE_ANALYSIS, recommendation: { option: "SQLite", reason: "Developers set up the service sooner." } } },
      { output: noQuestions },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  }),
  // Issue #98: a plan writer's question whose two options each carry a picture of a different division of a rectangle.
  // Both pictures define id="shape" and draw it with use, at 40 and at 320 pixels wide, so a picture that resolved the
  // other's definition would show the wrong size; the first also carries a script and an onload, which the page drops.
  figureChoices: askedInPlanReview({
    steps: [
      { output: { questions_for_user: [questionOf({ context: "The decision page divides its height between the question and the columns of arguments.", question: "Which database should the service use?", terms: [], options: [{ label: "SQLite", description: "one file, no server", figure: FIGURE_NARROW }, { label: "PostgreSQL", description: "a database server", figure: FIGURE_WIDE }] })] }, plan: "1. [ ] the step\n" },
      { output: { ...DECIDE_ANALYSIS, recommendation: { option: "SQLite", reason: "Developers set up the service sooner." } } },
      { output: noQuestions },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  }),
  // Issue #153: the question stays on the page while its analysis is prepared; the analysis call hangs until the answer
  // given meanwhile interrupts it, and the answer is then applied to the plan. The question carries one term.
  decideWait: askedInPlanReview({
    steps: [
      { output: { questions_for_user: [questionOf({ context: "The service keeps its data in a database.", question: "Which database should the service use?", terms: [{ term: "service", explanation: "The program this task makes." }], options: [{ label: "SQLite", description: "one file, no server" }, { label: "PostgreSQL", description: "a database server" }] })] }, plan: "1. [ ] the step\n" },
      { hang: true },
      { output: noQuestions },
    ],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  }),
  // W1-R1-3: a long recommendation must not squeeze the columns.
  // Issue #133: its question has a history too, and its context is eight paragraphs, so that the History heading and
  // the text columns are exercised.
  decideLong: askedInPlanReview({
    steps: [
      { output: { questions_for_user: [{ ...questionOf({ context: LONG_DECISION_CONTEXT, question: "Which database should the service use?", terms: [], options: [{ label: "SQLite", description: "one file, no server" }, { label: "PostgreSQL", description: "a database server" }] }), context: para(...LONG_DECISION_CONTEXT.split("\n\n")), history: para(DECISION_HISTORY) }] }, plan: "1. [ ] the step\n" },
      { output: { ...DECIDE_ANALYSIS, recommendation: { option: "SQLite", reason: LONG_RECOMMENDATION } } },
      { output: noQuestions },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  }),
  // W2-R1-1: the analysis's review raises an issue; Claude's response carries the amended analysis to the page.
  decideRevise: askedInPlanReview({
    steps: [
      { output: { questions_for_user: [questionOf({ context: "c", question: "Which database should the service use?", terms: [], options: [{ label: "SQLite", description: "one file, no server" }, { label: "PostgreSQL", description: "a database server" }] })] }, plan: "1. [ ] the step\n" },
      { output: DECIDE_ANALYSIS },
      {
        output: {
          ...respond([["D1-R1-1", "accepted"]]),
          analysis: { ...DECIDE_ANALYSIS, columns: [{ ...DECIDE_ANALYSIS.columns[0], advantages: [entry("E1", "The amended advantage: developers set up the service sooner.")] }, DECIDE_ANALYSIS.columns[1]] },
        },
      },
      { output: noQuestions },
    ],
    reviews: [{ issues: [issue("D1-R1-1", "The advantage of SQLite states no extent.")] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  }),
  // A long transcript: 60 accepted rounds, then rounds without an acceptance, then a round whose response carries Claude
  // Code's own question, which waits. No limit is reached (both above the scenario's 63 rounds), so no question opens
  // beside the review (issue #243) and the run waits on exactly one question.
  long: {
    config: { maxRounds: 100, maxIdleRounds: 100 },
    steps: [
      { output: noQuestions, plan: "v0\n" },
      ...Array.from({ length: LONG }, (_, i) => ({ output: respond([[`P1-R${i + 1}-1`, "accepted"]]), plan: `v${i + 1}\n` })),
      { output: respond([[`P1-R${LONG + 1}-1`, "rejected"]]) },
      { output: respond([[`P1-R${LONG + 2}-1`, "rejected"]]) },
      { output: respond([[`P1-R${LONG + 3}-1`, "rejected"]], { questions_for_user: [questionOf({ context: "c", question: LONG_RUN_QUESTION, terms: [], options: [] })] }) },
    ],
    reviews: [
      ...Array.from({ length: LONG + 3 }, (_, i) => ({ issues: [issue(`P1-R${i + 1}-1`, `Point ${i + 1} of the plan is not specific enough to implement without guessing.`)] })),
      { issues: [] },
      { issues: [] },
    ],
    execs: [finished],
  },
};

// Issue #6: the plan of the "planSteps" scenario, and its revision with a step whose text is long enough to scroll.
const S1 = { id: "S1", number: 1, label: "Structured user questions (Q1)", text: "Add the **schema** of a question." };
const S2 = { id: "S2", number: 2, label: LONG_STEP_LABEL, text: "Write `plan.json`." };
export const LONG_STEP_TEXT = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the step's text, which the tooltip scrolls.`).join("\n\n");
const S3 = { id: "S3", number: 1, label: "The long step", text: LONG_STEP_TEXT };
SCENARIOS.planSteps = {
  steps: [
    { output: { ...noQuestions, plan: { stages: [{ number: 1, title: "the schema and its records", steps: [S1, S2] }] } } },
    { output: { ...noQuestions, plan: { stages: [{ number: 1, title: "the schema and its records", steps: [S1, S2] }, { number: 2, title: "the page", steps: [S3] }] } } },
  ],
  reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
  execs: [{ status: "needs_input", summary: "S1 done", question: "A or B?", remainingWork: "S2", userInput: "B", checks: [], testFirst: [] }],
  execScripts: [{ reports: [["S1", "started"], ["S1", "done"], ["S2", "started"]] }, { reports: [["S2", "started"]], hang: true }],
};

// Issue #26: a Codex turn that fails from a transport fault and succeeds on its retry; the wait is long enough to be seen.
SCENARIOS.transportRetry = {
  steps: [{ output: noQuestions, plan: "1. [ ] the step\n" }],
  reviews: [{ issues: [], fault: "stream disconnected before completion" }, { issues: [] }, { issues: [] }],
  execs: [finished],
  config: { maxTransportRetries: 3, transportRetryDelaySeconds: 2 },
};
// Issue #30: an accepted issue with plan.json unchanged after the corrective turn: the question, answered Proceed.
// Issue #243: the question is open beside the running review; its second cycle is held until the run publishes the
// answer to a question beside it (W1-R1-4: released by the run's own events, never by a timer), so that the test answers
// while the review runs.
let besideAnswered!: () => void;
const besideAnsweredOnce = new Promise<void>((resolve) => (besideAnswered = resolve));
SCENARIOS.unchangedPause = {
  steps: [
    { output: noQuestions, plan: "1. [ ] the step\n" },
    { output: respond([["P1-R1-1", "accepted"]]) },
    { output: respond([["P1-R1-1", "accepted"]]) },
  ],
  reviews: [{ issues: [issue("P1-R1-1", "The step names no file.")] }, { issues: [], gate: () => besideAnsweredOnce }, { issues: [] }],
  execs: [finished],
};

// S29: a question of the plan writer with a long context, many terms and long options, for the layout of the question
// pane at every size and for a term's tooltip reached by keyboard.
const LONG_QUESTION_WORDS = {
  context: Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} of the context: the service, a web server, keeps its data in a database; the cache, a store in memory, answers repeated reads; the migration, a script, changes the schema when the service starts.`).join("\n\n"),
  question: "Which database should the service use?",
  // S42: "database" comes before "service" in the question, and its explanation is long enough to scroll in its tooltip.
  terms: ["service", "cache", "migration", "schema", "database", "web server", "store in memory", "script"].map((term) => ({
    term,
    explanation: `The ${term} of this task, explained in ordinary words for a reader who has never seen the codebase.${term === "database" ? " It keeps what the service must remember between requests.".repeat(30) : ""}`,
  })),
  options: [
    { label: "SQLite", description: "One file beside the service, no server to run; the migration runs when the service starts. ".repeat(4) },
    { label: "PostgreSQL", description: "A database server of its own, which the service reaches over the network; the cache stays in memory. ".repeat(4) },
    { label: "Both, chosen by configuration", description: "The service reads a setting that names the database; each migration is written twice. ".repeat(4) },
  ],
};
/**
 * S15 of the task of issue #36: the long question as pieces. Its first paragraph opens with a plural and a capitalized
 * word, "Databases", that refers to the explanation of "database", which exact words could never explain.
 */
const longQuestion = questionOf(LONG_QUESTION_WORDS);
const databaseRef = longQuestion.explanations.find((e) => e.term === "database")?.id ?? "";
export const LONG_QUESTION = {
  ...longQuestion,
  context: [{ kind: "paragraph" as const, pieces: [{ text: "Databases", ref: databaseRef, code: false }, { text: " keep what a service must remember.", ref: "", code: false }] }, ...longQuestion.context],
};
SCENARIOS.longQuestion = askedInPlanReview({
  steps: [{ output: { questions_for_user: [LONG_QUESTION] }, plan: "1. [ ] the step\n" }, { output: noQuestions }],
  reviews: [{ issues: [] }, { issues: [] }],
  execs: [finished],
});

// Issue #79 (P2-R1-1): the long context of longQuestion with two short options, so that in a tall window the question
// pane's context can be shown whole.
SCENARIOS.longContextShortAnswers = askedInPlanReview({
  steps: [{ output: { questions_for_user: [questionOf({ ...LONG_QUESTION_WORDS, options: [{ label: "SQLite", description: "one file, no server" }, { label: "PostgreSQL", description: "a database server" }] })] }, plan: "1. [ ] the step\n" }, { output: noQuestions }],
  reviews: [{ issues: [] }, { issues: [] }],
  execs: [finished],
});

// Issue #22 (W1-R1-1 of work review 1): five agreed questions, each with two options a paragraph long, so that the
// fifth waits after four long answers, which the compact dashboard's heading of every answer lists under it.
const HISTORY_OPTIONS = LONG_ANSWERS.slice(0, 2).map((a) => {
  const [label, ...rest] = a.replace(/^\d+\. /, "").split(": ");
  return { label, description: rest.join(": ") };
});
// Issue #202: several refinement runs at once, each waiting on its first question, so that the Refinement tab's second
// row of tabs holds more tabs than a narrow window can.
SCENARIOS.refinementTabs = SCENARIOS.longChoices;
SCENARIOS.longHistory = {
  steps: [
    { output: { questions: Array.from({ length: 5 }, (_, i) => entryOf({ id: `Q${i + 1}`, context: "c", question: `How should message ${i + 1} show its time?`, reason: "r", proposed_answers: HISTORY_OPTIONS, default_answer: HISTORY_OPTIONS[0].label })) } },
  ],
  replies: Array.from({ length: 5 }, () => ({ output: ack("Noted.") })),
  closings: [{ output: summaryReply("# Requirements\n\nAbsolute clock time.", "That is all I need.") }],
  reviews: [{ issues: [] }, { issues: [] }],
};

// Issue #221: an execution that prints 1,200 lines on a process with a 200-character name, a red line and a line of
// 700 characters among them, beside two more running processes and one ended, then a tick every 300 ms while the call
// hangs, so that the panel's scrollback is full and every tick evicts its oldest line.
const liveKey = (id: string): ProcessKey => `claude:${id}` as ProcessKey;
const LIVE_T1 = liveKey("t1");
const liveName80 = (c: string): string => `${c} `.repeat(40).slice(0, 80);
const LIVE_EVENTS: readonly OutputEvent[] = [
  { _tag: "Started", key: LIVE_T1, name: LIVE_LONG_NAME },
  { _tag: "Started", key: liveKey("t2"), name: liveName80("watch") },
  { _tag: "Started", key: liveKey("t3"), name: liveName80("serve") },
  ...Array.from({ length: 1200 }, (_, i): OutputEvent => ({
    _tag: "Printed",
    key: LIVE_T1,
    name: LIVE_LONG_NAME,
    text: i === 1150 ? `\u001b[31m${LIVE_RED_TEXT}\u001b[0m\n` : i === 1100 ? `${"w".repeat(LIVE_LONG_LINE)}\n` : `line ${i + 1}\n`,
  })),
  { _tag: "Started", key: liveKey("t4"), name: "false" },
  { _tag: "Printed", key: liveKey("t4"), name: "false", text: "failing\n" },
  { _tag: "Finished", key: liveKey("t4"), name: "false", status: { _tag: "Exited", code: 1 } },
];
const LIVE_TICKS = { key: LIVE_T1, name: LIVE_LONG_NAME, everyMs: LIVE_TICK_MS };
// Issue #163's run: under the suite's load a tab may receive the burst above compacted, or lose it to a hello, which
// empties the panel; so every 50th tick is red, the one after it the long line, and the two other running processes
// are announced again on every 50th tick, so that the ticks alone fill the panel with every marker L36 reads.
const LIVE_MARKED_TICKS = {
  ...LIVE_TICKS,
  marks: {
    every: 50,
    texts: [(n: number) => `\u001b[31m${LIVE_RED_TEXT} tick ${n}\u001b[0m\n`, (n: number) => `${"w".repeat(LIVE_LONG_LINE)} tick ${n}\n`],
    restate: LIVE_EVENTS.filter((e) => e._tag === "Started" && (e.key === liveKey("t2") || e.key === liveKey("t3"))),
  },
};
SCENARIOS.liveOutput = {
  steps: [{ output: noQuestions, plan: "1. [ ] the step\n" }],
  reviews: [{ issues: [] }],
  execScripts: [{ output: LIVE_EVENTS, ticks: LIVE_MARKED_TICKS, hang: true }],
};
// Issue #40: an execution whose one message was written while two commands ran, the second a long command line, then
// hanging, so the dashboard holds the note under Claude Code's latest message.
// Issue #41: the decide scenario's question, whose analysis is the representative example of an argument's structure.
SCENARIOS.argumentStructure = askedInPlanReview({
  steps: [
    { output: { questions_for_user: [questionOf({ context: "The service keeps its data in a database.", question: "Which database should the service use?", terms: [], options: [{ label: "SQLite", description: "one file, no server" }, { label: "PostgreSQL", description: "a database server" }] })] }, plan: "1. [ ] the step\n" },
    { output: ARGUMENT_STRUCTURE_ANALYSIS },
    { output: noQuestions },
  ],
  reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
  execs: [finished],
});
SCENARIOS.narrationNote = {
  steps: [{ output: noQuestions, plan: "1. [ ] the step\n" }],
  reviews: [{ issues: [] }],
  execScripts: [{ said: [{ text: "Running the tests now.", running: ["npm test", NARRATION_LONG_COMMAND] }], hang: true }],
};
// Issue #221: the compact panel under a question: four plan questions answered first, whose answers fill the compact
// dashboard above the panel, then an execution with one running process that asks a permission while it prints.
const LIVE_QUESTION_OPTIONS = LONG_ANSWERS.slice(0, 2).map((a) => {
  const [label, ...rest] = a.replace(/^\d+\. /, "").split(": ");
  return { label: label ?? "", description: rest.join(": ") };
});
// Issue #139: a layout server whose implementation run waits out a usage limit with a stated reset an hour after the
// server starts (its tab paused, with the reset's time), and once the developer ends the wait early works on, held in
// its planning call (its tab running).
SCENARIOS.tabStatesLayout = {
  steps: [{ limit: { reset: { kind: "instant", atMs: Date.now() + 3_600_000 }, limitType: "seven_day" } }, { hang: true }],
};
SCENARIOS.liveOutputQuestion = askedInPlanReview({
  steps: [
    { output: { questions_for_user: Array.from({ length: 4 }, (_, i) => questionOf({ context: "The plan leaves this open.", question: `How should message ${i + 1} show its time?`, terms: [], options: LIVE_QUESTION_OPTIONS })) }, plan: "1. [ ] the step\n" },
    { output: noQuestions },
  ],
  reviews: [{ issues: [] }, { issues: [] }],
  execScripts: [{
    output: [{ _tag: "Started", key: LIVE_T1, name: LIVE_LONG_NAME }, ...Array.from({ length: 300 }, (_, i): OutputEvent => ({ _tag: "Printed", key: LIVE_T1, name: LIVE_LONG_NAME, text: `line ${i + 1}\n` }))],
    ticks: LIVE_TICKS,
    permission: { tool: "Bash", input: { command: "npm run build", description: "Build the page" } },
    hang: true,
  }],
});

// S49 (W4-R1-1): a permission request with a 40-line command, which stays in the details while the question names the
// action; Help me decide on it shows the analysis beside the question.
export const LONG_COMMAND = Array.from({ length: 40 }, (_, i) => `echo "line ${i + 1} of a long command that prepares the build directory"`).join("\n");
const PERMISSION_ANALYSIS = { ...DECIDE_ANALYSIS, decision: "Should the command run?", columns: [{ ...DECIDE_ANALYSIS.columns[0], option: "Allow this" }, { ...DECIDE_ANALYSIS.columns[1], option: "Do not allow this" }] };
SCENARIOS.permissionLong = {
  steps: [{ output: noQuestions, plan: "1. [ ] the step\n" }, { output: PERMISSION_ANALYSIS }],
  reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
  execs: [finished],
  execScripts: [{ permission: { tool: "Bash", input: { command: LONG_COMMAND, description: "Prepare the build directory" } } }],
};

// S51 (W3-R1-2 of work review 5): values that differ only in their whitespace, whose rendered widths the layout test compares.
const WHITESPACE_VALUES = { alpha: "a b", beta: "a  b", gamma: "a\tb", delta: " a ", epsilon: "a" } as const;
SCENARIOS.whitespace = {
  steps: [{ output: noQuestions, plan: "1. [ ] the step\n" }, { output: PERMISSION_ANALYSIS }],
  reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
  execs: [finished],
  execScripts: [{ permission: { tool: "Probe", input: WHITESPACE_VALUES } }],
};

// S52 (W5-R1-1): a Codex turn whose retries run out with a fault of 2,500 characters: the exhaustion pause, whose
// question stays short while the fault, <endpoint> included, is in its details.
const LONG_FAULT = `stream disconnected before completion: <endpoint> refused the connection; ${"the server said nothing more. ".repeat(80)}END OF FAULT`;
SCENARIOS.transportLong = {
  steps: [{ output: noQuestions, plan: "1. [ ] the step\n" }],
  reviews: [{ issues: [], fault: LONG_FAULT }, { issues: [], fault: LONG_FAULT }, { issues: [] }, { issues: [] }, { issues: [] }],
  execs: [finished],
  config: { maxTransportRetries: 1, transportRetryDelaySeconds: 0.01 },
};

// Issue #120: the server of two runs at once, a refinement run waiting on its first question and an implementation run
// waiting on the plan writer's question, each mode with its own script.
const BY_MODE: Partial<Record<string, Readonly<Record<RunMode, TestOptions>>>> = {
  twoModes: { refinement: SCENARIOS.clarification, implementation: SCENARIOS.decision },
};
// Issue #147: the server of the chain, the one with the mode on: its first run finishes, and every later run waits in
// its planning call, so the test can turn the mode off while the chained run is in progress.
const CHAIN_LATER: TestOptions = { steps: [{ output: noQuestions, plan: "1. [ ] the step\n", hang: true }] };
let chainRuns = 0;
const chainScript = (): TestOptions => (++chainRuns === 1 ? SCENARIOS.converge : CHAIN_LATER);
// Issue #196: the server of the chain's queue, the mode on: its first run waits on the plan writer's question, so the
// test composes the queue while it runs, and every later run waits in its planning call.
let chainQueueRuns = 0;
const chainQueueScript = (): TestOptions => (++chainQueueRuns === 1 ? SCENARIOS.decision! : CHAIN_LATER);
// Issue #131: the server of the preparation: its first wiring prepares the marked item's one question, unattended; the
// second is the refinement run of that item, which asks the prepared question at once and needs only its answer's
// closing reply and the requirements review.
const PREPARE_LIST: TestOptions = { steps: SCENARIOS.clarification!.steps, reviews: [{ issues: [] }] };
const PREPARED_RUN: TestOptions = { closings: [{ output: summaryReply("# Requirements\n\nThe service uses PostgreSQL.", "That is all I need.") }], reviews: [{ issues: [] }] };
let prepareWirings = 0;
const prepareScript = (): TestOptions => (++prepareWirings === 1 ? PREPARE_LIST : PREPARED_RUN);
// Issue #120: the server of a project whose tracker cannot be reached: no tracker is configured, so each tab shows a notice.
SCENARIOS.noTracker = SCENARIOS.converge;
const name = process.env.SCENARIO ?? "converge";
// Issue #249: the switch off at the start; the first run waits on the plan writer's question, so the test turns the
// switch on during it, and every later run waits in its planning call.
let chainAdoptRuns = 0;
const chainAdoptScript = (): TestOptions => (++chainAdoptRuns === 1 ? SCENARIOS.decision! : CHAIN_LATER);
const scenarioOf = (mode: RunMode): TestOptions => (name === "chain" ? chainScript() : name === "chainQueue" ? chainQueueScript() : name === "chainAdopt" ? chainAdoptScript() : name === "prepare" ? prepareScript() : (BY_MODE[name]?.[mode] ?? SCENARIOS[name] ?? SCENARIOS.converge));
const port = Number(process.env.PORT ?? "8101");
const repo = tempRepo();
const distDir = fileURLToPath(new URL("../web/dist", import.meta.url));

/**
 * The project's tracker of the scenario (issue #120), in memory: refined items for the implementation runs and unrefined
 * ones for the refinement runs, enough for every test of a server, since each run moves its item on.
 */
const tracker = fakeTrackerOf(name === "prepare" ? [...E2E_ITEMS, PREPARED_ITEM] : E2E_ITEMS);
// Issue #163 made onRequest the default choice of terms; the refinement scenarios and their layouts were written under
// unchecked, so the servers' shared configuration keeps it (test (38) chooses On request itself).
const shared = { terms: "unchecked" };
const access = name === "noTracker" ? { ...trackerAccessOf(tracker, shared), tracker: () => Result.fail(new NoTracker()) } : trackerAccessOf(tracker, shared);

const main = Effect.gen(function* () {
  const manager = yield* makeRunManager((ui, mode) => ({ ...testWiring(repo, { ...scenarioOf(mode), tracker }).wiring, ui: Effect.succeed(ui) }), repo, [], `e2e-${name}`, access, name === "chain" || name === "chainQueue" ? DEFAULT_SETTINGS : OFF_SETTINGS);
  // W1-R1-4: the unchangedPause scenario's held review is released when a run answers one of its questions beside it.
  if (name === "unchangedPause") {
    const beside = new Set<string>();
    yield* manager.subscribe((b) =>
      Effect.sync(() => {
        if (b._tag !== "event") return;
        if (b.event._tag === "Asked" && b.event.beside !== null) beside.add(`${b.run}:${b.event.prompt}`);
        if (b.event._tag === "Answered" && beside.has(`${b.run}:${b.event.prompt}`)) besideAnswered();
      }),
    );
  }
  // As src/web.ts: the tabs are closed by a finalizer registered after serveEffect, so it runs first (finding 15).
  const web = yield* makeWebServer(manager, distDir);
  yield* HttpServer.serveEffect(web.handler);
  yield* Effect.addFinalizer(() => web.closeAll);
  yield* Effect.sync(() => void process.stdout.write(`e2e server (${process.env.SCENARIO ?? "converge"}) on http://127.0.0.1:${port}/ in ${repo}\n`));
  return yield* Effect.never;
}).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layer(() => createServer(), { port })), Effect.provide(platformLayer));

NodeRuntime.runMain(main);

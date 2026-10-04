// The server of the end-to-end tests (plan step 5.1): the real web server and run manager over the scripted
// agents of test/helpers.ts, in a temporary repository, so that no agent is reached. SCENARIO chooses the script
// of every run: "converge" (one accepted issue, then convergence), "decision" (a question from Claude Code),
// "stop" (a planning call that waits until it is interrupted), and those of finding 10 of docs/gui-review.md:
// "interview", "workCorrection", "tabs", "drop", "long"; and "questionReview", the question phase whose review raises
// an issue, so that Claude Code's response carries the amended list (defect A of docs/page-question-phase-defects.md);
// "longChoices", an interview turn whose numbered answers are paragraphs (issue #12); "decide", a plan writer's question
// with two options on which the user takes "Help me decide" (decision support); "decideLong", the same with a
// recommendation of several paragraphs (W1-R1-3); "decideRevise", an analysis whose first review raises an issue that
// Claude accepts with an amended analysis (W2-R1-1); "decideBlank", an interview turn with numbered answers on which the
// user takes "Help me decide" and then sends an empty message, which the run rejects (W3-R1-1); "planSteps" (issue #6),
// a plan of two stages whose execution reports its steps and stops, a revision with a new step whose text is long, and
// a second execution that reports a step and then waits until it is stopped.
// PORT is the port.

import { Effect } from "effect";
import { HttpServer } from "effect/unstable/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { platformLayer } from "../src/platform.ts";
import { makeRunManager } from "../src/runManager.ts";
import { makeWebServer } from "../src/webServer.ts";
import { LONG_ANSWERS } from "./longAnswers.ts";
import { finished, issue, respond, type TestOptions, tempRepo, testWiring, questionOf, currentOf, entryOf } from "../test/helpers.ts";

const noQuestions = { questions_for_user: [] };
// S39 (W2-R1-2): a context long enough to overflow its region beside the analysis.
const LONG_DECISION_CONTEXT = Array.from({ length: 8 }, (_, i) => `Paragraph ${i + 1} of the context: the service keeps its data in a database, and the choice decides what runs beside it.`).join("\n\n");
/** A scripted interview turn; `asked` and `answered` are the ids Claude reports (issue #21). */
const turn = (message: string, complete: boolean, summary: string, asked: string[] = [], answered: string[] = []) => ({ message_to_user: message, current_question: currentOf({ id: "", context: "", text: "", terms: [], options: [] }), asked_ids: asked, answered_ids: answered, complete, summary });
/** A turn that asks the agreed question Q1 by its id: the page shows it from questions.json (S18). */
const asksQ1 = (message: string) => ({ ...turn(message, false, "", ["Q1"]), current_question: currentOf({ id: "Q1", context: "", text: "", terms: [], options: [] }) });
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
export const SCENARIOS: Record<string, TestOptions> = {
  converge: {
    steps: [{ output: noQuestions, plan: "1. [ ] the step\n" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "1. [ ] the step, amended\n" }],
    reviews: [{ issues: [issue("P1-R1-1", "The step names no file.")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  },
  decision: {
    steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which database should the service use?", terms: [], options: [] })] }, plan: "1. [ ] the step\n" }, { output: noQuestions }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  },
  stop: { steps: [{ output: noQuestions, plan: "1. [ ] the step\n" }, { hang: true }], reviews: [{ issues: [issue("P1-R1-1")] }] },
  // Finding 10 of docs/gui-review.md: the scenarios the review names.
  // The question phase: a question list, an interview message, /done, a proposed summary and its confirmation.
  interview: {
    config: { questionPhase: true },
    steps: [
      { output: { questions: [entryOf({ id: "Q1", context: "c", question: "Which database should the service use?", reason: "r", proposed_answers: [{ label: "PostgreSQL", description: "p" }, { label: "SQLite", description: "s" }], default_answer: "PostgreSQL" })] } },
      { output: asksQ1("The first question.") },
      { output: turn("Anything else?", false, "", ["Q1"], ["Q1"]) },
      { output: turn("That is all I need.", true, "# Requirements\n\nThe service uses PostgreSQL.", ["Q1"], ["Q1"]) },
      { output: noQuestions, plan: "1. [ ] the step\n" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  },
  // W3-R1-1: an empty message after the analysis is rejected and asked again; the analysis stays shown.
  decideBlank: {
    config: { questionPhase: true },
    steps: [
      { output: { questions: [entryOf({ id: "Q1", context: "c", question: "Which database should the service use?", reason: "r", proposed_answers: [{ label: "PostgreSQL", description: "p" }, { label: "SQLite", description: "s" }], default_answer: "PostgreSQL" })] } },
      { output: asksQ1("The first question.") },
      { output: { ...DECIDE_ANALYSIS, columns: [{ ...DECIDE_ANALYSIS.columns[1], option: "PostgreSQL" }, { ...DECIDE_ANALYSIS.columns[0], option: "SQLite" }] } },
      { output: turn("That is all I need.", true, "# Requirements\n\nThe service uses PostgreSQL.", ["Q1"], ["Q1"]) },
      { output: noQuestions, plan: "1. [ ] the step\n" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  },
  // Issue #83: an empty agreed question list, which the review accepts; planning starts without a prompt.
  emptyQuestions: {
    config: { questionPhase: true },
    steps: [{ output: { questions: [] } }, { output: noQuestions, plan: "1. [ ] the step\n" }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  },
  // Issue #12: the interview's numbered answers are paragraphs.
  longChoices: {
    config: { questionPhase: true },
    steps: [
      { output: { questions: [entryOf({ id: "Q1", context: "c", question: "How should a message show its time?", reason: "r", proposed_answers: LONG_ANSWERS.map((a) => { const [label, ...rest] = a.replace(/^\d+\. /, "").split(": "); return { label, description: rest.join(": ") }; }), default_answer: "Absolute clock time" })] } },
      { output: asksQ1("The first question.") },
      { output: turn("Anything else?", false, "") },
      { output: turn("That is all I need.", true, "# Requirements\n\nRelative time.") },
      { output: noQuestions, plan: "1. [ ] the step\n" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  },
  // Defect A of docs/page-question-phase-defects.md: the question list, its review with one issue, Claude Code's
  // response with the amended list, a second round without an issue, one interview turn with numbered answers, the
  // user's answer, a summary, the requirements review, then planning, execution and the work review.
  questionReview: {
    config: { questionPhase: true },
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
      { output: asksQ1("The first question.") },
      { output: turn("That is all I need.", true, "# Requirements\n\nThe service uses PostgreSQL on port 8080.") },
      { output: noQuestions, plan: "1. [ ] the step\n" },
    ],
    reviews: [{ issues: [issue("Q-R1-1", "The list does not ask for the port.")] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  },
  // A work correction: work review 1 raises an issue that Claude Code accepts, so planning, execution and the work
  // review run a second time, and the second work review converges.
  workCorrection: {
    steps: [{ output: noQuestions, plan: "1. [ ] the step\n" }, { output: respond([["W1-R1-1", "accepted"]]) }, { output: noQuestions, plan: "1. [x] the step\n2. [ ] the fix\n" }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1", "The step misses its test.")] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
  },
  // Two decisions in a row, for two tabs and a dropped connection.
  tabs: {
    steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which database should the service use?", terms: [], options: [] }), questionOf({ context: "c", question: "Which cache should the service use?", terms: [], options: [] })] }, plan: "1. [ ] the step\n" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  },
  drop: {
    steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which database should the service use?", terms: [], options: [] })] }, plan: "1. [ ] the step\n" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  },
  // Decision support: a question with two options, one analysis that converges in its first cycle, then the answer.
  decide: {
    steps: [
      { output: { questions_for_user: [questionOf({ context: "c", question: "Which database should the service use?", terms: [], options: [{ label: "SQLite", description: "one file, no server" }, { label: "PostgreSQL", description: "a database server" }] })] }, plan: "1. [ ] the step\n" },
      { output: DECIDE_ANALYSIS },
      { output: noQuestions },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  },
  // W1-R1-3: a long recommendation must not squeeze the columns.
  decideLong: {
    steps: [
      { output: { questions_for_user: [questionOf({ context: LONG_DECISION_CONTEXT, question: "Which database should the service use?", terms: [], options: [{ label: "SQLite", description: "one file, no server" }, { label: "PostgreSQL", description: "a database server" }] })] }, plan: "1. [ ] the step\n" },
      { output: { ...DECIDE_ANALYSIS, recommendation: { option: "SQLite", reason: LONG_RECOMMENDATION } } },
      { output: noQuestions },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  },
  // W2-R1-1: the analysis's review raises an issue; Claude's response carries the amended analysis to the page.
  decideRevise: {
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
  },
  // A long transcript: 60 accepted rounds, then two rounds without an acceptance and the idle pause, which waits.
  long: {
    config: { maxRounds: 100, maxIdleRounds: 2 },
    steps: [
      { output: noQuestions, plan: "v0\n" },
      ...Array.from({ length: LONG }, (_, i) => ({ output: respond([[`P1-R${i + 1}-1`, "accepted"]]), plan: `v${i + 1}\n`, resultText: `Round ${i + 1}: the plan now covers point ${i + 1} in detail. `.repeat(4) })),
      { output: respond([[`P1-R${LONG + 1}-1`, "rejected"]]) },
      { output: respond([[`P1-R${LONG + 2}-1`, "rejected"]]) },
    ],
    reviews: [
      ...Array.from({ length: LONG + 2 }, (_, i) => ({ issues: [issue(`P1-R${i + 1}-1`, `Point ${i + 1} of the plan is not specific enough to implement without guessing.`)] })),
      { issues: [] },
      { issues: [] },
    ],
    execs: [finished],
  },
};

// Issue #6: the plan of the "planSteps" scenario, and its revision with a step whose text is long enough to scroll.
const S1 = { id: "S1", number: 1, label: "Structured user questions (Q1)", text: "Add the **schema** of a question." };
const S2 = { id: "S2", number: 2, label: "The store", text: "Write `plan.json`." };
export const LONG_STEP_TEXT = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the step's text, which the tooltip scrolls.`).join("\n\n");
const S3 = { id: "S3", number: 1, label: "The long step", text: LONG_STEP_TEXT };
SCENARIOS.planSteps = {
  steps: [
    { output: { ...noQuestions, plan: { stages: [{ number: 1, title: "the schema and its records", steps: [S1, S2] }] } } },
    { output: { ...noQuestions, plan: { stages: [{ number: 1, title: "the schema and its records", steps: [S1, S2] }, { number: 2, title: "the page", steps: [S3] }] } } },
  ],
  reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
  execs: [{ status: "needs_input", summary: "S1 done", question: "A or B?", remainingWork: "S2", userInput: "B" }],
  execScripts: [{ reports: [["S1", "started"], ["S1", "done"], ["S2", "started"]] }, { reports: [["S2", "started"]], hang: true }],
};

// Issue #26: a Codex turn that fails from a transport fault and succeeds on its retry; the wait is long enough to be seen.
SCENARIOS.transportRetry = {
  steps: [{ output: noQuestions, plan: "1. [ ] the step\n" }],
  reviews: [{ issues: [], fault: "stream disconnected before completion" }, { issues: [] }, { issues: [] }],
  execs: [finished],
  config: { maxTransportRetries: 3, transportRetryDelaySeconds: 2 },
};
// Issue #30: an accepted issue with plan.json unchanged after the corrective turn: the pause, answered Proceed.
SCENARIOS.unchangedPause = {
  steps: [
    { output: noQuestions, plan: "1. [ ] the step\n" },
    { output: respond([["P1-R1-1", "accepted"]]) },
    { output: respond([["P1-R1-1", "accepted"]]) },
  ],
  reviews: [{ issues: [issue("P1-R1-1", "The step names no file.")] }, { issues: [] }, { issues: [] }],
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
SCENARIOS.longQuestion = {
  steps: [{ output: { questions_for_user: [LONG_QUESTION] }, plan: "1. [ ] the step\n" }, { output: noQuestions }],
  reviews: [{ issues: [] }, { issues: [] }],
  execs: [finished],
};

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

const scenario = SCENARIOS[process.env.SCENARIO ?? "converge"] ?? SCENARIOS.converge;
const port = Number(process.env.PORT ?? "8101");
const repo = tempRepo();
const distDir = fileURLToPath(new URL("../web/dist", import.meta.url));

const main = Effect.gen(function* () {
  const manager = yield* makeRunManager((ui) => ({ ...testWiring(repo, scenario).wiring, ui: Effect.succeed(ui) }), repo, `e2e-${process.env.SCENARIO ?? "converge"}`);
  // As src/web.ts: the tabs are closed by a finalizer registered after serveEffect, so it runs first (finding 15).
  const web = yield* makeWebServer(manager, distDir);
  yield* HttpServer.serveEffect(web.handler);
  yield* Effect.addFinalizer(() => web.closeAll);
  yield* Effect.sync(() => void process.stdout.write(`e2e server (${process.env.SCENARIO ?? "converge"}) on http://127.0.0.1:${port}/ in ${repo}\n`));
  return yield* Effect.never;
}).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layer(() => createServer(), { port })), Effect.provide(platformLayer));

NodeRuntime.runMain(main);

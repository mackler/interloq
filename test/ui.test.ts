import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Effect, Fiber } from "effect";
import type { RunError } from "../src/errors.ts";
import type { UiShape } from "../src/services.ts";
import * as prompts from "../src/prompts.ts";
import { terminalUi } from "../src/ui.ts";
import { program } from "../src/program.ts";
import { finished, tempRepo, testWiring, questionOf, para, plain } from "./helpers.ts";

type Streams = { input: PassThrough; output: PassThrough; written: () => string };
const streams = (): Streams => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk: Buffer | string) => void (written += String(chunk)));
  return { input, output, written: () => written };
};

/** Runs `use` with a terminal Ui on the streams, inside one scope. */
const withUi = <A, E>(io: Streams, use: (ui: UiShape) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.scoped(terminalUi(io.input, io.output).pipe(Effect.flatMap(use))));

/** A promise, or "timeout" after the given time, so that a hanging read fails instead of blocking the suite. */
const orTimeout = <A>(promise: Promise<A>, ms = 30_000): Promise<A | "timeout"> =>
  Promise.race([promise, sleep(ms, "timeout" as const, { ref: false })]);

/** Waits until the condition holds, polling; fails after 30 s, so that a loaded machine only slows a passing test. */
const eventually = async (what: string, condition: () => boolean, ms = 30_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
};

const stoppedByUser = (e: unknown): boolean => (e as RunError)._tag === "UserStopped";

test("ask reads its answer from the given input stream and writes the prompt to the given output stream", async () => {
  const io = streams();
  const answer = withUi(io, (ui) => ui.ask("Decision > "));
  io.input.write("keep it\n");
  assert.equal(await answer, "keep it");
  assert.match(io.written(), /Decision > /);
});

test("ask trims the answer", async () => {
  const io = streams();
  const answer = withUi(io, (ui) => ui.ask("Decision > "));
  io.input.write("  keep it  \n");
  assert.equal(await answer, "keep it");
});

test("askMessage reads from the given input stream", async () => {
  const io = streams();
  const message = withUi(io, (ui) => ui.askMessage("You > "));
  io.input.write("one line\n");
  assert.equal(await message, "one line");
});

test("askMessage reads a triple-quoted block of several lines", async () => {
  const io = streams();
  const message = withUi(io, (ui) => ui.askMessage("You > "));
  io.input.write('"""\nline 1\n\nline 3\n"""\n');
  assert.equal(await message, "line 1\n\nline 3");
});

test("pasted lines are not lost between two askMessage calls", async () => {
  const io = streams();
  io.input.write("one\ntwo\n");
  const both = withUi(io, (ui) => Effect.all([ui.askMessage("You > "), ui.askMessage("You > ")]));
  assert.deepEqual(await orTimeout(both), ["one", "two"]);
});

// Finding 20: the dialogue is serialized; a second concurrent ask waits for the first.
test("two concurrent asks are answered in order, and the second prompt appears only after the first answer", async () => {
  const io = streams();
  const answers = withUi(io, (ui) => Effect.all([ui.ask("First > "), ui.ask("Second > ")], { concurrency: "unbounded" }));
  await eventually("the first prompt", () => /First > /.test(io.written()));
  await sleep(20);
  assert.doesNotMatch(io.written(), /Second > /, "the second prompt was shown while the first ask was pending");
  io.input.write("one\n");
  await eventually("the second prompt", () => /Second > /.test(io.written()));
  io.input.write("two\n");
  assert.deepEqual(await orTimeout(answers), ["one", "two"]);
});

test("say writes the text and a newline", async () => {
  const io = streams();
  await withUi(io, (ui) => ui.say("hello"));
  assert.equal(io.written(), "hello\n");
});

test("ask q fails with UserStopped", async () => {
  const io = streams();
  const answer = withUi(io, (ui) => ui.ask("Decision > "));
  io.input.write("q\ny\n");
  await assert.rejects(answer, stoppedByUser);
});

test("askMessage /quit fails with UserStopped", async () => {
  const io = streams();
  const message = withUi(io, (ui) => ui.askMessage("You > "));
  io.input.write("/quit\ny\n");
  await assert.rejects(message, stoppedByUser);
});

test("interrupting ask closes the readline interface", async () => {
  const io = streams();
  const fiber = Effect.runFork(Effect.scoped(terminalUi(io.input, io.output).pipe(Effect.flatMap((ui) => ui.ask("Decision > ")))));
  while (!io.written().includes("Decision > ")) await sleep(5);
  assert.ok(io.input.listenerCount("data") > 0, "the interface is not reading the input while ask waits");
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(io.input.listenerCount("data"), 0, "the interface still reads the input after the interruption");
  assert.equal(io.input.listenerCount("end"), 0);
});

test("Ctrl+C in a terminal reaches the process as SIGINT while the interface is open", async () => {
  // readline handles Ctrl+C itself in terminal mode, so the resource must pass it on.
  const io = streams();
  (io.output as PassThrough & { isTTY?: boolean }).isTTY = true;
  const signals: string[] = [];
  const fiber = Effect.runFork(Effect.scoped(terminalUi(io.input, io.output, () => signals.push("SIGINT")).pipe(Effect.flatMap((ui) => ui.ask("Decision > ")))));
  while (!io.written().includes("Decision > ")) await sleep(5);
  io.input.write("\x03");
  await eventually("the SIGINT", () => signals.length > 0);
  assert.deepEqual(signals, ["SIGINT"]);
  await Effect.runPromise(Fiber.interrupt(fiber));
});

test("notify writes nothing to the terminal", async () => {
  const io = streams();
  await withUi(io, (ui) => ui.notify({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } }));
  assert.equal(io.written(), "");
});

// Finding 8 of docs/gui-review.md: the terminal renders the interview's opening help, with its """ convention.
test("notify renders the interview's opening help in the terminal, with the multiline convention", async () => {
  const io = streams();
  await withUi(io, (ui) => ui.notify({ _tag: "InterviewOpened", heading: "Clarification", stage: "clarification", total: 1 }));
  assert.ok(io.written().includes(prompts.interviewHelp("Clarification", "terminal")));
  assert.match(io.written(), /""" on its own line/);
});

// Issue #5 (Q2): the terminal keeps the "[claude] " prefix, its only attribution of Claude Code's prose.
test("notify renders Claude Code's prose in the terminal with the [claude] prefix", async () => {
  const io = streams();
  await withUi(io, (ui) => ui.notify({ _tag: "ClaudeSaid", text: "done" }));
  assert.equal(io.written(), "[claude] done\n");
});

// Decision support, plan step 5.2: the terminal prints a decision's analysis when it is shown.
test("notify prints a decision's analysis in the terminal", async () => {
  const io = streams();
  const analysis = { decision: "d", columns: [{ kind: "argued" as const, option: "A", advantages: [], disadvantages: [] }, { kind: "argued" as const, option: "B", advantages: [], disadvantages: [] }], recommendation: { option: "", reason: "" } };
  await withUi(io, (ui) => ui.notify({ _tag: "DecisionAnalyzed", decision: 1, question: "A or B?", presented: { number: 1, origin: { kind: "relayed" }, context: { blocks: para("c"), by: "agent" }, explanations: [], question: plain("Q?"), options: [], details: [], decision: null }, options: [], analysis }));
  // S22: the heading names the question's number, and the question as the user was shown it precedes the options.
  assert.equal(io.written(), ["", prompts.decisionViewHeading(1, 1), "", "    c", "", "Q?", "", "Option 1: A", "", "  Advantages:", "", "  Disadvantages:", "", "Option 2: B", "", "  Advantages:", "", "  Disadvantages:", ""].join("\n") + "\n");
});

// W3-R1-1: the rejection of a reply is for the page; the terminal prints nothing for it.
test("notify prints nothing for AnswerRejected", async () => {
  const io = streams();
  await withUi(io, (ui) => ui.notify({ _tag: "AnswerRejected" }));
  assert.equal(io.written(), "");
});

// W1-R1-2 (P2-R1-1): a run through the program with the terminal Ui over streams: a decision's analysis whose texts
// span several lines prints every line indented, and every line of an opposing text with the marker.
test("a run with the terminal Ui prints every line of a multiline analysis text indented, and marked where it opposes", async () => {
  const el = (text: string, counterarguments: unknown[] = []) => ({ text, counterarguments });
  const entry = (id: string, first: string, counter: unknown[] = []) => ({
    id,
    title: `Title ${id}.`,
    comparative_condition: el(first, counter),
    starting_cause: el(`s ${id}`),
    intermediate_steps: el(`i ${id}`),
    threshold: el(`t ${id}`),
    effect_on_persons: el(`e ${id}`),
    reason_the_effect_matters: el(`r ${id}`),
    extent: { per_person: el(`pp ${id}`), persons_affected: el(`pa ${id}`), likelihood: el(`l ${id}`), timing: el(`w ${id}`) },
  });
  const defense = { id: "A1", text: "But one.", equivalent_to: "", replies: [{ id: "A2", text: "On the other hand two.\nStill two.", equivalent_to: "", replies: [] }] };
  const analysis = {
    decision: "Which database?",
    columns: [
      { kind: "argued", option: "SQLite", advantages: [], disadvantages: [entry("E1", "First sentence.\nSecond sentence.", [defense])] },
      { kind: "unclear", option: "PostgreSQL", unclear: "It could mean a server.\nOr a hosted service." },
    ],
    recommendation: { option: "", reason: "" },
  };
  const question = questionOf({ context: "c", question: "Which database?", terms: [], options: [{ label: "SQLite", description: "a file" }, { label: "PostgreSQL", description: "a server" }] });
  const io = streams();
  const { wiring } = testWiring(tempRepo(), {
    steps: [{ output: { questions_for_user: [question] }, plan: "1. [ ] the step\n" }, { output: analysis }, { output: { questions_for_user: [] } }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  const running = Effect.runPromise(Effect.scoped(program(["task"], { ...wiring, ui: terminalUi(io.input, io.output, () => undefined) })));
  const offers = () => io.written().split(prompts.OFFER_LINE).length - 1;
  await eventually("the offer", () => offers() >= 1);
  io.input.write("/decide\n");
  await eventually("the question asked again", () => offers() >= 2);
  io.input.write("1\n");
  assert.equal(await running, 0);
  const lines = io.written().split("\n");
  const m = prompts.OPPOSES_MARKER;
  // The disadvantage's element: its bullet, and the continuation aligned under the text; both marked.
  assert.ok(lines.includes(`    ${m}- First sentence.`), io.written());
  assert.ok(lines.includes(`    ${m}  Second sentence.`), io.written());
  // The defense under a disadvantage opposes the option, on both of its lines.
  assert.ok(lines.includes(`          ${m}On the other hand two.`), io.written());
  assert.ok(lines.includes(`          ${m}Still two.`), io.written());
  // The counterargument to the disadvantage supports the option: no marker.
  assert.ok(lines.includes("        But one."), io.written());
  // The unclear statement: every line indented, none marked.
  assert.ok(lines.includes("  It could mean a server."), io.written());
  assert.ok(lines.includes("  Or a hosted service."), io.written());
});

// Issue #26 (S21): the SDK's own reconnection and the recovery are printed; the program's retry is said by the
// retry itself, so its event prints nothing more.
test("notify prints the SDK's reconnection and the recovery, and nothing for the program's retry event", async () => {
  const io = streams();
  await withUi(io, (ui) =>
    ui.notify({ _tag: "AgentReconnecting", agent: "codex", by: "sdk", attempt: null, of: null, delayMs: null, detail: "Reconnecting... 2/5" }).pipe(
      Effect.andThen(ui.notify({ _tag: "TransportRetrying", agent: "codex", attempt: 1, of: 3, delaySeconds: 5, fault: "x", fromMs: 0, untilMs: 5000 })),
      Effect.andThen(ui.notify({ _tag: "TransportRecovered", agent: "codex" })),
    ),
  );
  assert.equal(io.written(), `${prompts.agentReconnectingLine("Codex", null, null, null, "Reconnecting... 2/5")}\n${prompts.transportRecoveredLine("codex")}\n`);
});

// S24 (issue #25, Q11): an answer that ends the run is confirmed first; anything but y returns to the question.
test("q at a question asks for confirmation; n returns to the question, y ends the run", async () => {
  const io = streams();
  const answer = withUi(io, (ui) => ui.ask(prompts.decisionPrompt));
  io.input.write("q\nn\nkeep it\n");
  assert.equal(await answer, "keep it");
  assert.ok(io.written().includes(prompts.confirmEndPrompt("endRun")));
  assert.equal(io.written().split(prompts.decisionPrompt).length - 1, 2, "the question's prompt was not asked again");
});

test("an empty answer at the cycle limit is confirmed as the halt; y returns it, so that the loop halts", async () => {
  const io = streams();
  const answer = withUi(io, (ui) => ui.ask(prompts.withOffer(prompts.limitPrompt)));
  io.input.write("\ny\n");
  assert.equal(await answer, "");
  assert.ok(io.written().includes(prompts.confirmEndPrompt("limitStop")));
});

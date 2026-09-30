// S9 and S10 (decision Q1, G-R1-1), and S9 of the task of issue #36 (decisions G-R1-1 and F1): a fresh Claude Code
// session writes the context paragraph of a question the program composed and returns the whole question as pieces; the
// reply is held to the rules of every question, the data clauses of the format, the options' count, the literal values
// and the references the program supplied, with the repair turns of behaviour 10, and a call that cannot succeed leaves
// the program's own paragraph and its own question, so that the question is asked.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Result } from "effect";
import fc from "fast-check";
import { askOffering, numberedOptions, permissionDraft, type QuestionDraft } from "../src/offer.ts";
import { blockPieces, literalsOf, piecesText, plainBlocks } from "../src/pieces.ts";
import * as prompts from "../src/prompts.ts";
import { contextValidation, writeContext } from "../src/questionContext.ts";
import type { Block, Piece, QuestionContext } from "../src/schema.ts";
import { Store, Ui } from "../src/services.ts";
import { opt, para, plain, presentedQuestions, SCRIPTED_CONTEXT, scriptedContextReply, tempRepo, term, testLayer, type TestOptions } from "./helpers.ts";

const origin = { kind: "permission", tool: "Bash", input: "npm install zod" } as const;
const details: readonly Block[] = [
  { kind: "paragraph", pieces: plain(prompts.TOOL_INPUT_HEADING) },
  { kind: "list", items: [{ level: 0, pieces: [...plain("The command: "), { text: "npm install zod", ref: "", code: true }] }] },
];
const request: prompts.ContextRequest = {
  origin,
  decision: null,
  question: plain("Claude Code wants to run the command shown above. Do you want to allow it?"),
  options: [opt("Allow", "zod is installed."), opt("Deny", "Nothing is installed.")],
  details,
  explanations: [],
  facts: "The command npm install zod adds the library zod to the project.",
};
const zod = { id: "z", term: "zod", explanation: "A library that checks that data has the shape a program expects." };
const good: QuestionContext = {
  context: [{ kind: "paragraph", pieces: [...plain("Claude Code, the coding agent, is carrying out the plan in this project. It wants to run a command that installs "), term("zod", "z"), ...plain(", a library, now, while the plan's work waits, so that it can check the input of a tool.")] }],
  question: request.question,
  options: [{ label: plain("Allow"), description: [term("zod", "z"), ...plain(" is installed.")] }, request.options[1]],
  details,
  explanations: [zod],
};
/** The services over a repository whose records are initialized, as at the start of a run. */
const initialized = (options: TestOptions) => testLayer(tempRepo(), options);
const run = (options: TestOptions, req: prompts.ContextRequest = request) => {
  const { probe, layer } = initialized(options);
  return {
    probe,
    written: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* (yield* Store).init("the task");
          return yield* writeContext("the task", req);
        }).pipe(Effect.provide(layer)),
      ),
  };
};
const conversation = (dir: string) => fs.readFileSync(path.join(dir, "conversation.md"), "utf8");
const repairOf = (...problems: prompts.QuestionProblem[]) => prompts.questionRepairPrompt([{ where: "the question", problems }]);

test("the context call is a read-only call in a fresh session, with the rules, the format, the task, the facts and the question as data", async () => {
  const { probe, written } = run({ contexts: [{ output: good }] });
  assert.deepEqual(await written(), { context: { blocks: good.context, by: "agent" }, explanations: good.explanations, question: good.question, options: good.options, details: good.details });
  assert.equal(probe.planner.freshSessions, 1);
  assert.equal(probe.planner.contextPrompts.length, 1);
  const prompt = probe.planner.contextPrompts[0];
  for (const part of [prompts.questionWritingRules(), prompts.QUESTION_TEXT_FORMAT, prompts.KEEP_OPTIONS, prompts.KEEP_LITERALS, "the task", request.facts, prompts.originLine(origin, null), prompts.CONTEXT_REQUEST_HEADING]) assert.ok(prompt.includes(part), part);
  assert.deepEqual(JSON.parse(prompt.slice(prompt.indexOf(prompts.CONTEXT_REQUEST_HEADING) + prompts.CONTEXT_REQUEST_HEADING.length)), { question: request.question, options: request.options, details: request.details, explanations: [] });
  assert.ok(!prompt.includes(prompts.KEEP_SUPPLIED_REFS), "no reference is supplied here");
  assert.deepEqual(probe.planner.prompts, [], "the other calls' scripts are untouched");
});

test("a reply that does not match the schema gets its repair turn; a reply that breaks a rule gets the validation repair turn", async () => {
  const schema = run({ contexts: [{ output: { context: 1 } }, { output: good }] });
  assert.equal((await schema.written()).context.by, "agent");
  assert.equal(schema.probe.planner.contextPrompts.length, 2);
  const dangling = { ...good, explanations: [] };
  const rule = run({ contexts: [{ output: dangling }, { output: good }] });
  assert.equal((await rule.written()).context.by, "agent");
  assert.equal(rule.probe.planner.contextPrompts[1], repairOf({ kind: "unknownRef", subject: "z" }));
});

test("S10: a second invalid reply leaves the program's own paragraph and question, with a note in conversation.md", async () => {
  const blank = { ...good, context: para(" ") };
  const { probe, written } = run({ contexts: [{ output: blank }, { output: blank }] });
  assert.deepEqual(await written(), { context: { blocks: plainBlocks(prompts.fallbackContext(origin)), by: "program" }, explanations: [] });
  assert.match(conversation(probe.dir), /\*\*Context written by Interloq:\*\*/);
});

// G-R1-1: the question sentence, the options and the details' prose may be rephrased; F1: every literal value is kept.
test("G-R1-1: a rephrased question, options and details' prose pass; F1: a changed, added, removed or moved literal is rejected", () => {
  const validate = contextValidation(request);
  const rephrased: QuestionContext = {
    ...good,
    question: [...plain("Do you want "), term("Claude Code", "c"), ...plain(" to run the command shown above?")],
    explanations: [...good.explanations, { id: "c", term: "Claude Code", explanation: "The AI agent that carries out the plan." }],
    options: [opt("Yes, allow it", "The library is installed."), opt("No", "Nothing changes.")],
    details: [{ kind: "paragraph", pieces: plain("What the agent would do:") }, { kind: "list", items: [{ level: 0, pieces: [...plain("It would run "), { text: "npm install zod", ref: "", code: true }] }] }],
  };
  assert.ok(Result.isSuccess(validate(rephrased)));
  const changed = (d: readonly Block[]) => ({ ...good, details: d });
  const literal = (text: string): Piece => ({ text, ref: "", code: true });
  for (const [what, d] of [
    ["changed", [details[0], { kind: "list", items: [{ level: 0, pieces: [...plain("The command: "), literal("npm install zod@4")] }] }]],
    ["removed", [details[0], { kind: "list", items: [{ level: 0, pieces: plain("The command: npm install zod") }] }]],
    ["added", [...details, { kind: "code", text: "rm -rf /" }]],
    ["moved into a code block", [details[0], { kind: "code", text: "npm install zod" }, { kind: "list", items: [{ level: 0, pieces: [literal("npm install zod")] }] }]],
  ] as const) {
    const result = validate(changed(d as readonly Block[]));
    assert.ok(Result.isFailure(result), what);
    assert.equal(result.failure.repair, repairOf({ kind: "literalChanged", subject: "" }), what);
  }
  assert.ok(Result.isFailure(validate({ ...good, details: [details[0], { kind: "list", items: [{ level: 0, pieces: [...plain("The command: "), { text: "npm install zod", ref: "z", code: true }] }] }] })), "a ref added to a literal");
  const fewer = validate({ ...good, options: good.options.slice(0, 1) });
  assert.ok(Result.isFailure(fewer));
  assert.equal(fewer.failure.repair, repairOf({ kind: "optionsChanged", subject: "" }));
});

// S9 (P1-R1-3): the one exception to "no ref on a code piece", the program's own explanation of a setting's name, stated
// in the prompt alone and checked by the validation: the seam of the two, for a permission request with an unknown field.
test("S9 seam: KEEP_SUPPLIED_REFS is in the prompt of a request that supplies a reference, and the validation holds the reply to it", () => {
  const draft = permissionDraft("Bash", { command: "ls", max_depth: 3 });
  const supplied: prompts.ContextRequest = { origin, decision: null, question: draft.question, options: draft.options.map((o) => o.shown), details: draft.details as readonly Block[], explanations: draft.explanations, facts: "" };
  const prompt = prompts.contextPrompt("t", supplied);
  assert.ok(prompt.includes(prompts.KEEP_SUPPLIED_REFS));
  const named = blockPieces(supplied.details).find((p) => p.code && p.ref !== "");
  assert.ok(named !== undefined && named.text === "max_depth");
  // Built exactly as the prompt instructs: the supplied piece kept with its ref and an explanation of that id.
  const reply = scriptedContextReply(prompt);
  assert.ok(Result.isSuccess(contextValidation(supplied)(reply)));
  // The supplied reference dropped.
  const dropRef = (b: Block): Block => (b.kind === "list" ? { ...b, items: b.items.map((i) => ({ ...i, pieces: i.pieces.map((p) => (p.ref === named.ref ? { ...p, ref: "" } : p)) })) } : b);
  const dropped = contextValidation(supplied)({ ...reply, details: reply.details.map(dropRef), explanations: [] });
  assert.ok(Result.isFailure(dropped));
  assert.equal(dropped.failure.repair, repairOf({ kind: "suppliedRefDropped", subject: "max_depth" }));
  assert.ok(dropped.failure.repair.includes(prompts.KEEP_SUPPLIED_REFS));
  // A ref added to a value's code piece.
  const addRef = (b: Block): Block => (b.kind === "list" ? { ...b, items: b.items.map((i) => ({ ...i, pieces: i.pieces.map((p) => (p.code && p.text === "ls" ? { ...p, ref: named.ref } : p)) })) } : b);
  const added = contextValidation(supplied)({ ...reply, details: reply.details.map(addRef) });
  assert.ok(Result.isFailure(added));
  assert.equal(added.failure.repair, repairOf({ kind: "refOnCode", subject: "ls" }));
  assert.ok(added.failure.repair.includes(prompts.QUESTION_FORMAT.find((c) => c.id === "code")?.text ?? "?"));
});

test("property F1: a reply that keeps the literals and the options, whatever its prose, passes the literal check", () => {
  const prose = fc.string({ minLength: 1, maxLength: 12 }).filter((t) => t.trim() !== "" && !t.includes("#"));
  fc.assert(
    fc.property(fc.array(prose, { minLength: 1, maxLength: 3 }), prose, (words, q) => {
      const d: readonly Block[] = [...words.map((w): Block => ({ kind: "paragraph", pieces: plain(w) })), { kind: "list", items: [{ level: 0, pieces: [...plain(words[0]), { text: "npm install zod", ref: "", code: true }] }] }];
      const reply: QuestionContext = { ...good, question: plain(`${q}?`), details: d };
      return JSON.stringify(literalsOf(reply.details)) === JSON.stringify(literalsOf(request.details)) && Result.isSuccess(contextValidation(request)(reply));
    }),
    { numRuns: 200 },
  );
});

test("S9: a question that asks for its context is presented with the agent's paragraph, pieces and explanations", async () => {
  const { layer, probe } = initialized({ answers: ["1"], contexts: [{ output: good }] });
  const draft: QuestionDraft = { origin, context: { blocks: [], by: "program" }, explanations: [], question: request.question, options: numberedOptions(request.options), details, explain: request.facts, decision: null };
  const ask = Effect.gen(function* () {
    yield* (yield* Store).init("the task");
    const ui = yield* Ui;
    return yield* askOffering((p) => ui.ask(p), prompts.permissionPrompt, draft);
  });
  await Effect.runPromise(ask.pipe(Effect.provide(layer)));
  const [q] = presentedQuestions(probe.ui);
  assert.deepEqual(q.context, { blocks: good.context, by: "agent" });
  assert.deepEqual(q.explanations, good.explanations);
  assert.deepEqual(q.options.map((o) => o.description), good.options.map((o) => o.description));
  assert.deepEqual(q.options.map((o) => o.answer), [{ token: "1" }, { token: "2" }], "each option keeps its answer, paired by position");
  // Without a scripted reply, a context call returns the scripted default, which keeps the rules.
  const scripted = initialized({ answers: ["1"] });
  await Effect.runPromise(ask.pipe(Effect.provide(scripted.layer)));
  const [shown] = presentedQuestions(scripted.probe.ui);
  assert.equal(piecesText(shown.context.blocks[0].kind === "paragraph" ? shown.context.blocks[0].pieces : []), SCRIPTED_CONTEXT.context);
});

// F1 (G-R1-1 of the requirements): a reply that alters a command twice leaves the program's own text for the user.
test("F1 scenario: a context call that alters the command twice leaves Interloq's own question and command", async () => {
  const altered: QuestionContext = { ...good, details: [details[0], { kind: "list", items: [{ level: 0, pieces: [...plain("The command: "), { text: "npm install zod --force", ref: "", code: true }] }] }] };
  const { layer, probe } = initialized({ answers: ["1"], contexts: [{ output: altered }, { output: altered }] });
  const draft: QuestionDraft = { origin, context: { blocks: [], by: "program" }, explanations: [], question: request.question, options: numberedOptions(request.options), details, explain: request.facts, decision: null };
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* Store).init("the task");
      const ui = yield* Ui;
      return yield* askOffering((p) => ui.ask(p), prompts.permissionPrompt, draft);
    }).pipe(Effect.provide(layer)),
  );
  const [q] = presentedQuestions(probe.ui);
  assert.equal(q.context.by, "program");
  assert.deepEqual(q.details, details);
  assert.deepEqual(q.question, request.question);
  assert.equal(probe.planner.contextPrompts[1], repairOf({ kind: "literalChanged", subject: "" }));
});

test("S10: a context call whose retries are exhausted asks nothing of its own; the program's paragraph stands", async () => {
  const fault = { fault: "read ECONNRESET" };
  const { probe, written } = run({ contexts: [fault, fault], config: { maxTransportRetries: 1, transportRetryDelaySeconds: 0.01 } });
  assert.deepEqual(await written(), { context: { blocks: plainBlocks(prompts.fallbackContext(origin)), by: "program" }, explanations: [] });
  assert.equal(probe.planner.contextPrompts.length, 2, "one call and one retry");
  assert.deepEqual(probe.ui.asked, [], "no exhaustion pause was asked");
  assert.deepEqual(presentedQuestions(probe.ui), []);
  assert.match(conversation(probe.dir), /\*\*Context written by Interloq:\*\*.*could not be reached/);
});

// S33 (W1-R1-1): the context call reads the project and writes nothing: its own capability, with the records guard.
test("the context call is made with the readProject capability", async () => {
  const { probe, written } = run({ contexts: [{ output: good }] });
  await written();
  assert.deepEqual(probe.planner.contextCapabilities, ["readProject"]);
});

test("a context call that changes a guarded record halts with RecordsChanged; the fallback does not catch it", async () => {
  const { written } = run({ contexts: [{ output: good, editRecord: { file: "foreign.md", content: "x" } }] });
  await assert.rejects(written(), (e: unknown) => (e as { _tag?: string })._tag === "RecordsChanged");
});

test("a context call that changes the project halts with ProjectChanged; the fallback does not catch it", async () => {
  const { written } = run({ contexts: [{ output: good, touchProject: true }] });
  await assert.rejects(written(), (e: unknown) => (e as { _tag?: string })._tag === "ProjectChanged");
});

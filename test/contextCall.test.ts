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
import { blockPieces, literalsOf, piecesText, plainBlocks, valueTokensOf } from "../src/pieces.ts";
import * as prompts from "../src/prompts.ts";
import { contextValidation, writeContext } from "../src/questionContext.ts";
import { questionProblems } from "../src/question.ts";
import type { Block, Piece, QuestionContext } from "../src/schema.ts";
import { Store, Ui } from "../src/services.ts";
import { finished, opt, para, plain, presentedQuestions, runTask, SCRIPTED_CONTEXT, scriptedContextReply, tempRepo, term, testLayer, type TestOptions } from "./helpers.ts";

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
  // S32: the dropped reference is also a changed value at its position.
  assert.equal(dropped.failure.repair, repairOf({ kind: "literalChanged", subject: "" }, { kind: "suppliedRefDropped", subject: "max_depth" }));
  assert.ok(dropped.failure.repair.includes(prompts.KEEP_SUPPLIED_REFS));
  // A ref added to a value's code piece.
  const addRef = (b: Block): Block => (b.kind === "list" ? { ...b, items: b.items.map((i) => ({ ...i, pieces: i.pieces.map((p) => (p.code && p.text === "ls" ? { ...p, ref: named.ref } : p)) })) } : b);
  const added = contextValidation(supplied)({ ...reply, details: reply.details.map(addRef) });
  assert.ok(Result.isFailure(added));
  // W4-R1-1: the value's ref is compared by position too.
  assert.equal(added.failure.repair, repairOf({ kind: "refOnCode", subject: "ls" }, { kind: "literalChanged", subject: "" }));
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

// ---- W1-R1-1 (S22): every value of a tool's input, code or phrase, in one order, none added ------------------------

/** A permission request as the context call is given it, from the input of a tool. */
const permissionRequest = (tool: string, input: Record<string, unknown>): prompts.ContextRequest => {
  const draft = permissionDraft(tool, input);
  return { origin: { kind: "permission", tool, input: "" }, decision: null, question: draft.question, options: draft.options.map((o) => o.shown), details: draft.details as readonly Block[], explanations: draft.explanations, facts: "" };
};
/** The reply a context call returns when it does exactly what its prompt says: the question as given. */
const faithful = (request: prompts.ContextRequest): QuestionContext => scriptedContextReply(prompts.contextPrompt("t", request));
/** The details with every piece passed through `f` (a list item's pieces too). */
const mapPieces = (blocks: readonly Block[], f: (pieces: readonly Piece[]) => readonly Piece[]): readonly Block[] =>
  blocks.map((b) => (b.kind === "paragraph" ? { ...b, pieces: f(b.pieces) } : b.kind === "list" ? { ...b, items: b.items.map((i) => ({ ...i, pieces: f(i.pieces) })) } : b));
const literalRepair = repairOf({ kind: "literalChanged", subject: "" });
/** The details with every code block replaced by a paragraph holding one code piece of the same text. */
const blocksAsPieces = (blocks: readonly Block[]): readonly Block[] => blocks.map((b): Block => (b.kind === "code" ? { kind: "paragraph", pieces: [{ text: b.text, ref: "", code: true }] } : b));
const codeLineClause = prompts.QUESTION_FORMAT.find((c) => c.id === "codeLine");

test("W1-R1-1: a changed number, a changed yes or no, values exchanged between rows and an added value are each rejected", () => {
  const request = permissionRequest("Bash", { command: "echo ok", timeout: 120000, run_in_background: false });
  const reply = faithful(request);
  const validate = contextValidation(request);
  assert.ok(Result.isSuccess(validate(reply)));
  assert.deepEqual(valueTokensOf(request.details), [
    { kind: "code", text: "echo ok", ref: "" },
    { kind: "code", text: "120000", ref: "" },
    // The name of a setting Interloq has no label for is a literal too, before its value, with the program's reference.
    { kind: "code", text: "run_in_background", ref: "setting-1" },
    { kind: "phrase", text: prompts.NO_PHRASE, ref: "" },
  ]);
  const withDetails = (f: (ps: readonly Piece[]) => readonly Piece[]) => ({ ...reply, details: mapPieces(reply.details, f) });
  const cases: Readonly<Record<string, QuestionContext>> = {
    "the timeout changed": withDetails((ps) => ps.map((p) => (p.code && p.text === "120000" ? { ...p, text: "1" } : p))),
    "the background setting changed": withDetails((ps) => ps.map((p) => (!p.code ? { ...p, text: p.text.replace(prompts.NO_PHRASE, prompts.YES_PHRASE) } : p))),
    "the timeout and the background exchanged": withDetails((ps) =>
      ps.map((p) => (p.code && p.text === "120000" ? { text: prompts.NO_PHRASE, ref: "", code: false } : !p.code && p.text.includes(prompts.NO_PHRASE) ? { text: p.text.replace(prompts.NO_PHRASE, ""), ref: "", code: false } : p)).concat(ps.some((p) => !p.code && p.text.includes(prompts.NO_PHRASE)) ? [{ text: "120000", ref: "", code: true }] : []),
    ),
    "a setting added": { ...reply, details: [...reply.details, { kind: "paragraph", pieces: plain(`Another setting: ${prompts.YES_PHRASE}`) }] },
  };
  for (const [what, changed] of Object.entries(cases)) {
    const result = validate(changed);
    assert.ok(Result.isFailure(result), what);
    assert.equal(result.failure.repair, literalRepair, what);
  }
  assert.ok(literalRepair.includes(prompts.KEEP_LITERALS));
});

test("W1-R1-1 regressions: a code value turned into a plain phrase of the same words, and a whitespace phrase changed, are rejected", () => {
  const collision = permissionRequest("Bash", { command: prompts.NO_PHRASE, run_in_background: false });
  const reply = faithful(collision);
  const plainCommand = { ...reply, details: mapPieces(reply.details, (ps) => ps.map((p) => (p.code && p.text === prompts.NO_PHRASE ? { ...p, code: false } : p))) };
  assert.ok(Result.isFailure(contextValidation(collision)(plainCommand)));
  const spaces = permissionRequest("FutureTool", { separator: " " });
  const spaced = faithful(spaces);
  const twoSpaces = { ...spaced, details: mapPieces(spaced.details, (ps) => ps.map((p) => (!p.code ? { ...p, text: p.text.replace("(1 space)", "(2 spaces)") } : p))) };
  assert.ok(JSON.stringify(twoSpaces) !== JSON.stringify(spaced), "the phrase is in the details");
  assert.ok(Result.isFailure(contextValidation(spaces)(twoSpaces)));
});

test("W1-R1-1 seam: every whitespace phrase the program shows is recognized as one value phrase; ordinary words are not", () => {
  const ws = fc.string({ unit: fc.constantFrom(" ", "\t", "\n", "\r", "\u00a0", "\u2003"), minLength: 1, maxLength: 8 });
  fc.assert(
    fc.property(ws, (value) => {
      const shown = prompts.shownValue(value);
      return shown.kind === "phrase" && prompts.valuePhraseAt(shown.text, 0) === shown.text;
    }),
    { numRuns: 300 },
  );
  for (const phrase of [prompts.YES_PHRASE, prompts.NO_PHRASE, prompts.NONE_PHRASE, prompts.emptyTextPhrase, prompts.EMPTY_LIST_PHRASE, prompts.EMPTY_OBJECT_PHRASE, prompts.NO_INPUT_PHRASE]) assert.equal(prompts.valuePhraseAt(`a ${phrase} b`, 2), phrase);
  for (const words of ["(one space)", "(yes please)", "(1 spaces)", "(2 space)", "(0 spaces)"]) assert.equal(prompts.valuePhraseAt(words, 0), null, words);
});

test("W1-R1-1 seam: the prompt carries KEEP_LITERALS, and a reply that rephrases only the labels passes", () => {
  const request = permissionRequest("Bash", { command: "echo ok", timeout: 120000, run_in_background: false });
  assert.ok(prompts.contextPrompt("t", request).includes(prompts.KEEP_LITERALS));
  const reply = faithful(request);
  const rephrased = { ...reply, details: mapPieces(reply.details, (ps) => ps.map((p, i) => (i === 0 && !p.code ? { ...p, text: `Setting, ${p.text}` } : p))) };
  assert.ok(Result.isSuccess(contextValidation(request)(rephrased)));
});

test("property W1-R1-1: any change to a value of a tool's input is rejected; rephrasing the plain labels alone is accepted", () => {
  const ws = fc.string({ unit: fc.constantFrom(" ", "\t", "\n"), minLength: 1, maxLength: 3 });
  const value = fc.oneof(fc.string({ maxLength: 8 }), ws, fc.constant("printf a\nprintf b"), fc.integer(), fc.boolean(), fc.constant(null), fc.constant([]), fc.constant({}), fc.array(fc.oneof(fc.integer(), fc.boolean(), fc.string({ maxLength: 4 })), { maxLength: 2 }));
  const input = fc.dictionary(fc.constantFrom("command", "timeout", "flag", "mode", "items"), value, { minKeys: 1, maxKeys: 4 });
  type Mutation = (blocks: readonly Block[]) => readonly Block[] | null;
  const tokenPieces = (blocks: readonly Block[]) => blockPieces(blocks).filter((p) => p.code || valueTokensOf([{ kind: "paragraph", pieces: [p] }]).length > 0);
  const once = (blocks: readonly Block[], target: Piece, to: readonly Piece[]): readonly Block[] => {
    let done = false;
    return mapPieces(blocks, (ps) => ps.flatMap((p) => (!done && p === target ? ((done = true), to) : [p])));
  };
  const mutations: readonly Mutation[] = [
    // A value changed.
    (b) => { const t = tokenPieces(b)[0]; return t === undefined ? null : once(b, t, [t.code ? { ...t, text: `${t.text}x` } : { ...t, text: `${t.text} ${prompts.YES_PHRASE}` }]); },
    // A value removed.
    (b) => { const t = tokenPieces(b)[0]; return t === undefined ? null : once(b, t, []); },
    // A value added.
    (b) => [...b, { kind: "paragraph", pieces: plain(prompts.NONE_PHRASE) }],
    // A code value turned plain.
    (b) => { const t = blockPieces(b).find((p) => p.code && p.ref === "" && p.text !== "" && valueTokensOf([{ kind: "paragraph", pieces: [{ ...p, code: false }] }]).length !== 1); return t === undefined ? null : once(b, t, [{ ...t, code: false }]); },
    // W3-R1-1: a code block turned into a code piece of the same text.
    (b) => (b.some((x) => x.kind === "code") ? blocksAsPieces(b) : null),
    // Two values of different tokens exchanged.
    (b) => {
      const ts = tokenPieces(b);
      const [x, y] = [ts[0], ts.find((p) => JSON.stringify(valueTokensOf([{ kind: "paragraph", pieces: [p] }])) !== JSON.stringify(valueTokensOf([{ kind: "paragraph", pieces: [ts[0]] }])))];
      return x === undefined || y === undefined ? null : mapPieces(b, (ps) => ps.map((p) => (p === x ? y : p === y ? x : p)));
    },
  ];
  fc.assert(
    fc.property(input, fc.nat(mutations.length - 1), (tool, m) => {
      const request = permissionRequest("FutureTool", tool);
      const reply = faithful(request);
      const details = mutations[m](reply.details as readonly Block[]);
      const rephrased = { ...reply, details: mapPieces(reply.details, (ps) => ps.map((p) => (!p.code && p.ref === "" && valueTokensOf([{ kind: "paragraph", pieces: [p] }]).length === 0 ? { ...p, text: `Now ${p.text}` } : p))) };
      const keeps = Result.isSuccess(contextValidation(request)(rephrased));
      return keeps && (details === null || Result.isFailure(contextValidation(request)({ ...reply, details })));
    }),
    { numRuns: 200 },
  );
});

test("W1-R1-1 scenario: a reply that changes the timeout twice leaves Interloq's own details", async () => {
  const request = permissionRequest("Bash", { command: "echo ok", timeout: 120000, run_in_background: false });
  const reply = faithful(request);
  const changed = { ...reply, details: mapPieces(reply.details, (ps) => ps.map((p) => (p.code && p.text === "120000" ? { ...p, text: "1" } : p))) };
  const { probe, written } = run({ contexts: [{ output: changed }, { output: changed }] }, request);
  const result = await written();
  assert.equal(result.context.by, "program");
  assert.equal(result.details, undefined, "Interloq's own details stand");
  assert.equal(probe.planner.contextPrompts[1], literalRepair);
});

// ---- W2-R1-2 (S27): value phrases are found in the joined runs of plain pieces --------------------------------------

test("W2-R1-2 regression: a value phrase divided across two plain pieces is the same value", () => {
  const request = permissionRequest("Bash", { run_in_background: false });
  const reply = faithful(request);
  const divided = {
    ...reply,
    details: mapPieces(reply.details, (ps) =>
      ps.flatMap((p) => {
        const at = p.code ? -1 : p.text.indexOf(prompts.NO_PHRASE);
        return at < 0 ? [p] : [{ ...p, text: p.text.slice(0, at + 1) }, { ...p, text: p.text.slice(at + 1) }];
      }),
    ),
  };
  assert.ok(JSON.stringify(divided) !== JSON.stringify(reply), "the phrase was divided");
  assert.ok(Result.isSuccess(contextValidation(request)(divided)));
});

test("property W2-R1-2: any re-division of the plain pieces, pieces that refer to explanations included, leaves the values unchanged", () => {
  const value = fc.oneof(fc.string({ maxLength: 6 }), fc.string({ unit: fc.constantFrom(" ", "\t"), minLength: 1, maxLength: 3 }), fc.integer(), fc.boolean(), fc.constant(null), fc.constant([]), fc.constant({}));
  const input = fc.dictionary(fc.constantFrom("command", "timeout", "flag", "some_name"), value, { minKeys: 1, maxKeys: 4 });
  // Each non-code piece divided at the given cut points (in characters), each part keeping the piece's ref.
  const redivide = (blocks: readonly Block[], cuts: readonly number[]): readonly Block[] => {
    let k = 0;
    return mapPieces(blocks, (ps) =>
      ps.flatMap((p) => {
        if (p.code || p.text.length < 2) return [p];
        const cut = 1 + (cuts[k++ % cuts.length] % (p.text.length - 1));
        return [{ ...p, text: p.text.slice(0, cut) }, { ...p, text: p.text.slice(cut) }];
      }),
    );
  };
  fc.assert(
    fc.property(input, fc.array(fc.nat(), { minLength: 1, maxLength: 5 }), fc.boolean(), (tool, cuts, withRef) => {
      const request = permissionRequest("FutureTool", tool);
      // A piece that refers to an explanation joins the run like a plain piece.
      const base = withRef ? mapPieces(request.details, (ps) => ps.map((p) => (!p.code && p.text.length > 0 ? { ...p, ref: "t" } : p))) : request.details;
      return JSON.stringify(valueTokensOf(redivide(base, cuts))) === JSON.stringify(valueTokensOf(request.details));
    }),
    { numRuns: 300 },
  );
});

// ---- W3-R1-1 (S29): a value of several lines is never a code piece ----------------------------------------------------


test("W3-R1-1: a code block turned into a code piece of the same text is rejected, citing the one-line clause", () => {
  const request = permissionRequest("Bash", { command: "printf a\nprintf b" });
  assert.deepEqual(valueTokensOf(request.details), [{ kind: "block", text: "printf a\nprintf b", ref: "" }], "a code block is its own kind of value");
  const reply = faithful(request);
  const inline = { ...reply, details: blocksAsPieces(reply.details as readonly Block[]) };
  const result = contextValidation(request)(inline);
  assert.ok(Result.isFailure(result));
  assert.equal(result.failure.repair, repairOf({ kind: "multiLineCode", subject: "printf a\nprintf b" }, { kind: "literalChanged", subject: "" }));
  assert.ok(codeLineClause !== undefined && codeLineClause.kind === "data");
  assert.ok(result.failure.repair.includes(codeLineClause.text));
});

test("W3-R1-1: a code piece with a line break is a problem in any question; one of a single line is not", () => {
  const withLabel = (text: string): QuestionContext => ({ ...good, options: [{ label: [{ text, ref: "", code: true }], description: plain("Runs it.") }, good.options[1]] });
  const oneLine = contextValidation({ ...request, options: [{ label: [{ text: "npm ci", ref: "", code: true }], description: plain("Runs it.") }, request.options[1]] });
  assert.ok(Result.isSuccess(oneLine(withLabel("npm ci"))));
  const problems = questionProblems({ context: good.context, question: good.question, explanations: good.explanations, options: withLabel("a\nb").options, details: good.details });
  assert.deepEqual(problems, [{ kind: "multiLineCode", subject: "a\nb" }]);
  assert.deepEqual(questionProblems({ context: good.context, question: good.question, explanations: good.explanations, options: withLabel("a\r\nb").options }), [{ kind: "multiLineCode", subject: "a\r\nb" }]);
});

test("W3-R1-1 seam: the one-line clause is in the writer's format and is the rule the new problem's repair prompt quotes", () => {
  assert.ok(codeLineClause !== undefined);
  assert.equal(prompts.QUESTION_PROBLEM_RULE.multiLineCode, "codeLine");
  assert.ok(prompts.QUESTION_TEXT_FORMAT.includes(codeLineClause.text));
  assert.ok(repairOf({ kind: "multiLineCode", subject: "x\ny" }).includes(codeLineClause.text));
});

test("W3-R1-1 scenario (P4-R1-1): a reply that puts a two-line command in a code piece twice leaves Interloq's own code block", async () => {
  const draft = permissionDraft("Bash", { command: "printf a\nprintf b" });
  const req = permissionRequest("Bash", { command: "printf a\nprintf b" });
  const reply = faithful(req);
  const inline = { ...reply, details: blocksAsPieces(reply.details as readonly Block[]) };
  const { layer, probe } = initialized({ answers: ["n"], contexts: [{ output: inline }, { output: inline }] });
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* Store).init("the task");
      const ui = yield* Ui;
      return yield* askOffering((p) => ui.ask(p), prompts.permissionPrompt, draft);
    }).pipe(Effect.provide(layer)),
  );
  const problems = [...questionProblems({ ...inline }, []), { kind: "literalChanged" as const, subject: "" }];
  assert.equal(probe.planner.contextPrompts.length, 2, "one call and one repair turn");
  assert.equal(probe.planner.contextPrompts[1], repairOf(...problems));
  assert.ok(probe.planner.contextPrompts[1].includes(codeLineClause?.text ?? "missing"));
  const [q] = presentedQuestions(probe.ui);
  assert.equal(q.context.by, "program");
  assert.deepEqual(q.details, draft.details);
  assert.ok(q.details.some((b) => b.kind === "code" && b.text === "printf a\nprintf b"), "the command in a code block, its line break intact");
});

// ---- W4-R1-1, P5-R1-1 (S31): a supplied reference stays on its occurrence, in its part ------------------------------

const fooRequest = () => permissionRequest("Tool", { foo: "foo" });
/** The details with the ref of the name's piece `foo` handled by `f`, given the name's piece and the value's piece. */
const withFooRefs = (reply: QuestionContext, name: string, value: string): QuestionContext => ({
  ...reply,
  details: mapPieces(reply.details as readonly Block[], (ps) => {
    const codes = ps.filter((p) => p.code && p.text === "foo");
    return codes.length !== 2 ? ps : ps.map((p) => (p === codes[0] ? { ...p, ref: name } : p === codes[1] ? { ...p, ref: value } : p));
  }),
});
const suppliedFoo: Piece = { text: "foo", ref: "setting-1", code: true };

test("W4-R1-1: a supplied reference moved onto the value of the same text, or copied onto it, is rejected", () => {
  const request = fooRequest();
  const reply = faithful(request);
  assert.ok(Result.isSuccess(contextValidation(request)(reply)));
  assert.deepEqual(valueTokensOf(request.details), [
    { kind: "code", text: "foo", ref: "setting-1" },
    { kind: "code", text: "foo", ref: "" },
  ]);
  const moved = contextValidation(request)(withFooRefs(reply, "", "setting-1"));
  assert.ok(Result.isFailure(moved), "moved");
  assert.ok(moved.failure.repair.includes(prompts.KEEP_LITERALS));
  const copied = contextValidation(request)(withFooRefs(reply, "setting-1", "setting-1"));
  assert.ok(Result.isFailure(copied), "copied");
  assert.equal(copied.failure.repair, repairOf({ kind: "refOnCode", subject: "foo" }, { kind: "literalChanged", subject: "" }));
});

test("P5-R1-1: a supplied reference copied into an option, the question or the context, with the details unchanged, is rejected", () => {
  const request = fooRequest();
  const reply = faithful(request);
  const cases: Readonly<Record<string, QuestionContext>> = {
    "an option's description": { ...reply, options: reply.options.map((o, i) => (i === 0 ? { ...o, description: [...o.description, suppliedFoo] } : o)) },
    "an option's label": { ...reply, options: reply.options.map((o, i) => (i === 1 ? { ...o, label: [...o.label, suppliedFoo] } : o)) },
    "the question": { ...reply, question: [suppliedFoo, ...reply.question] },
    "the context": { ...reply, context: [...reply.context, { kind: "paragraph", pieces: [...plain("The setting "), suppliedFoo] }] },
  };
  for (const [where, changed] of Object.entries(cases)) {
    const result = contextValidation(request)(changed);
    assert.ok(Result.isFailure(result), where);
    assert.equal(result.failure.repair, repairOf({ kind: "refOnCode", subject: "foo" }), where);
  }
});

test("S31 seam: a reply built as KEEP_SUPPLIED_REFS says passes with its prose rephrased; the rule says the reference stays in its place", () => {
  const request = fooRequest();
  const prompt = prompts.contextPrompt("t", request);
  assert.ok(prompt.includes(prompts.KEEP_SUPPLIED_REFS));
  assert.match(prompts.KEEP_SUPPLIED_REFS, /in its place/);
  assert.match(prompts.KEEP_SUPPLIED_REFS, /any part of the question/);
  const reply = scriptedContextReply(prompt);
  const rephrased = { ...reply, details: mapPieces(reply.details as readonly Block[], (ps) => ps.map((p) => (!p.code && p.text.startsWith("The tool") ? { ...p, text: `Now: ${p.text}` } : p))) };
  assert.ok(JSON.stringify(rephrased) !== JSON.stringify(reply));
  assert.ok(Result.isSuccess(contextValidation(request)(rephrased)));
  const copied = contextValidation(request)({ ...reply, options: reply.options.map((o, i) => (i === 0 ? { ...o, description: [...o.description, suppliedFoo] } : o)) });
  assert.ok(Result.isFailure(copied));
  assert.ok(copied.failure.repair.includes(prompts.QUESTION_FORMAT.find((c) => c.id === "code")?.text ?? "?"));
});

test("property S31: a supplied reference moved, copied onto another code piece, or copied into another part is rejected", () => {
  const keys = ["alpha", "beta", "gamma"] as const;
  const value = fc.oneof(fc.constantFrom(...keys), fc.string({ minLength: 1, maxLength: 5 }), fc.integer());
  const input = fc.dictionary(fc.constantFrom(...keys), value, { minKeys: 1, maxKeys: 3 });
  fc.assert(
    fc.property(input, fc.nat(3), (tool, m) => {
      const request = permissionRequest("FutureTool", tool);
      const reply = faithful(request);
      const codes = blockPieces(reply.details as readonly Block[]).filter((p) => p.code);
      const named = codes.find((p) => p.ref !== "");
      if (named === undefined) return true;
      const other = codes.find((p) => p.ref === "" && p.text === named.text) ?? codes.find((p) => p.ref === "");
      const changed: QuestionContext | null =
        m === 0 && other !== undefined
          ? { ...reply, details: mapPieces(reply.details as readonly Block[], (ps) => ps.map((p) => (p === named ? { ...p, ref: "" } : p === other ? { ...p, ref: named.ref } : p))) }
          : m === 1 && other !== undefined
            ? { ...reply, details: mapPieces(reply.details as readonly Block[], (ps) => ps.map((p) => (p === other ? { ...p, ref: named.ref } : p))) }
            : m === 2
              ? { ...reply, options: reply.options.map((o, i) => (i === 0 ? { ...o, description: [...o.description, { ...named }] } : o)) }
              : m === 3
                ? { ...reply, question: [{ ...named }, ...reply.question] }
                : null;
      return Result.isSuccess(contextValidation(request)(reply)) && (changed === null || Result.isFailure(contextValidation(request)(changed)));
    }),
    { numRuns: 200 },
  );
});

test("W4-R1-1 scenario: a reply that moves the setting's reference onto its value twice leaves Interloq's own details", async () => {
  const draft = permissionDraft("Tool", { foo: "foo" });
  const reply = faithful(fooRequest());
  const moved = withFooRefs(reply, "", "setting-1");
  const { layer, probe } = initialized({ answers: ["n"], contexts: [{ output: moved }, { output: moved }] });
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* Store).init("the task");
      const ui = yield* Ui;
      return yield* askOffering((p) => ui.ask(p), prompts.permissionPrompt, draft);
    }).pipe(Effect.provide(layer)),
  );
  assert.equal(probe.planner.contextPrompts.length, 2, "one call and one repair turn");
  assert.equal(probe.planner.contextPrompts[1], repairOf({ kind: "literalChanged", subject: "" }));
  const [q] = presentedQuestions(probe.ui);
  assert.equal(q.context.by, "program");
  assert.deepEqual(q.details, draft.details);
  const foos = blockPieces(q.details as readonly Block[]).filter((p) => p.code && p.text === "foo");
  assert.deepEqual(foos.map((p) => p.ref), ["setting-1", ""], "the name carries the reference, the value none");
});

// ---- W4-R1-1 again (S32): a supplied reference cannot be dropped from one of two occurrences ------------------------

const twiceRequest = () => permissionRequest("Tool", { outer: { foo: 1 }, foo: 2 });
/** The reply with the ref of the n-th name piece `foo` dropped. */
const dropFoo = (reply: QuestionContext, n: number): QuestionContext => {
  let seen = -1;
  return { ...reply, details: mapPieces(reply.details as readonly Block[], (ps) => ps.map((p) => (p.code && p.text === "foo" && p.ref !== "" && ++seen === n ? { ...p, ref: "" } : p))) };
};

test("S32: a supplied reference dropped from either of two occurrences of one name is rejected; a reply keeping both passes", () => {
  const request = twiceRequest();
  const reply = faithful(request);
  assert.equal(blockPieces(request.details).filter((p) => p.code && p.text === "foo" && p.ref === "setting-2").length, 2);
  assert.ok(Result.isSuccess(contextValidation(request)(reply)));
  for (const n of [0, 1]) {
    const result = contextValidation(request)(dropFoo(reply, n));
    assert.ok(Result.isFailure(result), `occurrence ${n}`);
    assert.equal(result.failure.repair, repairOf({ kind: "literalChanged", subject: "" }, { kind: "suppliedRefDropped", subject: "foo" }), `occurrence ${n}`);
    assert.ok(result.failure.repair.includes(prompts.KEEP_SUPPLIED_REFS) && result.failure.repair.includes(prompts.KEEP_LITERALS));
  }
});

test("property S32: a supplied ref dropped from one occurrence of a name that appears twice is rejected", () => {
  const key = fc.constantFrom("alpha", "beta", "gamma");
  const value = fc.oneof(fc.integer(), fc.string({ minLength: 1, maxLength: 4 }));
  fc.assert(
    fc.property(key, value, value, fc.nat(1), (k, v1, v2, n) => {
      const request = permissionRequest("FutureTool", { outer: { [k]: v1 }, [k]: v2 });
      const reply = faithful(request);
      let seen = -1;
      const dropped = { ...reply, details: mapPieces(reply.details as readonly Block[], (ps) => ps.map((p) => (p.code && p.text === k && p.ref !== "" && ++seen === n ? { ...p, ref: "" } : p))) };
      return seen >= n && Result.isSuccess(contextValidation(request)(reply)) && Result.isFailure(contextValidation(request)(dropped));
    }),
    { numRuns: 200 },
  );
});

test("S32 scenario: a reply that drops one occurrence's reference twice leaves Interloq's own details, both names referring", async () => {
  const draft = permissionDraft("Tool", { outer: { foo: 1 }, foo: 2 });
  const dropped = dropFoo(faithful(twiceRequest()), 0);
  const { layer, probe } = initialized({ answers: ["n"], contexts: [{ output: dropped }, { output: dropped }] });
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* Store).init("the task");
      const ui = yield* Ui;
      return yield* askOffering((p) => ui.ask(p), prompts.permissionPrompt, draft);
    }).pipe(Effect.provide(layer)),
  );
  assert.equal(probe.planner.contextPrompts.length, 2, "one call and one repair turn");
  assert.equal(probe.planner.contextPrompts[1], repairOf({ kind: "literalChanged", subject: "" }, { kind: "suppliedRefDropped", subject: "foo" }));
  const [q] = presentedQuestions(probe.ui);
  assert.equal(q.context.by, "program");
  assert.deepEqual(q.details, draft.details);
  assert.deepEqual(blockPieces(q.details as readonly Block[]).filter((p) => p.code && p.text === "foo").map((p) => p.ref), ["setting-2", "setting-2"]);
});

// ---- W5-R1-1, P6-R1-1 to P6-R1-3 (S33): two code pieces never stand next to each other -------------------------------

const code = (text: string): Piece => ({ text, ref: "", code: true });
const codeAdjacentClause = prompts.QUESTION_FORMAT.find((c) => c.id === "codeAdjacent");
const withLabelPieces = (label: readonly Piece[]): QuestionContext => ({ ...good, options: [{ label, description: plain("Runs them.") }, good.options[1]] });
const problemKinds = (q: QuestionContext) => questionProblems({ context: q.context, question: q.question, explanations: q.explanations, options: q.options, details: q.details }).map((p) => p.kind);

test("S33: two adjacent code pieces, or two with only an empty piece between them, are adjacentCode; a space or an empty code piece separates them", () => {
  assert.deepEqual(problemKinds(withLabelPieces([code("a"), code("b")])), ["adjacentCode"]);
  assert.deepEqual(problemKinds(withLabelPieces([code("a"), ...[{ text: "", ref: "", code: false }], code("b")])), ["adjacentCode"]);
  assert.deepEqual(problemKinds(withLabelPieces([code("a"), ...plain(" "), code("b")])), []);
  assert.deepEqual(problemKinds(withLabelPieces([code("a"), code(""), code("b")])), []);
  // Two sequences are never joined: a code piece ending one paragraph and one starting the next are not adjacent.
  assert.deepEqual(problemKinds({ ...good, context: [...good.context, { kind: "paragraph", pieces: [code("a")] }, { kind: "paragraph", pieces: [code("b")] }] }), []);
});

test("S33 seam: the clause is in the writer's format, and the repair prompt of adjacentCode quotes it", () => {
  assert.ok(codeAdjacentClause !== undefined && codeAdjacentClause.kind === "data");
  assert.equal(prompts.QUESTION_PROBLEM_RULE.adjacentCode, "codeAdjacent");
  assert.ok(prompts.QUESTION_TEXT_FORMAT.includes(codeAdjacentClause.text));
  const reply = withLabelPieces([code("a"), code("b")]);
  const result = contextValidation({ ...request, options: [{ label: [code("a"), ...plain(" "), code("b")], description: plain("Runs them.") }, request.options[1]] })(reply);
  assert.ok(Result.isFailure(result));
  assert.ok(result.failure.repair.includes(codeAdjacentClause.text));
});

test("S33 scenario (P6-R1-3): a reply whose option label is two adjacent code pieces, twice, leaves Interloq's own options", async () => {
  const draft = permissionDraft("Bash", { command: "ls" });
  const reply = faithful(permissionRequest("Bash", { command: "ls" }));
  const adjacent: QuestionContext = { ...reply, options: reply.options.map((o, i) => (i === 0 ? { ...o, label: [code("a"), code("b")] } : o)) };
  const { layer, probe } = initialized({ answers: ["n"], contexts: [{ output: adjacent }, { output: adjacent }] });
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* Store).init("the task");
      const ui = yield* Ui;
      return yield* askOffering((p) => ui.ask(p), prompts.permissionPrompt, draft);
    }).pipe(Effect.provide(layer)),
  );
  assert.equal(probe.planner.contextPrompts.length, 2, "one call and one repair turn");
  assert.equal(probe.planner.contextPrompts[1], repairOf({ kind: "adjacentCode", subject: "b" }));
  assert.ok(probe.planner.contextPrompts[1].includes(codeAdjacentClause?.text ?? "missing"));
  const [q] = presentedQuestions(probe.ui);
  assert.equal(q.context.by, "program");
  assert.deepEqual(q.options.map((o) => o.label), draft.options.map((o) => o.shown.label));
});

// ---- W7-R1-1 (S36): a code piece of spaces alone is written without padding ----------------------------------------

test("W7-R1-1 scenario (P8-R1-1): a plan writer's option label with a code piece of one space reaches conversation.md unpadded", async () => {
  const asked = {
    context: para("Interloq, the orchestrator, writes the list file now, so that its entries can be read apart."),
    question: plain("Which separator do you want between the entries?"),
    explanations: [],
    options: [{ label: [...plain("Separate with "), { text: " ", ref: "", code: true }], description: plain("one character") }, opt("Separate with a comma", "one character")],
  };
  assert.deepEqual(questionProblems(asked), []);
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1"],
    steps: [{ output: { questions_for_user: [asked] }, plan: "v1" }, { output: { questions_for_user: [] }, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(layer);
  const record = conversation(probe.dir);
  assert.ok(record.includes("Separate with ` `"), record);
  assert.ok(!record.includes("`   `"), record);
});

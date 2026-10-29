import type { WorkExecution } from "../src/prompts.ts";
import assert from "node:assert/strict";
import { marked } from "marked";
import { type PresentedQuestion, type ShownExplanation, shownExplanations } from "../src/question.ts";
import { programWritten } from "../src/questionContext.ts";
import { CONTEXT_REQUEST_HEADING, confirmEndText, itemReturnedLine, LIST_DONE_SENTENCE, permissionPrompt, recordSubject } from "../src/prompts.ts";
import { promptOf } from "../src/userPrompts.ts";
import { type Block, type Explanation, type Piece, type PieceOption, piecesText, plainBlocks, plainOption, plainPieces } from "../src/pieces.ts";
import { askOffering, permissionDraft } from "../src/offer.ts";
import type { UiEvent } from "../src/uiEvents.ts";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after } from "node:test";
import { Cause, Clock, Duration, Effect, Exit, FileSystem, Layer, Option, PlatformError, Result } from "effect";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import type { Schema } from "effect";
import type { RunError } from "../src/errors.ts";
import type { LimitReset } from "../src/limitReset.ts";
import type { ClaudeFailure } from "../src/transport.ts";
import { callFailure } from "../src/claude.ts";
import { AgentUnreachable, ClaudeCallFailed, ClaudeSessionTooLong, NoTracker, describe, TransportFault, UsageLimited, UserStopped } from "../src/errors.ts";
import { endingOf, parseAskLine, parseConfirmEnd, parseMessage } from "../src/input.ts";
import { type RunStart, type Task, taskOf, type Wiring } from "../src/program.ts";
import { pathOf, type RunRoot, runRootOf, type SubjectId } from "../src/artifacts.ts";
import { type FakeItem, type FakeTracker, makeFakeTracker } from "./fakeTracker.ts";
import { itemIdOf, type ItemId, type ItemUrl, itemUrlOf } from "../src/tracker.ts";
import type { RunMode } from "../src/runMode.ts";
import { refinementRun, run } from "../src/run.ts";
import * as S from "../src/schema.ts";
import type { MarkedDisposition, Plan as SPlan, RecordedPlan, StepStatus, TermsMode } from "../src/schema.ts";
import { TASK_DISPUTE_FIELD } from "../src/schema.ts";
import type { StartRequest } from "../src/protocol.ts";
import type { SuiteResult } from "../src/suite.ts";
import { type Decider, type DeciderShape, Planner, type PlannerShape, type PlanningCapability, type PlanningPurpose, Reviewer, type ReviewerShape, type ReviewReply, type ReviewSession, RunConfig, RunKind, type Services, type StepReply, type StepReporter, Store, type StoreShape, SuiteRunner, type SuiteRunnerShape, Tracker, Ui, type UiShape } from "../src/services.ts";
import { type Platform, platformLayer } from "../src/platform.ts";
import { makeStore, storeLayer } from "../src/store.ts";
import { type DeciderDeps, deciderLayer } from "../src/decision.ts";
import { FakeSdk } from "./fakeSdk.ts";

type Config = typeof S.Config.Type;
type ExecOutcome = typeof S.ExecOutcome.Type;
type ExecCallOutcome = S.ExecCallOutcome;
type PlannerResponse = typeof S.PlannerResponse.Type;
type Review = typeof S.Review.Type;
type LogEntry = typeof S.LogEntry.Type;
const { defaultConfig } = S;

/** The records root of every run of testLayer, and of a store a test makes itself (issue #120). */
export const TEST_ROOT: RunRoot = runRootOf("implementation", "1", "2026-01-01T00:00:00.000Z");
/** An earlier implementation run of the scripted item 1, whose plan a run may take (issue #180). */
export const EARLIER_ROOT: RunRoot = runRootOf("implementation", "1", "2025-12-31T00:00:00.000Z");
/** The records directories of the runs of the program in a project, oldest first (issue #120: one per run, under plan-review/runs/). */
export const runDirsOf = (repo: string): readonly string[] => {
  const runs = path.join(path.resolve(repo), "plan-review", "runs");
  return fs.existsSync(runs) ? fs.readdirSync(runs).sort().map((name) => path.join(runs, name)) : [];
};
/** The records directory of the latest run of the program in a project. */
export const runDirOf = (repo: string): string => runDirsOf(repo).at(-1) ?? assert.fail(`no run's records directory in ${repo}`);
/** The paths a scripted agent writes to: the project, and the run's records directory, read when it is needed (testWiring learns it from the run's store). */
export type Paths = { readonly project: string; readonly records: () => string };
export const pathsOf = (repo: string, records: () => string = () => path.join(path.resolve(repo), "plan-review", TEST_ROOT)): Paths => ({ project: path.resolve(repo), records });
const planOf = (paths: Paths): string => path.join(paths.records(), "plan.md");
const planFileOf = (paths: Paths): string => path.join(paths.records(), "plan.json");

/** The plan a scripted step stands for (issue #6, F1): one stage with one step S1 whose text is the step's `plan`. */
export const scriptedPlan = (text: string): SPlan => ({ stages: [{ number: 1, title: "Plan", steps: [{ id: "S1", number: 1, label: "Step", text }] }] });
/** That plan as plan.json records it, every step with `status`. */
export const scriptedRecordedPlan = (text: string, status: StepStatus = "pending"): RecordedPlan => ({ stages: scriptedPlan(text).stages.map((st) => ({ ...st, steps: st.steps.map((x) => ({ ...x, status })) })) });
/** Whether a planning call's schema carries the plan (the plan write and the response to a plan review). */
const carriesPlan = (schema: Schema.Top): boolean => schema === S.PlanWrite || schema === S.PlanResponse || schema === S.PlanOnly;

/** Every temporary directory a test file created; removed when the file's tests are done. */
const tempDirs: string[] = [];
export const tempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** The scripted execution's commit of its change to a.txt (issue #176): a.txt alone, so a test's other files stay as it left them. */
const commitScriptedWork = (project: string): void => {
  execFileSync("git", ["-C", project, "add", "--", "a.txt"]);
  execFileSync("git", ["-C", project, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "scripted work", "--", "a.txt"]);
};

export function tempRepo(): string {
  const dir = tempDir("pr-test-");
  const git = (...args: string[]): void => void execFileSync("git", ["-C", dir, ...args]);
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  git("add", "a.txt");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
}

/** One scripted answer: the text the user types, or a step that never completes (for interruption tests). */
export type ScriptedAnswer = string | { readonly wait: true } | { readonly text: string; readonly before: () => void } | { readonly text: string; /** Issue #184: the answer is given once this promise resolves. */ readonly when: () => Promise<void> };

/** A promise that resolves when `signal` is next called; for tests that wait for a double to be reached. */
const readiness = (): { wait: () => Promise<void>; signal: () => void } => {
  let waiters: (() => void)[] = [];
  return {
    wait: () => new Promise((resolve) => waiters.push(resolve)),
    signal: () => {
      const current = waiters;
      waiters = [];
      for (const resolve of current) resolve();
    },
  };
};

export class ScriptedUi implements UiShape {
  readonly said: string[] = [];
  readonly asked: string[] = [];
  readonly notified: UiEvent[] = [];
  /** The presentations and asks in the order they happened (S7): "presented <n>" and "ask". */
  readonly order: string[] = [];
  private questions = 0;
  private readonly answers: ScriptedAnswer[];
  private readonly asks = readiness();
  /** `confirmEnds`: an answer that ends the run is confirmed first, as the page's dialog confirms it (S24, S25): the next scripted answer replies to the confirmation. */
  private readonly confirmEnds: boolean;
  constructor(answers: readonly ScriptedAnswer[], confirmEnds = false) {
    this.answers = [...answers];
    this.confirmEnds = confirmEnds;
  }
  /** Resolves when the next prompt is asked. */
  nextAsk(): Promise<void> {
    return this.asks.wait();
  }
  notify(event: UiEvent): Effect.Effect<void> {
    return Effect.sync(() => {
      this.notified.push(event);
      if (event._tag === "QuestionPresented") this.order.push(`presented ${event.question.number}`);
    });
  }
  say(text: string): Effect.Effect<void> {
    return Effect.sync(() => void this.said.push(text));
  }
  get nextQuestion(): Effect.Effect<number> {
    return Effect.sync(() => ++this.questions);
  }
  /** The commands of src/input.ts, which the page sends: "q" ends the run at a one-line prompt. */
  ask(prompt: string): Effect.Effect<string, UserStopped> {
    return this.take(prompt, "ask", (text) => {
      const parsed = parseAskLine(text);
      return parsed.kind === "quit" ? Effect.fail(new UserStopped({ where: prompt })) : Effect.succeed(parsed.text);
    });
  }
  /** "/quit" ends the run in a message; "q" is a message like any other. */
  askMessage(prompt: string): Effect.Effect<string, UserStopped> {
    return this.take(prompt, "message", (text) => {
      const parsed = parseMessage(text);
      return parsed.kind === "quit" ? Effect.fail(new UserStopped({ where: prompt })) : Effect.succeed(parsed.text);
    });
  }
  private take(prompt: string, mode: "ask" | "message", interpret: (text: string) => Effect.Effect<string, UserStopped>): Effect.Effect<string, UserStopped> {
    return (this.confirmEnds ? this.confirming(prompt, mode) : this.raw(prompt)).pipe(Effect.flatMap(interpret));
  }
  /** An answer that ends the run (endingOf) is returned only after a confirming reply (y); any other reply asks the question again. */
  private confirming(prompt: string, mode: "ask" | "message"): Effect.Effect<string> {
    return this.raw(prompt).pipe(
      Effect.flatMap((text) => {
        const ending = endingOf(promptOf(prompt).kind, mode, text);
        if (ending === null) return Effect.succeed(text);
        return this.raw(confirmEndText(ending)).pipe(Effect.flatMap((reply) => (parseConfirmEnd(reply) ? Effect.succeed(text) : this.confirming(prompt, mode))));
      }),
    );
  }
  private raw(prompt: string): Effect.Effect<string> {
    return Effect.suspend(() => {
      this.asked.push(prompt);
      this.order.push("ask");
      this.asks.signal();
      const answer = this.answers.shift();
      if (answer === undefined) return Effect.die(new Error(`no scripted answer for: ${prompt}`));
      if (typeof answer === "string") return Effect.succeed(answer);
      if ("wait" in answer) return Effect.never;
      if ("when" in answer) {
        const when = answer.when;
        return Effect.callback<string>((resume) => void when().then(() => resume(Effect.succeed(answer.text))));
      }
      answer.before();
      return Effect.succeed(answer.text);
    });
  }
}

/** The questions presented to the user, in order, each time it is presented (S5). */
export const presentedQuestions = (ui: ScriptedUi): PresentedQuestion[] => ui.notified.flatMap((e) => (e._tag === "QuestionPresented" ? [e.question] : []));
/** What each presented question is about, as its decision is recorded (S7): the subject of user-decisions.md, then the question. */
export const presentedSubjects = (ui: ScriptedUi): string[] => presentedQuestions(ui).map((q) => `${recordSubject(q.origin, piecesText(q.question))} | ${piecesText(q.question)}`);
/** The words of a presented question's text, its context, its details and its options' labels (issue #36: pieces). */
export const questionText = (q: PresentedQuestion): string => piecesText(q.question);
export const contextText = (q: PresentedQuestion): string => q.context.blocks.map((b) => (b.kind === "paragraph" ? piecesText(b.pieces) : b.kind === "list" ? b.items.map((i) => piecesText(i.pieces)).join("\n") : b.kind === "code" ? b.text : b.markdown)).join("\n\n");
export const detailsText = (q: PresentedQuestion): string => (q.attached?.blocks ?? []).map((b) => (b.kind === "paragraph" ? piecesText(b.pieces) : b.kind === "list" ? b.items.map((i) => piecesText(i.pieces)).join("\n") : b.kind === "code" ? b.text : b.markdown)).join("\n\n");
export const optionLabels = (q: PresentedQuestion): string[] => q.options.map((o) => piecesText(o.label));

// ---- a question's text as pieces (issue #36): builders for the tests ------------------------------------------------

/** Plain pieces of a text; a paragraph of it; an option of plain pieces. */
export const plain = (text: string): readonly Piece[] => plainPieces(text);
export const para = (...texts: readonly string[]): readonly Block[] => plainBlocks(...texts);
export const opt = (label: string, description = ""): PieceOption => plainOption(label, description);
/** A piece that refers to an explanation. */
export const term = (text: string, ref: string): Piece => ({ text, ref, code: false });
/** A question for the user (UserQuestion) of plain words, with its options and, optionally, pieces and explanations of its own. */
export const userQuestion = (
  question: string | readonly Piece[],
  options: readonly (string | readonly [string, string])[] = [],
  extra: Partial<Readonly<{ context: readonly Block[]; history: readonly Block[]; explanations: readonly Explanation[] }>> = {},
): S.UserQuestion => ({
  context: extra.context ?? para("Interloq, the orchestrator, asks this question on behalf of the run."),
  history: extra.history ?? [],
  question: typeof question === "string" ? plain(question) : question,
  explanations: extra.explanations ?? [],
  options: options.map((o) => (typeof o === "string" ? opt(o, "") : opt(o[0], o[1]))),
});
/** Legacy-shaped words of a question, as the tests write them: strings, and terms bound to their words in the text. */
type Words = Readonly<{ context: string; terms?: readonly Readonly<{ term: string; explanation: string }>[]; options: readonly Readonly<{ label: string; description: string }>[] }>;
/** A text as pieces, each occurrence of a term's words a piece that refers to that term's explanation (t1, t2, …). */
const withTerms = (text: string, terms: readonly Readonly<{ term: string; explanation: string }>[]): readonly Piece[] => {
  if (terms.length === 0 || text === "") return plain(text);
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${terms.map((t) => escape(t.term)).join("|")})`, "u"));
  return parts.flatMap((part) => {
    const i = terms.findIndex((t) => t.term === part);
    return i >= 0 ? [term(part, `t${i + 1}`)] : plain(part);
  });
};
const explanationsOf = (terms: readonly Readonly<{ term: string; explanation: string }>[], used: readonly Piece[]): readonly Explanation[] =>
  terms.map((t, i) => ({ id: `t${i + 1}`, term: t.term, senses: [t.explanation] })).filter((e) => used.some((p) => p.ref === e.id));
const piecesOfWords = (w: Words, text: string) => {
  const terms = w.terms ?? [];
  const context = withTerms(w.context, terms);
  const question = withTerms(text, terms);
  const options = w.options.map((o) => ({ label: withTerms(o.label, terms), description: withTerms(o.description, terms) }));
  const used = [...context, ...question, ...options.flatMap((o) => [...o.label, ...o.description])];
  return { context: context.length === 0 ? [] : [{ kind: "paragraph" as const, pieces: context }], history: [], question, options, explanations: explanationsOf(terms, used) };
};
/** A question for the user (UserQuestion) from words written as strings; each term's words become pieces that refer to it. */
export const questionOf = (w: Words & Readonly<{ question: string }>): S.UserQuestion => piecesOfWords(w, w.question);
/** An interview turn's current question from words written as strings. */
export const currentOf = (w: Words & Readonly<{ id: string; text: string }>): S.InterviewTurn["current_question"] => {
  const { question, ...rest } = piecesOfWords(w, w.text);
  return { id: w.id, ...rest, text: question };
};
/** Issue #184: a reply of the first interview that acknowledges, with a message and anything else it carries. */
export const ack = (message = "", extra: Partial<S.InterviewReply> = {}): S.InterviewReply => ({ message_to_user: message, follow_ups: [], unnecessary: [], complete: false, summary: "", ...extra });
/** Issue #184: a follow-up question of a reply, from words written as strings. */
export const followUpOf = (id: string, question: string, answers: readonly string[]): S.InterviewReply["follow_ups"][number] => {
  const { question: text, ...rest } = piecesOfWords({ context: `Context of ${id}.`, options: answers.map((a) => ({ label: a, description: "" })) }, question);
  return { id, ...rest, text };
};
/** Issue #184: a closing reply that proposes the summary. */
export const summaryReply = (summary: string, message = "Here is the summary."): S.InterviewReply => ack(message, { complete: true, summary });
/** An agreed question-list entry from words written as strings. */
export const entryOf = (w: Readonly<{ id: string; context: string; question: string; reason: string; proposed_answers: readonly Readonly<{ label: string; description: string }>[]; default_answer: string }>): S.QuestionEntry => ({
  id: w.id,
  context: para(w.context),
  history: [],
  question: plain(w.question),
  reason: para(w.reason),
  proposed_answers: w.proposed_answers.map((a) => opt(a.label, a.description)),
  default_answer: w.default_answer,
  skip_if: null,
});
/** An agreed question-list entry of plain words. */
export const questionEntry = (id: string, question: string, answers: readonly (readonly [string, string])[] = [], extra: Partial<Readonly<{ context: string; history: string; reason: string; default_answer: string; skip_if: S.SkipCondition | null }>> = {}): S.QuestionEntry => ({
  id,
  context: para(extra.context ?? `Context of ${id}.`),
  history: extra.history === undefined ? [] : para(extra.history),
  question: plain(question),
  reason: para(extra.reason ?? "r"),
  proposed_answers: answers.map(([l, d]) => opt(l, d)),
  default_answer: extra.default_answer ?? answers[0]?.[0] ?? "",
  skip_if: extra.skip_if ?? null,
});

/** `hang` makes the call wait until it is interrupted, recording the abort signal it was given. */
/** `onCall` runs when the call begins, before anything else (a test captures the state the call finds). */
/**
 * `editRecord` writes a file under plan-review/ during the call, as an agent that bypassed the hook could (stage A's
 * detection tests); `usage` appends a line to usage.jsonl during the call, as the adapter does.
 */
/** `fault` fails the call with a TransportFault of that message after its other effects (issue #26). */
/**
 * `limit` fails the call with UsageLimited, a usage limit with its reset as far as it is known, after its other effects
 * (issues #68 and #170);
 * `callFailed` fails it with ClaudeCallFailed, as the adapter fails a usage limit without one; `sessionTooLong` fails it
 * with ClaudeSessionTooLong, as the adapter fails a request refused because its session is too long (issue #122).
 */
export type PlanningStep = { /** Issue #193: fails the call with a defect, `Effect.die(new Error(defect))`, an error of Interloq that is not a typed error. */ defect?: string; /** Issue #170: fails the call by the adapter's own mapping, callFailure of src/claude.ts, from these facts. */ failure?: Readonly<{ message: string; facts: ClaudeFailure }>; fault?: string; sessionTooLong?: string; limit?: Readonly<{ reset: LimitReset; limitType: string | null }>; callFailed?: string; output?: unknown; /** The text of the plan's one step (issue #6): a call whose schema carries the plan returns it as data. */ plan?: string; touchProject?: boolean; hang?: boolean; resultText?: string; onCall?: () => void; editRecord?: { file: string; content: string | null }; usage?: boolean; /** Issue #184: the call waits for this promise (interruptibly) before it returns its output or failure. */ gate?: () => Promise<void> };

/** What one scripted execution does besides its outcome (issue #6): report_step calls, and hooks around them. */
/** `unreachable` fails the call with AgentUnreachable after its reports, as the adapter does when the user stops at the exhaustion pause (issue #26). */
/** `permission`: a permission request the call makes before its reports, asked as the adapter asks it (S49); the answer is recorded in `permissionAnswers`. */
/** `usage` appends a Claude Code line to usage.jsonl with the session the execution ran on, as the adapter does (issue #117). */
/** `sessionTooLong` fails the call with ClaudeSessionTooLong after its reports, as the adapter does (issue #122). */
/** `uncommitted` leaves the execution's change to a.txt uncommitted; by default it commits it, as the plan's last step does (issue #176). */
export type ExecScript = { uncommitted?: boolean; usage?: boolean; sessionTooLong?: string; reports?: readonly (readonly [string, "started" | "done"])[]; onCall?: () => void; after?: () => void; hang?: boolean; unreachable?: boolean; permission?: Readonly<{ tool: string; input: Record<string, unknown> }> };

/** The paragraph of a context call's reply that a test does not script (S9): it keeps the rules. */
export const SCRIPTED_CONTEXT = { context: "Interloq, the orchestrator, asks this question on behalf of the run." };
/**
 * The reply of a context call that a test does not script (S9, G-R1-1): the scripted paragraph, and the question, the
 * options, the details and the explanations as the prompt gives them, unchanged.
 */
export const scriptedContextReply = (prompt: string): S.QuestionContext => {
  // Issue #181 (P2-R1-1): the request carries the draft's history, which a reply that does what its prompt says keeps.
  const data = JSON.parse(prompt.slice(prompt.indexOf(CONTEXT_REQUEST_HEADING) + CONTEXT_REQUEST_HEADING.length)) as Omit<S.QuestionContext, "context" | "history"> & { history?: S.QuestionContext["history"] };
  return { context: para(SCRIPTED_CONTEXT.context), history: data.history ?? [], question: data.question, options: data.options, details: data.details, explanations: data.explanations };
};

export class ScriptedPlanner implements PlannerShape {
  readonly prompts: string[] = [];
  /** The Effect schema of each planning call, in order. */
  readonly schemas: Schema.Top[] = [];
  /** The capability of each planning call, in order. */
  readonly capabilities: PlanningCapability[] = [];
  /** The abort signals of the calls that hang. */
  readonly hangSignals: AbortSignal[] = [];
  private readonly hangs = readiness();
  /** Resolves when the next hanging call begins. */
  nextHang(): Promise<void> {
    return this.hangs.wait();
  }
  private readonly state: Paths;
  private readonly steps: PlanningStep[];
  private readonly execs: ExecCallOutcome[];
  private readonly execScripts: ExecScript[];
  constructor(state: Paths, steps: PlanningStep[], execs: ExecCallOutcome[], execScripts: readonly ExecScript[] = []) {
    this.state = state;
    this.steps = [...steps];
    this.execs = [...execs];
    this.execScripts = [...execScripts];
  }
  /** The prompts and the scripted replies of the calls about the terms (S17), apart from the others. */
  readonly termsPrompts: string[] = [];
  terms: PlanningStep[] = [];
  /** The prompts of the context calls (S9), apart from `prompts` so that the scripts of the other calls keep their order. */
  readonly contextPrompts: string[] = [];
  /** The capability of each context call (S33). */
  readonly contextCapabilities: PlanningCapability[] = [];
  /** The scripted replies of the context calls, in order; without one, a context call returns SCRIPTED_CONTEXT. */
  contexts: PlanningStep[] = [];
  /**
   * Issue #117: the session a call runs on. The run's planner is `test-session`; each `fresh` returns a view of this planner
   * over a session of its own, `fresh-<n>`, which shares every script, record and setting with it (`root`).
   */
  readonly session: string = "test-session";
  private readonly root: ScriptedPlanner = this;
  readonly sessionId: Effect.Effect<string | null> = Effect.sync(() => this.session);
  /** How often a fresh session was started (a decision loop, a context call, an execution phase); the views share this script. */
  freshSessions = 0;
  readonly fresh: Effect.Effect<PlannerShape> = Effect.sync(() => {
    const root = this.root;
    root.freshSessions++;
    const session = `fresh-${root.freshSessions}`;
    return Object.create(root, { session: { value: session }, sessionId: { value: Effect.succeed(session) } }) as ScriptedPlanner;
  });
  /** The session each execution call ran on, in order (issue #117). */
  readonly execSessions: string[] = [];
  /** The prompt each execution call received, in order (issue #117). */
  readonly execPrompts: string[] = [];
  /** Every prompt sent on each session, planning and execution alike, in order (issue #117). */
  readonly history = new Map<string, string[]>();
  /** A usage line of a call on this planner's session, as the adapter writes it. */
  private recordUsage(): void {
    fs.appendFileSync(path.join(this.state.records(), "usage.jsonl"), JSON.stringify({ version: 2, agent: "claude", time: new Date(0).toISOString(), session: this.session, num_turns: 1, total_cost_usd: 0.1 }) + "\n");
  }
  private sent(prompt: string): void {
    const root = this.root;
    root.history.set(this.session, [...(root.history.get(this.session) ?? []), prompt]);
  }
  /** Returns the scripted output as it is: the caller decodes it, as with the real agent. */
  planning(prompt: string, schema: Schema.Top, purpose?: PlanningPurpose, capability: PlanningCapability = "records"): Effect.Effect<{ output: unknown; resultText: string; costUsd: number | null }, TransportFault | UsageLimited | ClaudeCallFailed | ClaudeSessionTooLong> {
    // S17: the explanations of the terms (their writing, their responses, their repairs) have their own script, and
    // without one no question needs a term.
    if (schema === S.TermsWrite || schema === S.TermsResponse) {
      return Effect.suspend(() => {
        this.sent(prompt);
        this.termsPrompts.push(prompt);
        const step = this.terms.shift();
        step?.onCall?.();
        const root = this.root;
        const callId = `scripted-${++root.callCount}`;
        const notify = (e: UiEvent) => (root.ui === null ? Effect.void : root.ui.notify(e));
        return notify({ _tag: "AgentCallStarted", agent: "claude", purpose: "planning", callId }).pipe(
          Effect.andThen(this.gated(step ?? {}, Effect.succeed({ output: step === undefined ? { entries: [] } : step.output, resultText: "", costUsd: 0.01 }))),
          Effect.onExit((exit) => notify({ _tag: "AgentCallEnded", agent: "claude", ok: Exit.isSuccess(exit), callId })),
        );
      });
    }
    // Issue #184: the first interview's replies have their own scripts: a closing request (one carrying
    // LIST_DONE_SENTENCE) takes from `closings`, which a test must script, and any other from `replies`, an empty
    // acknowledgment without one; how many requests there are depends on how answers were batched.
    if (schema === S.InterviewReply) {
      return Effect.suspend(() => {
        const root = this.root;
        this.sent(prompt);
        root.clarificationPrompts.push(prompt);
        const closing = prompt.includes(LIST_DONE_SENTENCE);
        const step = closing ? root.closings.shift() : root.replies.shift();
        if (closing && step === undefined) return Effect.die(new Error(`no scripted closing reply for: ${prompt.slice(0, 200)}`));
        const callId = `scripted-${++root.callCount}`;
        const notify = (e: UiEvent) => (root.ui === null ? Effect.void : root.ui.notify(e));
        return notify({ _tag: "AgentCallStarted", agent: "claude", purpose: "interview", callId }).pipe(
          Effect.andThen(this.gated(step ?? {}, Effect.suspend(() => this.outcome(step ?? { output: ack() }, schema)))),
          Effect.onExit((exit) => notify({ _tag: "AgentCallEnded", agent: "claude", ok: Exit.isSuccess(exit), callId })),
        );
      });
    }
    if (purpose === "context") {
      return Effect.suspend((): Effect.Effect<{ output: unknown; resultText: string; costUsd: number | null }, TransportFault | ClaudeSessionTooLong> => {
        this.sent(prompt);
        this.contextPrompts.push(prompt);
        this.contextCapabilities.push(capability);
        const step = this.contexts.shift();
        if (step?.editRecord !== undefined) fs.writeFileSync(path.join(this.state.records(), step.editRecord.file), step.editRecord.content ?? "");
        if (step?.fault !== undefined) return Effect.fail(new TransportFault({ agent: "claude", message: step.fault, status: null }));
        if (step?.sessionTooLong !== undefined) return Effect.fail(new ClaudeSessionTooLong({ message: step.sessionTooLong }));
        if (step?.touchProject) fs.appendFileSync(path.join(this.state.project, "a.txt"), "changed\n");
        return Effect.succeed({ output: step === undefined ? scriptedContextReply(prompt) : typeof step.output === "function" ? (step.output as (p: string) => unknown)(prompt) : step.output, resultText: "", costUsd: 0.01 });
      });
    }
    return Effect.suspend(() => {
      this.sent(prompt);
      this.prompts.push(prompt);
      this.schemas.push(schema);
      this.capabilities.push(capability);
      const step = this.steps.shift();
      if (!step) return Effect.die(new Error(`no scripted planning step for: ${prompt.slice(0, 60)}`));
      step.onCall?.();
      if (step.hang) {
        return Effect.callback((_resume, signal) => {
          this.hangSignals.push(signal);
          this.hangs.signal();
        });
      }
      if (step.touchProject) fs.appendFileSync(path.join(this.state.project, "a.txt"), "changed\n");
      const records = this.state.records();
      if (step.editRecord !== undefined) {
        const file = path.join(records, step.editRecord.file);
        if (step.editRecord.content === null) fs.rmSync(file, { force: true });
        else {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, step.editRecord.content);
        }
      }
      if (step.usage) this.recordUsage();
      if (step.fault !== undefined) return Effect.fail(new TransportFault({ agent: "claude", message: step.fault, status: null }));
      if (step.callFailed !== undefined) return Effect.fail(new ClaudeCallFailed({ message: step.callFailed }));
      if (step.defect !== undefined) return Effect.die(new Error(step.defect));
      if (step.sessionTooLong !== undefined) return Effect.fail(new ClaudeSessionTooLong({ message: step.sessionTooLong }));
      if (step.failure !== undefined) return Effect.fail(callFailure(step.failure.message, step.failure.facts));
      if (step.limit !== undefined) return Effect.fail(new UsageLimited({ agent: "claude", message: "You've hit your session limit", reset: step.limit.reset, limitType: step.limit.limitType }));
      return Effect.succeed({ output: this.withPlan(schema, step), resultText: step.resultText ?? "", costUsd: 0.1 });
    });
  }
  /** Issue #184: the scripted replies of the first interview, apart from `steps`, and the prompts they answered. */
  replies: PlanningStep[] = [];
  closings: PlanningStep[] = [];
  readonly clarificationPrompts: string[] = [];
  /** Issue #184: the Ui the interview's and the terms' calls notify their start and end to, with ids of this counter. */
  ui: UiShape | null = null;
  callCount = 0;
  /** A step's gate, waited for interruptibly before the call's outcome (issue #184). */
  private gated<A, E>(step: PlanningStep, then: Effect.Effect<A, E>): Effect.Effect<A, E> {
    const gate = step.gate;
    if (gate === undefined) return then;
    return Effect.callback<void>((resume) => void gate().then(() => resume(Effect.void))).pipe(Effect.andThen(then));
  }
  /** The outcome of a scripted step of the interview: its failure, or its output. */
  private outcome(step: PlanningStep, schema: Schema.Top): Effect.Effect<{ output: unknown; resultText: string; costUsd: number | null }, TransportFault | UsageLimited | ClaudeCallFailed | ClaudeSessionTooLong> {
    step.onCall?.();
    if (step.fault !== undefined) return Effect.fail(new TransportFault({ agent: "claude", message: step.fault, status: null }));
    if (step.callFailed !== undefined) return Effect.fail(new ClaudeCallFailed({ message: step.callFailed }));
    if (step.sessionTooLong !== undefined) return Effect.fail(new ClaudeSessionTooLong({ message: step.sessionTooLong }));
    if (step.failure !== undefined) return Effect.fail(callFailure(step.failure.message, step.failure.facts));
    if (step.limit !== undefined) return Effect.fail(new UsageLimited({ agent: "claude", message: "You've hit your session limit", reset: step.limit.reset, limitType: step.limit.limitType }));
    if (step.usage) this.recordUsage();
    return Effect.succeed({ output: this.withPlan(schema, step), resultText: step.resultText ?? "", costUsd: 0.1 });
  }
  /** The text of the last plan scripted, which a reply without `plan` returns unchanged (issue #6, F1). */
  private lastPlan: string | null = null;
  /**
   * A call whose schema carries the plan returns it as data (F1): `plan` scripts its one step's text, and without it the
   * last plan is returned unchanged, as an agent that leaves the plan as it is. An output that has `plan` keeps its own.
   */
  private withPlan(schema: Schema.Top, step: PlanningStep): unknown {
    if (step.plan !== undefined) this.root.lastPlan = step.plan;
    const output = withWorkEffects(step.output);
    // Issue #186: the run's first planning call replies a plan or the verdict under `reply`; a script written as a plan
    // write (a plan and an empty questions_for_user) is that plan, and a script with a question there is refused, since
    // the first plan asks none any more.
    if (schema === S.FirstPlanReply && output !== null && typeof output === "object" && !Array.isArray(output) && ("questions_for_user" in output || "plan" in output)) {
      const questions = (output as { questions_for_user?: readonly unknown[] }).questions_for_user ?? [];
      if (questions.length > 0) throw new Error("a first plan scripts questions_for_user: move the question into the response to the first plan review");
      const plan = "plan" in output ? output.plan : this.lastPlan === null ? undefined : scriptedPlan(this.lastPlan);
      return { reply: { kind: "plan", plan } };
    }
    if (!carriesPlan(schema) || output === null || typeof output !== "object" || Array.isArray(output) || "plan" in output || this.lastPlan === null) return output;
    return { ...output, plan: scriptedPlan(this.lastPlan) };
  }
  /** The replies of report_step to the scripted reports, in order (issue #6, Q2). */
  readonly stepReplies: StepReply[] = [];
  /**
   * An execution: the scripted reports of its ExecScript go to the phase's reporter in order, then `after` runs, then
   * the call hangs until interrupted when `hang` is set, or returns the scripted outcome.
   */
  /** The Ui an execution call reports its start and end to, as the adapter does; set by testWiring's agents layer. */
  callUi: UiShape | null = null;
  /** The run's Store, for a scripted permission request (S49). */
  callStore: StoreShape | null = null;
  readonly permissionAnswers: string[] = [];
  executing(prompt: string, reporter: StepReporter): Effect.Effect<ExecCallOutcome, RunError, Decider> {
    const script = this.execScripts.shift() ?? {};
    const self = this;
    const ui = this.callUi;
    const body = Effect.gen(function* () {
      self.sent(prompt);
      self.execSessions.push(self.session);
      self.execPrompts.push(prompt);
      script.onCall?.();
      if (script.usage) self.recordUsage();
      if (script.permission !== undefined && ui !== null && self.callStore !== null) {
        const draft = permissionDraft(script.permission.tool, script.permission.input);
        const answer = yield* askOffering((p) => ui.ask(p), permissionPrompt, draft).pipe(Effect.provideService(Ui, ui), Effect.provideService(Store, self.callStore));
        self.permissionAnswers.push(answer);
      }
      for (const [id, status] of script.reports ?? []) self.stepReplies.push(yield* reporter(id, status));
      script.after?.();
      if (script.hang) return yield* Effect.never;
      if (script.unreachable) return yield* Effect.fail(new AgentUnreachable({ agent: "claude", attempts: 4, lastFault: "read ECONNRESET" }));
      if (script.sessionTooLong !== undefined) return yield* Effect.fail(new ClaudeSessionTooLong({ message: script.sessionTooLong }));
      const outcome = self.execs.shift();
      if (!outcome) return yield* Effect.die(new Error("no scripted execution outcome"));
      fs.appendFileSync(path.join(self.state.project, "a.txt"), "implemented\n");
      // Issue #176: the run is finished only when its changes are committed, so the scripted work commits its own.
      if (!script.uncommitted) commitScriptedWork(self.state.project);
      return outcome;
    });
    if (ui === null) return body;
    return ui.notify({ _tag: "AgentCallStarted", agent: "claude", purpose: "execution", callId: "claude-exec" }).pipe(
      Effect.andThen(body),
      Effect.onExit((exit) => ui.notify({ _tag: "AgentCallEnded", agent: "claude", ok: Exit.isSuccess(exit), callId: "claude-exec" })),
    );
  }
}

/**
 * A scripted review. `plan` makes the reviewer change plan.json, the plan's reviewed file, during its turn, as Codex could.
 * `raw` replaces the reply text, for a reply that is not a review (or not JSON). `inputTokens` is the turn's input as
 * Codex would report it (issue #165), null without one.
 */
export type ReviewStep = Review & { inputTokens?: number; fault?: string; plan?: string; raw?: string; touchProject?: boolean; editRecord?: string; onCall?: () => void };

export class ScriptedReviewer implements ReviewerShape {
  phases = 0;
  readonly prompts: string[] = [];
  /** The phase number at each review call, so that a test can see that two calls shared a thread. */
  readonly callPhases: number[] = [];
  private readonly state: Paths;
  private readonly reviews: ReviewStep[];
  constructor(state: Paths, reviews: ReviewStep[]) {
    this.state = state;
    this.reviews = [...reviews];
  }
  /** Each start is a new "thread": the session remembers its phase number so that a test can see which calls shared one. */
  readonly startPhase: Effect.Effect<ReviewSession> = Effect.sync(() => {
    const phase = ++this.phases;
    return {
      /** Returns the reply text as Codex would: the caller decodes it. */
      review: (prompt: string): Effect.Effect<ReviewReply, TransportFault> =>
        Effect.sync(() => this.turn(prompt, phase)).pipe(
          Effect.flatMap((reply) => (reply.fault === null ? Effect.succeed({ text: reply.text, inputTokens: reply.inputTokens }) : Effect.fail(new TransportFault({ agent: "codex", message: reply.fault, status: null })))),
        ),
    };
  });
  /** One scripted turn: its effects on the files, then its reply text, or the fault it fails with. */
  /** The reviews of the terms (S17), apart from `reviews`; without one, a terms review raises no issue. */
  termsReviews: ReviewStep[] = [];
  private turn(prompt: string, phase: number): { text: string; inputTokens: number | null; fault: string | null } {
    this.prompts.push(prompt);
    this.callPhases.push(phase);
    const terms = prompt.includes(`/${pathOf({ kind: "terms" })}`);
    const step = terms ? (this.termsReviews.shift() ?? { issues: [] }) : this.reviews.shift();
    if (!step) throw new Error("no scripted review");
    step.onCall?.();
    if (step.plan !== undefined) fs.writeFileSync(planFileOf(this.state), step.plan);
    if (step.touchProject) fs.appendFileSync(path.join(this.state.project, "a.txt"), "codex\n");
    // A record under plan-review/ that the turn edits, as Codex could (the work review's changes.diff).
    if (step.editRecord !== undefined) fs.appendFileSync(path.join(this.state.records(), step.editRecord), "edited by the reviewer\n");
    return { text: step.raw ?? JSON.stringify({ issues: step.issues.map(withIssueEffect) }), inputTokens: step.inputTokens ?? null, fault: step.fault ?? null };
  }
}

/** A scripted issue; it states SCRIPTED_WORK_EFFECT (issue #183), which the plan's and the work's reviews require and every other drops. */
export const issue = (id: string, problem = "p"): Review["issues"][number] => ({ id, severity: "major", location: "s", problem, evidence: "e", [S.WORK_EFFECT_FIELD]: SCRIPTED_WORK_EFFECT }) as Review["issues"][number];

/**
 * The default statement of a scripted reply's effect on the work (issue #183): `differs`, which settles no dispute, so
 * every pause a test expects is still asked. The plan's and the work's schemas require the field; every other drops it.
 */
export const SCRIPTED_WORK_EFFECT = { kind: "differs", difference: "scripted" } as const;
/** A scripted issue given SCRIPTED_WORK_EFFECT where it states none: the plan's and the work's reviews require it, every other drops it. */
export const withIssueEffect = (i: Review["issues"][number]): Review["issues"][number] => (S.WORK_EFFECT_FIELD in i ? i : ({ ...i, [S.WORK_EFFECT_FIELD]: SCRIPTED_WORK_EFFECT } as Review["issues"][number]));
/** A scripted response with each disposition given SCRIPTED_WORK_EFFECT where it states none; any other output unchanged. */
export const withWorkEffects = (output: unknown): unknown => {
  if (output === null || typeof output !== "object" || Array.isArray(output) || !("dispositions" in output) || !Array.isArray(output.dispositions)) return output;
  return { ...output, dispositions: output.dispositions.map((d: unknown) => (d !== null && typeof d === "object" && !(S.WORK_EFFECT_FIELD in d) ? { ...d, [S.WORK_EFFECT_FIELD]: SCRIPTED_WORK_EFFECT } : d)) };
};
/**
 * A response with one disposition per tuple. Each carries Claude Code's mark (issue #156), the tuple's third element or
 * false, which the question list's and the terms' schemas require and every other subject's decode drops, and the
 * statement SCRIPTED_WORK_EFFECT (issue #183), which the plan's and the work's schemas require and every other drops.
 */
export const respond = (
  dispositions: [string, PlannerResponse["dispositions"][number]["action"], boolean?][],
  extra: Partial<PlannerResponse> = {},
): MarkedResponse => {
  const marked: readonly MarkedDisposition[] = dispositions.map(([id, action, mark]) => ({
    id,
    action,
    rationale: `rationale ${id}`,
    duplicate_of: "",
    reverses: "",
    [TASK_DISPUTE_FIELD]: mark ?? false,
    [S.WORK_EFFECT_FIELD]: SCRIPTED_WORK_EFFECT,
  }));
  return { self_corrections: [], reviewer_feedback: "", questions_for_user: [], ...extra, dispositions: extra.dispositions?.map((d) => ({ [TASK_DISPUTE_FIELD]: false, [S.WORK_EFFECT_FIELD]: SCRIPTED_WORK_EFFECT, ...d })) ?? marked };
};
/**
 * Dispositions as the plan's and the work's responses decode them: their schemas drop `task_dispute` (issue #156) and keep
 * the statement of the effect on the work (issue #183).
 */
export const unmarked = (dispositions: readonly S.Disposition[]): readonly S.Disposition[] =>
  dispositions.map((d) => {
    const { id, action, rationale, duplicate_of, reverses } = d;
    return S.WORK_EFFECT_FIELD in d ? { id, action, rationale, duplicate_of, reverses, [S.WORK_EFFECT_FIELD]: d[S.WORK_EFFECT_FIELD] } : { id, action, rationale, duplicate_of, reverses };
  });
/** A response whose dispositions carry the mark, which every subject's response accepts. */
export type MarkedResponse = Omit<PlannerResponse, "dispositions"> & Readonly<{ dispositions: readonly (MarkedDisposition & Partial<Pick<S.EffectDisposition, typeof S.WORK_EFFECT_FIELD>>)[] }>;

export const finished: ExecOutcome = { status: "finished", summary: "done", question: "", remainingWork: "", userInput: null, checks: [] };
/** The execution a work response is given (issue #117): a finished report and a plan text of its own. */
export const workExecution: WorkExecution = { outcome: finished, plan: "# Plan\n\n1. S1 (done): the scripted step\n" };

/**
 * Issue #162: the runner of the whole suite, scripted: each run takes the next result of its queue (Passed when it is
 * empty), and "hang" never completes, so a test can stop the run during it. Every run's command, directory and ceiling is kept.
 */
export class ScriptedSuite implements SuiteRunnerShape {
  readonly runs: Array<Readonly<{ command: string; cwd: string; ceilingMs: number }>> = [];
  readonly results: Array<SuiteResult | "hang">;
  constructor(results: ReadonlyArray<SuiteResult | "hang">) {
    this.results = [...results];
  }
  run(command: S.CommandLine, cwd: string, ceilingMs: number): Effect.Effect<SuiteResult> {
    return Effect.suspend(() => {
      this.runs.push({ command, cwd, ceilingMs });
      const next = this.results.shift() ?? { _tag: "Passed", output: "all passed\n", ms: 1 };
      return next === "hang" ? Effect.never : Effect.succeed(next);
    });
  }
}

/** `store` wraps the live store of the test layer (a test that changes the project between the agents' calls). */
export type TestOptions = { answers?: readonly ScriptedAnswer[]; steps?: PlanningStep[]; /** Issue #184: the first interview's replies, and its closing replies (the summary). */ replies?: PlanningStep[]; closings?: PlanningStep[]; /** The replies of the context calls (S9), in order. */ contexts?: PlanningStep[]; /** The replies of the calls about the terms and their reviews (S17). */ terms?: PlanningStep[]; termsReviews?: ReviewStep[]; /** The confirmation before an answer ends the run, as the page's dialog asks it (S24, S25). */ confirmEnds?: boolean; reviews?: ReviewStep[]; execs?: ExecCallOutcome[]; execScripts?: readonly ExecScript[]; config?: Partial<Config>; platform?: Layer.Layer<Platform>; store?: (store: StoreShape) => StoreShape; /** The project's tracker (issue #120): a fake, or null for none configured (NoTracker); by default a fake holding scriptedItem. */ tracker?: FakeTracker | null; /** The run's mode as testLayer provides it (issue #120; by default implementation), which the planning guard reads. */ mode?: RunMode; /** The whole suite's results, in order (issue #162). */ suite?: ReadonlyArray<SuiteResult | "hang"> };

/**
 * The live platform with a file system whose writes and renames can fail: `shouldFail(method, count)` is asked
 * before the count-th write or rename (1-based), and a true answer fails it with a PlatformError (step 5.4).
 */
export const faultyPlatform = (shouldFail: (method: "writeFile" | "rename", count: number) => boolean): Layer.Layer<Platform> => {
  let count = 0;
  const injected = (method: string) => new PlatformError.PlatformError(new PlatformError.SystemError({ _tag: "Unknown", module: "FileSystem", method, description: "injected write failure" }));
  const faulty = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const live = yield* FileSystem.FileSystem;
      const gate = <A>(method: "writeFile" | "rename", effect: Effect.Effect<A, PlatformError.PlatformError>): Effect.Effect<A, PlatformError.PlatformError> =>
        Effect.suspend(() => (shouldFail(method, ++count) ? Effect.fail(injected(method)) : effect));
      return FileSystem.make({ ...live, writeFile: (p, data, options) => gate("writeFile", live.writeFile(p, data, options)), rename: (from, to) => gate("rename", live.rename(from, to)) });
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer));
  return Layer.provideMerge(NodeChildProcessSpawner.layer, Layer.mergeAll(faulty, NodePath.layer));
};
/** What a test inspects after a run: the scripted implementations, the paths, and a reader of the logs on disk. */
export type Probe = {
  dir: string;
  plan: string;
  requirements: string;
  loadLog: (subject?: SubjectId) => Promise<readonly LogEntry[]>;
  ui: ScriptedUi;
  planner: ScriptedPlanner;
  reviewer: ScriptedReviewer;
  config: Config;
  /** The project's tracker of testLayer (issue #120). */
  tracker: FakeTracker;
  /** The whole suite's runner of testLayer (issue #162). */
  suite: ScriptedSuite;
};

/** The developer's format of the representation (docs/decision-making.md), as the program reads it. */
export const DECISION_FORMAT_TEXT = fs.readFileSync(new URL("../docs/decision-making.md", import.meta.url), "utf8");
/** A reporter for execution calls that expect no report_step call: a call is a defect. */
export const noReporter: StepReporter = (id) => Effect.die(new Error(`no report of a step was expected: ${id}`));
/** A Decider for tests that expect no decision: a call is a defect; a question's context is the program's own (S10). */
export const noDecider: DeciderShape = { at: () => noDecider, decide: () => Effect.die(new Error("no decision was expected")), explain: (request) => Effect.succeed(programWritten(request)) };
/** The services with the Decider built over them (decision support, D3), as src/program.ts builds it. */
export const withDecider = (layer: Layer.Layer<DeciderDeps>, task = "task"): Layer.Layer<Services> => Layer.provideMerge(deciderLayer(task, DECISION_FORMAT_TEXT), layer);

/** The layer of the six services with scripted agents and Ui over a temporary repository. */
export function testLayer(repo: string, options: TestOptions = {}): { layer: Layer.Layer<Services | Tracker | SuiteRunner>; probe: Probe } {
  const paths = pathsOf(repo);
  const config: Config = { ...defaultConfig, ...options.config };
  const ui = new ScriptedUi(options.answers ?? [], options.confirmEnds ?? false);
  const planner = new ScriptedPlanner(paths, options.steps ?? [], options.execs ?? [], options.execScripts ?? []);
  planner.contexts = [...(options.contexts ?? [])];
  planner.terms = [...(options.terms ?? [])];
  planner.replies = [...(options.replies ?? [])];
  planner.closings = [...(options.closings ?? [])];
  planner.ui = ui;
  const reviewer = new ScriptedReviewer(paths, options.reviews ?? []);
  reviewer.termsReviews = [...(options.termsReviews ?? [])];
  const wrap = options.store ?? ((s: StoreShape) => s);
  const store = Layer.effect(Store, makeStore(repo, TEST_ROOT, config.ignorePaths).pipe(Effect.map(wrap))).pipe(Layer.provide(options.platform ?? platformLayer));
  // Issue #120: the project's tracker, a fake holding the scripted item (unrefined, as a refinement run finds it).
  const tracker = options.tracker ?? fakeTrackerOf([{ ...scriptedItem, state: "unrefined" }]);
  const suite = new ScriptedSuite(options.suite ?? []);
  const layer = Layer.merge(withDecider(Layer.mergeAll(store, Layer.succeed(Ui, ui), Layer.succeed(Planner, planner), Layer.succeed(Reviewer, reviewer), Layer.succeed(RunConfig, config), Layer.succeed(RunKind, { mode: options.mode ?? "implementation" }))), Layer.merge(Layer.succeed(Tracker, tracker.tracker), Layer.succeed(SuiteRunner, suite)));
  const dir = paths.records();
  const loadLog = (subject: SubjectId = { plan: 1 }): Promise<readonly LogEntry[]> =>
    Effect.runPromise(makeStore(repo, TEST_ROOT, config.ignorePaths).pipe(Effect.flatMap((s) => s.loadLog(subject)), Effect.provide(platformLayer)));
  return { layer, probe: { dir, plan: planOf(paths), requirements: path.join(dir, "requirements.md"), loadLog, ui, planner, reviewer, config, tracker, suite } };
}

/**
 * The suite's runner where a layer provides none (issue #162): a run without a suite command never calls it, and the
 * layer's own runner, testLayer's, takes precedence where it provides one.
 */
const withSuite = <A, E>(effect: Effect.Effect<A, E, SuiteRunner>): Effect.Effect<A, E> => Effect.provideService(effect, SuiteRunner, new ScriptedSuite([]));
/** Runs the procedure against a layer and returns the number of execution phases. */
export const runTask = (layer: Layer.Layer<Services>, task = "task"): Promise<number> =>
  Effect.runPromise(withSuite(run(task).pipe(Effect.map((end) => (end._tag === "Finished" ? end.phases : 0)), Effect.provide(layer))));

/** Runs a refinement run of the scripted item (issue #120): the question phase, written back to the item. */
export const runRefinement = (layer: Layer.Layer<Services | Tracker>, task = "task", terms: TermsMode = "checked"): Promise<void> => Effect.runPromise(refinementRun(task, scriptedItem.id, terms).pipe(Effect.provide(layer)));
/** Runs a refinement run and asserts that it fails with the given error tag and description texts. */
export async function refinementFails(layer: Layer.Layer<Services | Tracker>, tag: RunError["_tag"], ...texts: RegExp[]): Promise<RunError> {
  return refinementFailsWith(layer, "checked", tag, ...texts);
}
/** refinementFails for a run with the given choice of terms (issue #142). */
export async function refinementFailsWith(layer: Layer.Layer<Services | Tracker>, terms: TermsMode, tag: RunError["_tag"], ...texts: RegExp[]): Promise<RunError> {
  const exit = await Effect.runPromiseExit(refinementRun("task", scriptedItem.id, terms).pipe(Effect.provide(layer)));
  assert.ok(Exit.isFailure(exit), "the run succeeded");
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(error), `the run ended with a defect, not a typed error: ${Cause.pretty(exit.cause)}`);
  assert.equal(error.value._tag, tag);
  for (const text of texts) assert.match(describe(error.value), text);
  return error.value;
}

/** Runs the procedure and asserts that it fails with the given error tag and description texts. */
export async function runFails(layer: Layer.Layer<Services>, tag: RunError["_tag"], ...texts: RegExp[]): Promise<RunError> {
  const exit = await Effect.runPromiseExit(withSuite(run("task").pipe(Effect.provide(layer))));
  assert.ok(Exit.isFailure(exit), "the run succeeded");
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(error), `the run ended with a defect, not a typed error: ${Cause.pretty(exit.cause)}`);
  assert.equal(error.value._tag, tag);
  for (const text of texts) assert.match(describe(error.value), text);
  return error.value;
}

/**
 * Issue #193: the reason of a halt as the page said it, the text between `HALTED: ` and `State is preserved in`, which a
 * halt's record in conversation.md carries (haltRecord); null where the page said no halt.
 */
export const haltReasonOf = (said: string): string | null => /\nHALTED: ([^]*?)\nState is preserved in /.exec(said)?.[1] ?? null;
/** Issue #193: the conversation.md of the directory the page named after `State is preserved in`. */
export const haltConversationOf = (said: string): string => {
  const dir = /State is preserved in (.*)\.(?:\n|$)/.exec(said)?.[1] ?? assert.fail(`no directory named: ${said}`);
  return fs.readFileSync(path.join(dir, "conversation.md"), "utf8");
};

/** What a program test inspects: the scripted implementations, the paths and the tracker. */
export type WiringProbe = { ui: ScriptedUi; planner: ScriptedPlanner; reviewer: ScriptedReviewer; project: string; dir: string; tracker: FakeTracker | null; suite: ScriptedSuite };

/** The item of every scripted run (issue #120): its title is the scripted task and its body is empty, so taskTextOf gives scriptedTask. */
export const scriptedItem: FakeItem = { id: Result.getOrThrow(itemIdOf("1")), title: "task", body: "", state: "refined", open: true, url: Option.none() };
/** The start of a scripted run from scriptedItem (or another item) in a project. */
export const scriptedStart = (project: string, mode: RunMode = "implementation", item: ItemId = scriptedItem.id, terms: TermsMode = "checked"): RunStart => (mode === "refinement" ? { mode, item, project, terms } : { mode, item, project });
/**
 * The project's tracker of a run manager under test (issue #120): refined items 1 to 6 for implementation runs and
 * unrefined items 11 to 16 for refinement runs, each with the scripted item's title and empty body, so that its task is
 * the scripted task.
 */
export const MANAGER_ITEMS: readonly FakeItem[] = [1, 2, 3, 4, 5, 6].flatMap((n): FakeItem[] => [
  { ...scriptedItem, id: Result.getOrThrow(itemIdOf(`${n}`)), state: "refined", url: managerItemUrl(n) },
  { ...scriptedItem, id: Result.getOrThrow(itemIdOf(`${10 + n}`)), state: "unrefined", url: managerItemUrl(10 + n) },
]);
/** Issue #125: an odd-numbered item has its page in the tracker, an even-numbered one none, so a listing shows both. */
function managerItemUrl(n: number): Option.Option<ItemUrl> {
  return n % 2 === 1 ? Option.some(Result.getOrThrow(itemUrlOf(`https://tracker.example/items/${n}`))) : Option.none();
}
/** How a run manager under test reaches its tracker: an empty shared config and the fake. */
export const trackerAccessOf = (tracker: FakeTracker) => {
  const shared = path.join(tempDir("pr-shared-"), "config.json");
  fs.writeFileSync(shared, "{}");
  return { sharedConfig: shared, tracker: () => Result.succeed(Layer.succeed(Tracker, tracker.tracker)) };
};
/** A fake tracker over items, built at once (its state is a Ref, made synchronously). */
export const fakeTrackerOf = (items: readonly FakeItem[]): FakeTracker => Effect.runSync(makeFakeTracker(items));

const scripted = taskOf("task");
/** The task of every scripted run (issue #88): a Task, never a Result, so that no test passes a blank one by accident. */
export const scriptedTask: Task = Result.isSuccess(scripted) ? scripted.success : assert.fail("the scripted task is blank");

/**
 * The wiring of the program with scripted agents and Ui over a temporary repository. The shared
 * config file is an empty object in a temporary directory, so the repository's own config.json
 * plays no part; `options.config` is written to the project's plan-review/config.json.
 */
export function testWiring(repo: string, options: TestOptions = {}): { wiring: Wiring; probe: WiringProbe } {
  // Issue #120: the program allocates the run's records directory from its start; the agents learn it from the run's store.
  let records: string | null = null;
  const paths = pathsOf(repo, () => records ?? assert.fail("the run's records directory is not known before the run's store exists"));
  const dir = path.join(paths.project, "plan-review");
  const shared = path.join(tempDir("pr-shared-"), "config.json");
  fs.writeFileSync(shared, "{}");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ ...options.config }));
  const ui = new ScriptedUi(options.answers ?? [], options.confirmEnds ?? false);
  const planner = new ScriptedPlanner(paths, options.steps ?? [], options.execs ?? [], options.execScripts ?? []);
  planner.contexts = [...(options.contexts ?? [])];
  planner.terms = [...(options.terms ?? [])];
  planner.replies = [...(options.replies ?? [])];
  planner.closings = [...(options.closings ?? [])];
  planner.ui = ui;
  const reviewer = new ScriptedReviewer(paths, options.reviews ?? []);
  reviewer.termsReviews = [...(options.termsReviews ?? [])];
  const tracker = options.tracker === undefined ? fakeTrackerOf([scriptedItem]) : options.tracker;
  const suite = new ScriptedSuite(options.suite ?? []);
  const wiring: Wiring = {
    ui: Effect.succeed(ui),
    platform: platformLayer,
    sdk: new FakeSdk(),
    // The scripted execution reports its call to the run's Ui, as the adapter does (issue #6: the current step).
    agents: Layer.mergeAll(
      Layer.effect(
        Planner,
        Effect.gen(function* () {
          planner.callUi = yield* Ui;
          planner.callStore = yield* Store;
          records = planner.callStore.dir;
          return planner;
        }),
      ),
      Layer.succeed(Reviewer, reviewer),
    ),
    sharedConfig: shared,
    tracker: () => (tracker === null ? Result.fail(new NoTracker()) : Result.succeed(Layer.succeed(Tracker, tracker.tracker))),
    suite,
  };
  return {
    wiring,
    probe: {
      ui,
      planner,
      reviewer,
      project: paths.project,
      tracker,
      suite,
      /** The run's records directory once the run's store exists; plan-review/ before it. */
      get dir() {
        return records ?? dir;
      },
    },
  };
}

// S37: Markdown read back with marked (a devDependency of the page), for the tests alone; the program reads no Markdown.
const entities: Readonly<Record<string, string>> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const unescapeHtml = (html: string): string => html.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => entities[e] ?? e);
/** Markdown read back: the texts of its code elements, in order, and its text outside them. */
export const readBack = (markdown: string): Readonly<{ code: readonly string[]; rest: string }> => {
  const html = marked.parseInline(markdown, { async: false, gfm: true });
  return {
    code: [...html.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) => unescapeHtml(m[1])),
    rest: unescapeHtml(html.replace(/<code>[\s\S]*?<\/code>/g, "").replace(/<[^>]*>/g, "")),
  };
};

/**
 * Issue #94: Markdown read as blocks, for the tests alone: the types of its top-level blocks (blank space left out), and
 * its text with every tag removed, every entity decoded and the renderer's last line break dropped.
 */
export const readBlocks = (markdown: string): Readonly<{ types: readonly string[]; text: string }> => ({
  types: marked.lexer(markdown).filter((t) => t.type !== "space").map((t) => t.type),
  text: unescapeHtml(marked.parse(markdown, { async: false, gfm: true }).replace(/<[^>]*>/g, "")).replace(/\n$/u, ""),
});

/**
 * A Clock for the waits of issue #68: its time starts at `startMs`, and each sleep records its duration in `sleeps`,
 * advances the time by it, then runs `onSleep` (a file written during the wait, or `Effect.never` to hold the wait open
 * for an interruption) instead of waiting.
 */
export const steppingClock = (startMs: number, onSleep: (ms: number) => Effect.Effect<void> = () => Effect.void): { clock: Clock.Clock; sleeps: number[]; now: () => number } => {
  let time = startMs;
  const sleeps: number[] = [];
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => time,
    currentTimeMillis: Effect.sync(() => time),
    currentTimeNanosUnsafe: () => BigInt(time) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(time) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(time) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(time) * 1_000_000n),
    sleep: (duration) =>
      Effect.suspend(() => {
        const ms = Duration.toMillis(duration);
        sleeps.push(ms);
        time += ms;
        return onSleep(ms);
      }),
  };
  return { clock, sleeps, now: () => time };
};

/**
 * Issue #192 (work review 3, W3-R2-1): a Clock whose time moves only when the test calls `advance`. A sleep registers
 * its duration and the time it wakes at, and waits until `advance` reaches that time; an interrupted sleep removes
 * itself. `sleepRegistered(ms)` resolves once a sleep of exactly `ms` is registered, and `sleeps()` lists every sleep
 * ever registered, in order. Unlike `steppingClock`, starting a sleep never moves the time, so a sleep started
 * concurrently cannot shorten another's computed delay.
 */
export const heldClock = (startMs: number): {
  clock: Clock.Clock;
  advance: (ms: number) => void;
  sleepRegistered: (ms: number) => Promise<void>;
  sleeps: () => readonly number[];
} => {
  type Pending = { readonly ms: number; readonly wakeAt: number; readonly wake: () => void };
  let time = startMs;
  let pending: readonly Pending[] = [];
  let all: readonly number[] = [];
  let waiters: readonly { readonly ms: number; readonly resolve: () => void }[] = [];
  const notify = (): void => {
    const [ready, rest] = [waiters.filter((w) => pending.some((p) => p.ms === w.ms)), waiters.filter((w) => !pending.some((p) => p.ms === w.ms))];
    waiters = rest;
    ready.forEach((w) => w.resolve());
  };
  const nanos = (): bigint => BigInt(time) * 1_000_000n;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => time,
    currentTimeMillis: Effect.sync(() => time),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: (duration) =>
      Effect.callback<void>((resume) => {
        const ms = Duration.toMillis(duration);
        const entry: Pending = { ms, wakeAt: time + ms, wake: () => resume(Effect.void) };
        pending = [...pending, entry];
        all = [...all, ms];
        notify();
        return Effect.sync(() => {
          pending = pending.filter((p) => p !== entry);
        });
      }),
  };
  const advance = (ms: number): void => {
    time += ms;
    const due = [...pending.filter((p) => p.wakeAt <= time)].sort((a, b) => a.wakeAt - b.wakeAt);
    pending = pending.filter((p) => p.wakeAt > time);
    due.forEach((p) => p.wake());
  };
  const sleepRegistered = (ms: number): Promise<void> =>
    pending.some((p) => p.ms === ms)
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          waiters = [...waiters, { ms, resolve }];
        });
  return { clock, advance, sleepRegistered, sleeps: () => all };
};

/** Issue #112: an explanation as a presented question holds it, its senses built by the program's one constructor. */
export const shownOf = (e: S.Explanation): ShownExplanation => {
  const shown = shownExplanations([e]);
  assert.ok(Result.isSuccess(shown), `not a presented explanation: ${JSON.stringify(e)}`);
  return shown.success[0];
};

/**
 * Issue #112 (W1-R1-1, P2-R1-1 of work review 1): the terms of a Markdown record read back as a reader's renderer shows
 * them, for the tests alone: each list item that opens with a term's label, mapped to its senses' rendered texts in order
 * (a nested ordered list's items, or the item's own text after its label), whitespace collapsed and every tag removed.
 */
export const readTerms = (markdown: string): ReadonlyMap<string, readonly string[]> => {
  type Item = { text: string; tokens: readonly Tok[] };
  type Tok = { type: string; ordered?: boolean; items?: readonly Item[]; tokens?: readonly Tok[] };
  const shown = (tokens: readonly Tok[]): string =>
    unescapeHtml(marked.parser(tokens as never, { async: false, gfm: true }).replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
  const found = new Map<string, readonly string[]>();
  const visit = (tokens: readonly Tok[]): void =>
    tokens.forEach((t) => {
      if (t.type === "list" && t.ordered !== true)
        (t.items ?? []).forEach((item) => {
          const label = /^([^:\n]+):/u.exec(item.text);
          const senses = item.tokens.find((x) => x.type === "list" && x.ordered === true);
          if (label !== null) found.set(label[1], senses === undefined ? [shown(item.tokens).slice(label[0].length).trim()] : (senses.items ?? []).map((i) => shown(i.tokens)));
          visit(item.tokens);
        });
      else if (t.tokens !== undefined) visit(t.tokens);
    });
  visit(marked.lexer(markdown) as unknown as readonly Tok[]);
  return found;
};
/** A sense as readTerms gives it back: its whitespace collapsed. */
export const senseRead = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Issue #142: a run manager's start of the mode from an item; a refinement with the choice of terms `checked`, as every existing scenario scripts. */
export const startOf = (mode: RunMode, item: string, terms: TermsMode = "checked"): StartRequest => (mode === "refinement" ? { mode, item, terms } : { mode, item });

/**
 * Issue #192: a record without the line of an item's return to refined that the program writes after the server
 * fault's record, for the tests that read the fault's record as the end of conversation.md. The pattern is built from
 * itemReturnedLine itself, so the two never disagree.
 */
export const withoutReturnLine = (record: string): string => {
  const [before, after] = itemReturnedLine("\u0000").split("\u0000");
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return record.replace(new RegExp(`${escape(before ?? "")}\\S+${escape(after ?? "")}\\n\\n$`), "");
};

/** Issue #186: the run's first plan as its reply, a plan; with `plan` in the step, its one step's text. */
export const firstPlan = (): unknown => ({ questions_for_user: [] });
/** Issue #186: the run's first planning reply as the verdict that the item is not refined. */
export const notRefined = (missing: string): unknown => ({ reply: { kind: "notRefined", missing } });

/**
 * Issue #186: the run's first plan asks no question, so a script that put one in it moves it into Claude Code's
 * response to the first plan review, where questions_for_user stays: the review raises P1-R1-1, the response rejects it
 * and asks the questions, and the next review round is the script's first.
 */
export const askedInPlanReview = (options: TestOptions): TestOptions => {
  const [first, ...rest] = options.steps ?? [];
  const output = (first?.output ?? {}) as { questions_for_user?: readonly unknown[] };
  const questions = output.questions_for_user ?? [];
  return {
    ...options,
    steps: [{ ...first, output: { ...output, questions_for_user: [] } }, { output: respond([["P1-R1-1", "rejected"]], { questions_for_user: questions as PlannerResponse["questions_for_user"] }) }, ...rest],
    reviews: [{ issues: [issue("P1-R1-1")] }, ...(options.reviews ?? [])],
  };
};

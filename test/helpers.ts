import assert from "node:assert/strict";
import { marked } from "marked";
import type { PresentedQuestion } from "../src/question.ts";
import { confirmingRead } from "../src/confirmEnd.ts";
import { programWritten } from "../src/questionContext.ts";
import { CONTEXT_REQUEST_HEADING, permissionPrompt, recordSubject } from "../src/prompts.ts";
import { type Block, type Explanation, type Piece, type PieceOption, piecesText, plainBlocks, plainOption, plainPieces } from "../src/pieces.ts";
import { askOffering, permissionDraft } from "../src/offer.ts";
import type { UiEvent } from "../src/uiEvents.ts";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after } from "node:test";
import { Cause, Effect, Exit, FileSystem, Layer, Option, PlatformError } from "effect";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import type { Schema } from "effect";
import type { RunError } from "../src/errors.ts";
import { AgentUnreachable, describe, TransportFault, UserStopped } from "../src/errors.ts";
import { parseAskLine, parseMessage } from "../src/input.ts";
import type { Wiring } from "../src/program.ts";
import { pathOf, type SubjectId } from "../src/artifacts.ts";
import { run } from "../src/run.ts";
import * as S from "../src/schema.ts";
import type { Plan as SPlan, RecordedPlan, StepStatus } from "../src/schema.ts";
import { type Decider, type DeciderShape, Planner, type PlannerShape, type PlanningCapability, type PlanningPurpose, Reviewer, type ReviewerShape, type ReviewSession, RunConfig, type Services, type StepReply, type StepReporter, Store, type StoreShape, Ui, type UiShape } from "../src/services.ts";
import { type Platform, platformLayer } from "../src/platform.ts";
import { makeStore, storeLayer } from "../src/store.ts";
import { type DeciderDeps, deciderLayer } from "../src/decision.ts";
import { FakeSdk } from "./fakeSdk.ts";

type Config = typeof S.Config.Type;
type ExecOutcome = typeof S.ExecOutcome.Type;
type PlannerResponse = typeof S.PlannerResponse.Type;
type Review = typeof S.Review.Type;
type LogEntry = typeof S.LogEntry.Type;
const { defaultConfig } = S;

/** The paths a scripted agent writes to. */
export type Paths = { readonly project: string; readonly plan: string; readonly planFile: string };
export const pathsOf = (repo: string): Paths => ({ project: path.resolve(repo), plan: path.join(repo, "plan-review", "plan.md"), planFile: path.join(repo, "plan-review", "plan.json") });

/** The plan a scripted step stands for (issue #6, F1): one stage with one step S1 whose text is the step's `plan`. */
export const scriptedPlan = (text: string): SPlan => ({ stages: [{ number: 1, title: "Plan", steps: [{ id: "S1", number: 1, label: "Step", text }] }] });
/** That plan as plan.json records it, every step with `status`. */
export const scriptedRecordedPlan = (text: string, status: StepStatus = "pending"): RecordedPlan => ({ stages: scriptedPlan(text).stages.map((st) => ({ ...st, steps: st.steps.map((x) => ({ ...x, status })) })) });
/** Whether a planning call's schema carries the plan (the plan write and the response to a plan review). */
const carriesPlan = (schema: Schema.Top): boolean => schema === S.PlanWrite || schema === S.PlanResponse;

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
export type ScriptedAnswer = string | { readonly wait: true } | { readonly text: string; readonly before: () => void };

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
  /** `confirmEnds`: an answer that ends the run is confirmed first, as in the terminal (S24, confirmingRead). */
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
  /** The commands are the terminal's (src/input.ts): "q" ends the run at a one-line prompt. */
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
    const raw = (p: string) => this.raw(p);
    return (this.confirmEnds ? confirmingRead(raw, raw, prompt, mode) : raw(prompt)).pipe(Effect.flatMap(interpret));
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
export const detailsText = (q: PresentedQuestion): string => q.details.map((b) => (b.kind === "paragraph" ? piecesText(b.pieces) : b.kind === "list" ? b.items.map((i) => piecesText(i.pieces)).join("\n") : b.kind === "code" ? b.text : b.markdown)).join("\n\n");
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
  extra: Partial<Readonly<{ context: readonly Block[]; explanations: readonly Explanation[] }>> = {},
): S.UserQuestion => ({
  context: extra.context ?? para("Interloq, the orchestrator, asks this question on behalf of the run."),
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
  terms.map((t, i) => ({ id: `t${i + 1}`, term: t.term, explanation: t.explanation })).filter((e) => used.some((p) => p.ref === e.id));
const piecesOfWords = (w: Words, text: string) => {
  const terms = w.terms ?? [];
  const context = withTerms(w.context, terms);
  const question = withTerms(text, terms);
  const options = w.options.map((o) => ({ label: withTerms(o.label, terms), description: withTerms(o.description, terms) }));
  const used = [...context, ...question, ...options.flatMap((o) => [...o.label, ...o.description])];
  return { context: context.length === 0 ? [] : [{ kind: "paragraph" as const, pieces: context }], question, options, explanations: explanationsOf(terms, used) };
};
/** A question for the user (UserQuestion) from words written as strings; each term's words become pieces that refer to it. */
export const questionOf = (w: Words & Readonly<{ question: string }>): S.UserQuestion => piecesOfWords(w, w.question);
/** An interview turn's current question from words written as strings. */
export const currentOf = (w: Words & Readonly<{ id: string; text: string }>): S.InterviewTurn["current_question"] => {
  const { question, ...rest } = piecesOfWords(w, w.text);
  return { id: w.id, ...rest, text: question };
};
/** An agreed question-list entry from words written as strings. */
export const entryOf = (w: Readonly<{ id: string; context: string; question: string; reason: string; proposed_answers: readonly Readonly<{ label: string; description: string }>[]; default_answer: string }>): S.QuestionEntry => ({
  id: w.id,
  context: para(w.context),
  question: plain(w.question),
  reason: para(w.reason),
  proposed_answers: w.proposed_answers.map((a) => opt(a.label, a.description)),
  default_answer: w.default_answer,
  skip_if: null,
});
/** An agreed question-list entry of plain words. */
export const questionEntry = (id: string, question: string, answers: readonly (readonly [string, string])[] = [], extra: Partial<Readonly<{ context: string; reason: string; default_answer: string; skip_if: S.SkipCondition | null }>> = {}): S.QuestionEntry => ({
  id,
  context: para(extra.context ?? `Context of ${id}.`),
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
export type PlanningStep = { fault?: string; output?: unknown; /** The text of the plan's one step (issue #6): a call whose schema carries the plan returns it as data. */ plan?: string; touchProject?: boolean; hang?: boolean; resultText?: string; onCall?: () => void; editRecord?: { file: string; content: string | null }; usage?: boolean };

/** What one scripted execution does besides its outcome (issue #6): report_step calls, and hooks around them. */
/** `unreachable` fails the call with AgentUnreachable after its reports, as the adapter does when the user stops at the exhaustion pause (issue #26). */
/** `permission`: a permission request the call makes before its reports, asked as the adapter asks it (S49); the answer is recorded in `permissionAnswers`. */
export type ExecScript = { reports?: readonly (readonly [string, "started" | "done"])[]; onCall?: () => void; after?: () => void; hang?: boolean; unreachable?: boolean; permission?: Readonly<{ tool: string; input: Record<string, unknown> }> };

/** The paragraph of a context call's reply that a test does not script (S9): it keeps the rules. */
export const SCRIPTED_CONTEXT = { context: "Interloq, the orchestrator, asks this question on behalf of the run." };
/**
 * The reply of a context call that a test does not script (S9, G-R1-1): the scripted paragraph, and the question, the
 * options, the details and the explanations as the prompt gives them, unchanged.
 */
export const scriptedContextReply = (prompt: string): S.QuestionContext => {
  const data = JSON.parse(prompt.slice(prompt.indexOf(CONTEXT_REQUEST_HEADING) + CONTEXT_REQUEST_HEADING.length)) as Omit<S.QuestionContext, "context">;
  return { context: para(SCRIPTED_CONTEXT.context), question: data.question, options: data.options, details: data.details, explanations: data.explanations };
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
  private readonly execs: ExecOutcome[];
  private readonly execScripts: ExecScript[];
  constructor(state: Paths, steps: PlanningStep[], execs: ExecOutcome[], execScripts: readonly ExecScript[] = []) {
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
  readonly sessionId = Effect.succeed("test-session");
  /** How often a fresh session was started (a decision loop); the fresh planner shares this script. */
  freshSessions = 0;
  readonly fresh: Effect.Effect<PlannerShape> = Effect.sync(() => {
    this.freshSessions++;
    return this;
  });
  /** Returns the scripted output as it is: the caller decodes it, as with the real agent. */
  planning(prompt: string, schema: Schema.Top, purpose?: PlanningPurpose, capability: PlanningCapability = "records"): Effect.Effect<{ output: unknown; resultText: string; costUsd: number | null }, TransportFault> {
    // S17: the explanations of the terms (their writing, their responses, their repairs) have their own script, and
    // without one no question needs a term.
    if (schema === S.TermsWrite || schema === S.TermsResponse) {
      return Effect.suspend(() => {
        this.termsPrompts.push(prompt);
        const step = this.terms.shift();
        return Effect.succeed({ output: step === undefined ? { entries: [] } : step.output, resultText: "", costUsd: 0.01 });
      });
    }
    if (purpose === "context") {
      return Effect.suspend(() => {
        this.contextPrompts.push(prompt);
        this.contextCapabilities.push(capability);
        const step = this.contexts.shift();
        if (step?.editRecord !== undefined) fs.writeFileSync(path.join(path.dirname(this.state.plan), step.editRecord.file), step.editRecord.content ?? "");
        if (step?.fault !== undefined) return Effect.fail(new TransportFault({ agent: "claude", message: step.fault, status: null }));
        if (step?.touchProject) fs.appendFileSync(path.join(this.state.project, "a.txt"), "changed\n");
        return Effect.succeed({ output: step === undefined ? scriptedContextReply(prompt) : typeof step.output === "function" ? (step.output as (p: string) => unknown)(prompt) : step.output, resultText: "", costUsd: 0.01 });
      });
    }
    return Effect.suspend(() => {
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
      const records = path.dirname(this.state.plan);
      if (step.editRecord !== undefined) {
        const file = path.join(records, step.editRecord.file);
        if (step.editRecord.content === null) fs.rmSync(file, { force: true });
        else {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, step.editRecord.content);
        }
      }
      if (step.usage) fs.appendFileSync(path.join(records, "usage.jsonl"), JSON.stringify({ version: 2, agent: "claude", session: "test-session", num_turns: 1, total_cost_usd: 0.1 }) + "\n");
      if (step.fault !== undefined) return Effect.fail(new TransportFault({ agent: "claude", message: step.fault, status: null }));
      return Effect.succeed({ output: this.withPlan(schema, step), resultText: step.resultText ?? "", costUsd: 0.1 });
    });
  }
  /** The text of the last plan scripted, which a reply without `plan` returns unchanged (issue #6, F1). */
  private lastPlan: string | null = null;
  /**
   * A call whose schema carries the plan returns it as data (F1): `plan` scripts its one step's text, and without it the
   * last plan is returned unchanged, as an agent that leaves the plan as it is. An output that has `plan` keeps its own.
   */
  private withPlan(schema: Schema.Top, step: PlanningStep): unknown {
    if (step.plan !== undefined) this.lastPlan = step.plan;
    const output = step.output;
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
  executing(_prompt: string, reporter: StepReporter): Effect.Effect<ExecOutcome, RunError, Decider> {
    const script = this.execScripts.shift() ?? {};
    const self = this;
    const ui = this.callUi;
    const body = Effect.gen(function* () {
      script.onCall?.();
      if (script.permission !== undefined && ui !== null && self.callStore !== null) {
        const draft = permissionDraft(script.permission.tool, script.permission.input);
        const answer = yield* askOffering((p) => ui.ask(p), permissionPrompt, draft).pipe(Effect.provideService(Ui, ui), Effect.provideService(Store, self.callStore));
        self.permissionAnswers.push(answer);
      }
      for (const [id, status] of script.reports ?? []) self.stepReplies.push(yield* reporter(id, status));
      script.after?.();
      if (script.hang) return yield* Effect.never;
      if (script.unreachable) return yield* Effect.fail(new AgentUnreachable({ agent: "claude", attempts: 4, lastFault: "read ECONNRESET" }));
      const outcome = self.execs.shift();
      if (!outcome) return yield* Effect.die(new Error("no scripted execution outcome"));
      fs.appendFileSync(path.join(self.state.project, "a.txt"), "implemented\n");
      return outcome;
    });
    if (ui === null) return body;
    return ui.notify({ _tag: "AgentCallStarted", agent: "claude", purpose: "execution" }).pipe(
      Effect.andThen(body),
      Effect.onExit((exit) => ui.notify({ _tag: "AgentCallEnded", agent: "claude", ok: Exit.isSuccess(exit) })),
    );
  }
}

/**
 * A scripted review. `plan` makes the reviewer change plan.json, the plan's reviewed file, during its turn, as Codex could.
 * `raw` replaces the reply text, for a reply that is not a review (or not JSON).
 */
export type ReviewStep = Review & { fault?: string; plan?: string; raw?: string; touchProject?: boolean; editRecord?: string; onCall?: () => void };

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
      review: (prompt: string): Effect.Effect<string, TransportFault> =>
        Effect.sync(() => this.turn(prompt, phase)).pipe(
          Effect.flatMap((reply) => (reply.fault === null ? Effect.succeed(reply.text) : Effect.fail(new TransportFault({ agent: "codex", message: reply.fault, status: null })))),
        ),
    };
  });
  /** One scripted turn: its effects on the files, then its reply text, or the fault it fails with. */
  /** The reviews of the terms (S17), apart from `reviews`; without one, a terms review raises no issue. */
  termsReviews: ReviewStep[] = [];
  private turn(prompt: string, phase: number): { text: string; fault: string | null } {
    this.prompts.push(prompt);
    this.callPhases.push(phase);
    const terms = prompt.includes(`plan-review/${pathOf({ kind: "terms" })}`);
    const step = terms ? (this.termsReviews.shift() ?? { issues: [] }) : this.reviews.shift();
    if (!step) throw new Error("no scripted review");
    step.onCall?.();
    if (step.plan !== undefined) fs.writeFileSync(this.state.planFile, step.plan);
    if (step.touchProject) fs.appendFileSync(path.join(this.state.project, "a.txt"), "codex\n");
    // A record under plan-review/ that the turn edits, as Codex could (the work review's changes.diff).
    if (step.editRecord !== undefined) fs.appendFileSync(path.join(this.state.project, "plan-review", step.editRecord), "edited by the reviewer\n");
    return { text: step.raw ?? JSON.stringify({ issues: step.issues }), fault: step.fault ?? null };
  }
}

export const issue = (id: string, problem = "p"): Review["issues"][number] => ({ id, severity: "major", location: "s", problem, evidence: "e" });

export const respond = (dispositions: [string, PlannerResponse["dispositions"][number]["action"]][], extra: Partial<PlannerResponse> = {}): PlannerResponse => ({
  dispositions: dispositions.map(([id, action]) => ({ id, action, rationale: `rationale ${id}`, duplicate_of: "", reverses: "" })),
  self_corrections: [],
  reviewer_feedback: "",
  questions_for_user: [],
  ...extra,
});

export const finished: ExecOutcome = { status: "finished", summary: "done", question: "", remainingWork: "", userInput: null };

/** `store` wraps the live store of the test layer (a test that changes the project between the agents' calls). */
export type TestOptions = { answers?: readonly ScriptedAnswer[]; steps?: PlanningStep[]; /** The replies of the context calls (S9), in order. */ contexts?: PlanningStep[]; /** The replies of the calls about the terms and their reviews (S17). */ terms?: PlanningStep[]; termsReviews?: ReviewStep[]; /** The terminal's confirmation before an answer ends the run (S24). */ confirmEnds?: boolean; reviews?: ReviewStep[]; execs?: ExecOutcome[]; execScripts?: readonly ExecScript[]; config?: Partial<Config>; platform?: Layer.Layer<Platform>; store?: (store: StoreShape) => StoreShape };

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
export function testLayer(repo: string, options: TestOptions = {}): { layer: Layer.Layer<Services>; probe: Probe } {
  const paths = pathsOf(repo);
  const config: Config = { ...defaultConfig, questionPhase: false, ...options.config };
  const ui = new ScriptedUi(options.answers ?? [], options.confirmEnds ?? false);
  const planner = new ScriptedPlanner(paths, options.steps ?? [], options.execs ?? [], options.execScripts ?? []);
  planner.contexts = [...(options.contexts ?? [])];
  planner.terms = [...(options.terms ?? [])];
  const reviewer = new ScriptedReviewer(paths, options.reviews ?? []);
  reviewer.termsReviews = [...(options.termsReviews ?? [])];
  const wrap = options.store ?? ((s: StoreShape) => s);
  const store = Layer.effect(Store, makeStore(repo, config.ignorePaths).pipe(Effect.map(wrap))).pipe(Layer.provide(options.platform ?? platformLayer));
  const layer = withDecider(Layer.mergeAll(store, Layer.succeed(Ui, ui), Layer.succeed(Planner, planner), Layer.succeed(Reviewer, reviewer), Layer.succeed(RunConfig, config)));
  const dir = path.join(paths.project, "plan-review");
  const loadLog = (subject: SubjectId = { plan: 1 }): Promise<readonly LogEntry[]> =>
    Effect.runPromise(makeStore(repo, config.ignorePaths).pipe(Effect.flatMap((s) => s.loadLog(subject)), Effect.provide(platformLayer)));
  return { layer, probe: { dir, plan: paths.plan, requirements: path.join(dir, "requirements.md"), loadLog, ui, planner, reviewer, config } };
}

/** Runs the procedure against a layer and returns the number of execution phases. */
export const runTask = (layer: Layer.Layer<Services>, task = "task"): Promise<number> => Effect.runPromise(run(task).pipe(Effect.provide(layer)));

/** Runs the procedure and asserts that it fails with the given error tag and description texts. */
export async function runFails(layer: Layer.Layer<Services>, tag: RunError["_tag"], ...texts: RegExp[]): Promise<RunError> {
  const exit = await Effect.runPromiseExit(run("task").pipe(Effect.provide(layer)));
  assert.ok(Exit.isFailure(exit), "the run succeeded");
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(error), `the run ended with a defect, not a typed error: ${Cause.pretty(exit.cause)}`);
  assert.equal(error.value._tag, tag);
  for (const text of texts) assert.match(describe(error.value), text);
  return error.value;
}

/** What a program test inspects: the scripted implementations, the paths, and the usage lines. */
export type WiringProbe = { ui: ScriptedUi; planner: ScriptedPlanner; reviewer: ScriptedReviewer; dir: string; usageLines: string[] };

/**
 * The wiring of the program with scripted agents and Ui over a temporary repository. The shared
 * config file is an empty object in a temporary directory, so the repository's own config.json
 * plays no part; `options.config` is written to the project's plan-review/config.json.
 */
export function testWiring(repo: string, options: TestOptions = {}): { wiring: Wiring; probe: WiringProbe } {
  const paths = pathsOf(repo);
  const dir = path.join(paths.project, "plan-review");
  const shared = path.join(tempDir("pr-shared-"), "config.json");
  fs.writeFileSync(shared, "{}");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ questionPhase: false, ...options.config }));
  const ui = new ScriptedUi(options.answers ?? [], options.confirmEnds ?? false);
  const planner = new ScriptedPlanner(paths, options.steps ?? [], options.execs ?? [], options.execScripts ?? []);
  planner.contexts = [...(options.contexts ?? [])];
  planner.terms = [...(options.terms ?? [])];
  const reviewer = new ScriptedReviewer(paths, options.reviews ?? []);
  reviewer.termsReviews = [...(options.termsReviews ?? [])];
  const usageLines: string[] = [];
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
          return planner;
        }),
      ),
      Layer.succeed(Reviewer, reviewer),
    ),
    sharedConfig: shared,
    cwd: paths.project,
    usage: (text) => Effect.sync(() => void usageLines.push(text)),
  };
  return { wiring, probe: { ui, planner, reviewer, dir, usageLines } };
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

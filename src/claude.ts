// Claude Code through the Claude Agent SDK, as the Planner service. This file keeps stream consumption,
// cancellation, persistence and the SDK's tool-name strings; decoding and reduction are in src/claudeEvents.ts.

import type { CanUseTool, HookCallback, Options, PermissionResult, PreToolUseHookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Deferred, Effect, Exit, Layer, Ref, Result } from "effect";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { pathOf } from "./artifacts.ts";
import { type CallOutcome, decodeQuestions, decodeToolTarget, execReport, interpretExecution, type Question, reduceMessages, type Stop } from "./claudeEvents.ts";
import { ClaudeCallFailed, type RunError, TransportFault, UsageLimited } from "./errors.ts";
import { type ClaudeFailure, classifyClaude, errorCode } from "./transport.ts";
import { withTransportRetry } from "./retry.ts";
import type { ExecOutcome } from "./schema.ts";
import { askOffering, numberedOptions, permissionDraft, programContext, type QuestionDraft } from "./offer.ts";
import { plainPieces } from "./pieces.ts";
import { parseRelayedQuestion, type QuestionOrigin } from "./question.ts";
import { chooseOption } from "./input.ts";
import { agentJsonSchema } from "./jsonSchema.ts";
import * as prompts from "./prompts.ts";
import * as S from "./schema.ts";
import { Decider, type DeciderShape, Planner, type PlannerShape, type PlanningCapability, type PlanningPurpose, RunConfig, Sdk, Store, Ui } from "./services.ts";

const EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/**
 * What a callback of the SDK can fail with: the user stopping, a record that could not be written, malformed callback
 * data, or the error of a decision loop that the user started from a relayed question or a permission request.
 */
type CallbackError = RunError;
/**
 * A failed call: TransportFault when src/transport.ts identifies a transport fault (issue #26), UsageLimited for a usage
 * limit with a stated reset (issue #68), ClaudeCallFailed otherwise.
 */
const callFailure = (message: string, failure: ClaudeFailure | null): ClaudeCallFailed | TransportFault | UsageLimited => {
  const kind = classifyClaude(failure);
  switch (kind.kind) {
    case "transport":
      return new TransportFault({ agent: "claude", message, status: failure?.apiStatus ?? null });
    case "limited":
      return new UsageLimited({ agent: "claude", message, resetsAtMs: kind.resetsAtMs, limitType: kind.limitType });
    case "permanent":
      return new ClaudeCallFailed({ message });
  }
};

/** Runs an Effect inside a callback of the SDK; on failure the call is aborted and `fallback` is answered. */
type InCallback = <A>(effect: Effect.Effect<A, CallbackError>, fallback: A) => Promise<A>;

/**
 * The answers as the SDK wants them: an object keyed by question text. Answers are collected by question
 * index, so two questions with the same text are answered separately; in the object the later one wins,
 * and `duplicates` names the texts for which that happened (finding 18 / 8 of the functional design review).
 */
export const toSdkAnswers = (questions: readonly { readonly question: string }[], answers: ReadonlyMap<number, string>): { answers: Record<string, string>; duplicates: readonly string[] } => {
  const object: Record<string, string> = {};
  const duplicates: string[] = [];
  questions.forEach((q, index) => {
    const answer = answers.get(index);
    if (answer === undefined) return;
    if (q.question in object && !duplicates.includes(q.question)) duplicates.push(q.question);
    object[q.question] = answer;
  });
  return { answers: object, duplicates };
};

/** The decoded questions of an AskUserQuestion input, or a typed failure of the call (finding 17). */
const questionsOf = (input: unknown): Effect.Effect<readonly Question[], ClaudeCallFailed> => {
  const decoded = decodeQuestions(input);
  return Result.isSuccess(decoded) ? Effect.succeed(decoded.success) : Effect.fail(new ClaudeCallFailed({ message: `AskUserQuestion input not understood: ${decoded.failure}` }));
};
const deny = (message: string): PermissionResult => ({ behavior: "deny", message });
const READ_ONLY_REASON = "This response may not use any tool: answer the review from the prompt with the final structured output only, and do not modify any file.";

/**
 * A read-only call (finding 1 of docs/gui-review.md): a hook without a matcher, so that every tool, known today or
 * not, reaches it, and it permits only the structured output. A capability rather than a list of tool names.
 */
const denyAllButOutput: HookCallback = async (input) => {
  const pre = input as PreToolUseHookInput;
  if (pre.tool_name === "StructuredOutput") return {};
  return { hookSpecificOutput: { hookEventName: pre.hook_event_name, permissionDecision: "deny", permissionDecisionReason: READ_ONLY_REASON } };
};
/** The tools a "readProject" call may use (S33): it reads the project and changes nothing. */
const READ_TOOLS = ["Read", "Grep", "Glob", "StructuredOutput"];
const READ_PROJECT_REASON = "This call may only read the project, with Read, Grep and Glob, and answer with the final structured output; do not modify any file.";
/** A "readProject" call's hook, without a matcher like the read-only one, so that no unlisted tool passes. */
const denyAllButReading: HookCallback = async (input) => {
  const pre = input as PreToolUseHookInput;
  if (READ_TOOLS.includes(pre.tool_name)) return {};
  return { hookSpecificOutput: { hookEventName: pre.hook_event_name, permissionDecision: "deny", permissionDecisionReason: READ_PROJECT_REASON } };
};
const readProjectPermission: CanUseTool = async () => deny(READ_PROJECT_REASON);
/** The permission callback of a read-only call: nothing is permitted, and a question is not relayed. */
const readOnlyPermission: CanUseTool = async () => deny(READ_ONLY_REASON);

/** The Planner service over the SDK, Ui, Store and RunConfig services. */
/**
 * The environment of a Claude Code call (issue #78): the inherited one, with BASH_MAX_TIMEOUT_MS set to the ceiling. The
 * Agent SDK replaces the inherited environment with the one it is given, so the inherited entries are kept.
 */
export const claudeEnv = (inherited: Readonly<Record<string, string | undefined>>, ceilingMs: number): Record<string, string | undefined> => ({ ...inherited, BASH_MAX_TIMEOUT_MS: String(ceilingMs) });

export const makeClaudePlanner: Effect.Effect<PlannerShape, never, Sdk | Ui | Store | RunConfig> = Effect.gen(function* () {
  const sdk = yield* Sdk;
  const ui = yield* Ui;
  const store = yield* Store;
  const config = yield* RunConfig;
  /** The model Claude Code last announced for the session; the announcement is repeated only when it changes. */
  const announcedModel = yield* Ref.make<string | null>(null);

  /**
   * The real location of a path that may not exist yet: its nearest existing ancestor resolved through
   * symlinks, plus the rest (finding 21). A path with no existing ancestor is returned as resolved.
   */
  const realLocation = async (target: string): Promise<string> => {
    let existing = target;
    const rest: string[] = [];
    for (;;) {
      try {
        return path.join(await fsp.realpath(existing), ...rest);
      } catch {
        const parent = path.dirname(existing);
        if (parent === existing) return target;
        rest.unshift(path.basename(existing));
        existing = parent;
      }
    }
  };
  /** True when the named target lies under the run's own records directory, plan-review/<root>/, on the file system, not only lexically (issue #120). */
  const underRecords = async (named: string): Promise<boolean> => {
    const allowed = (await realLocation(store.dir)) + path.sep;
    return (await realLocation(path.resolve(store.project, named))).startsWith(allowed);
  };
  /** Whether an edit targets plan.json or plan.md, which the program writes (issue #6, F1), resolved like underRecords. */
  const planFile = async (named: string): Promise<boolean> => {
    const records = await realLocation(store.dir);
    const target = await realLocation(path.resolve(store.project, named));
    return [pathOf({ kind: "planFile" }), pathOf({ kind: "plan" })].some((file) => target === path.join(records, file));
  };
  const denyPlanFile = (pre: PreToolUseHookInput) => ({
    hookSpecificOutput: { hookEventName: pre.hook_event_name, permissionDecision: "deny" as const, permissionDecisionReason: prompts.planFilesDenied(store.root) },
  });

  /** An ask with the offer of decision support (D2), run inside a callback: the services it needs are provided here. */
  const offering = (decider: DeciderShape, hint: string, draft: QuestionDraft, acceptable?: (answer: string) => boolean): Effect.Effect<string, CallbackError> =>
    askOffering((p) => ui.ask(p), hint, draft, acceptable).pipe(Effect.provideService(Decider, decider), Effect.provideService(Store, store), Effect.provideService(Ui, ui));

  /**
   * A relayed question as the user is shown it (S14): from its own parts when its text has the shape of RELAYED_SHAPE
   * (G-R1-2); otherwise it is not denied, and a context call writes its context and terms from the question, the task
   * and plan.md while the execution call waits (Q2).
   */
  const relayedDraft = (q: Question): Effect.Effect<QuestionDraft, CallbackError> =>
    Effect.gen(function* () {
      const origin: QuestionOrigin = { kind: "relayed" };
      const options = numberedOptions(q.options);
      const parsed = parseRelayedQuestion(q.question, q.options);
      if (parsed !== null) return { origin, context: { blocks: parsed.context, by: "agent" }, explanations: parsed.explanations, question: parsed.question, options: options.map((o, i) => ({ ...o, shown: parsed.options[i] ?? o.shown })), decision: null };
      const { plan } = yield* store.readContext();
      return { origin, context: programContext(origin), explanations: [], question: plainPieces(q.question), options, explain: prompts.relayedFacts(store.root, plan), decision: null };
    });

  /**
   * Asks the user each question; the answers are keyed by the question's index, so equal texts stay apart. A question
   * with options carries the offer; its presentation is repeated after an analysis (P1-R1-3).
   */
  const relayQuestions = (questions: readonly Question[], decider: DeciderShape): Effect.Effect<ReadonlyMap<number, string>, CallbackError> =>
    Effect.gen(function* () {
      const answers = new Map<number, string>();
      for (const [index, q] of questions.entries()) {
        const draft = yield* relayedDraft(q);
        // A blank reply is asked again, the question presented again first (W1-R1-1, W1-R1-2).
        const reply = yield* offering(decider, prompts.optionOrTextPrompt, draft, (a) => a !== "");
        const chosen = chooseOption(reply, q.options.length);
        const answer = chosen === null ? reply : q.options[chosen].label;
        answers.set(index, answer);
        yield* store.converse(`**User answer:** ${answer}\n\n`);
      }
      return answers;
    });
  /** The SDK object, with one note in the record when two questions shared a text (the later answer is delivered). */
  const sdkAnswers = (questions: readonly Question[], answers: ReadonlyMap<number, string>): Effect.Effect<Record<string, string>, CallbackError> =>
    Effect.gen(function* () {
      const edge = toSdkAnswers(questions, answers);
      if (edge.duplicates.length > 0) yield* store.converse(`**Duplicate question text:** ${edge.duplicates.join("; ")} — the answer to the later question is the one Claude Code receives.\n\n`);
      return edge.answers;
    });

  // Planning: deny every file edit whose target is outside plan-review/. A hook runs before the
  // permission evaluation, so the denial applies in every permission mode. An input without a
  // readable target is denied like one outside. The target is resolved on the file system, so a
  // symlink under plan-review/ that points outside is denied (finding 21). Race policy: the check
  // is made at hook time; the project snapshot comparison after the call is the second check
  // (behaviour 3), and the container is the boundary.
  const restrictEdits: HookCallback = async (input) => {
    const pre = input as PreToolUseHookInput;
    const named = decodeToolTarget(pre.tool_input);
    if (named !== null && (await planFile(named))) return denyPlanFile(pre);
    if (named !== null && (await underRecords(named))) return {};
    return {
      hookSpecificOutput: {
        hookEventName: pre.hook_event_name,
        permissionDecision: "deny",
        permissionDecisionReason: prompts.planningEditDenied(store.root),
      },
    };
  };

  // Execution: after Claude Code has asked the user a question, deny every further tool call, so
  // that the turn ends and the plan is revised and reviewed before work continues.
  // The StructuredOutput tool carries the final status report, so it stays permitted.
  // The stop belongs to one execution call (finding 20): the hook and the permission closure of a
  // call share the Ref that `executing` created for it.
  const denyAfterStop =
    (stop: Ref.Ref<Stop | null>): HookCallback =>
    async (input) => {
      if ((await Effect.runPromise(Ref.get(stop))) === null) return {};
      const pre = input as PreToolUseHookInput;
      if (pre.tool_name === "StructuredOutput") return {};
      return {
        hookSpecificOutput: {
          hookEventName: pre.hook_event_name,
          permissionDecision: "deny",
          permissionDecisionReason: "Execution is stopped. Make no tool call other than the final structured output, and end your turn with status 'needs_input'.",
        },
      };
    };

  // Execution (issue #6, P1-R1-4): plan.json and plan.md are the program's; a tool may not edit them. report_step is
  // how the steps are recorded.
  const denyPlanFileEdits: HookCallback = async (input) => {
    const pre = input as PreToolUseHookInput;
    const named = decodeToolTarget(pre.tool_input);
    return named !== null && (await planFile(named)) ? denyPlanFile(pre) : {};
  };

  const planningPermission =
    (decider: DeciderShape) =>
    (inCallback: InCallback): CanUseTool =>
    async (toolName, input): Promise<PermissionResult> => {
      if (toolName === "AskUserQuestion") {
        return inCallback(
          Effect.gen(function* () {
            const questions = yield* questionsOf(input);
            const answers = yield* sdkAnswers(questions, yield* relayQuestions(questions, decider));
            return { behavior: "allow", updatedInput: { questions, answers } } as PermissionResult;
          }),
          deny("The question could not be relayed to the user."),
        );
      }
      if (EDIT_TOOLS.includes(toolName)) return { behavior: "allow", updatedInput: input };
      return deny(prompts.planningToolDenied(store.root));
    };

  const executionPermission =
    (stop: Ref.Ref<Stop | null>, decider: DeciderShape, inCallback: InCallback): CanUseTool =>
    async (toolName, input): Promise<PermissionResult> => {
      // report_step (issue #6, Q2) needs no permission; after a stop, the hook denies it before this is asked.
      if (toolName === prompts.REPORT_STEP_TOOL_NAME) return { behavior: "allow", updatedInput: input };
      if (toolName === "AskUserQuestion") {
        await inCallback(
          Effect.gen(function* () {
            const questions = yield* questionsOf(input);
            yield* ui.say(prompts.IMPLEMENTATION_STOPPED_LINE);
            const answers = yield* relayQuestions(questions, decider);
            yield* Ref.set(stop, {
              question: questions.map((q) => q.question).join(" / "),
              input: [...answers].map(([index, a]) => `${questions[index].question} -> ${a}`).join("; "),
            });
          }),
          undefined,
        );
        return deny(
          prompts.stopRecordedText(store.root),
        );
      }
      const allowed = await inCallback(
        Effect.gen(function* () {
          // S12, S34, S49: the input under plain labels, the question naming the action; the context written by a
          // context call made while the execution call waits.
          const draft = permissionDraft(toolName, input);
          const reply = yield* offering(decider, prompts.permissionPrompt, draft);
          return reply.toLowerCase() === "y";
        }),
        false,
      );
      if (allowed) return { behavior: "allow", updatedInput: input };
      return deny("The user denied this action.");
    };

  /**
   * One SDK call. The messages are consumed inside the Effect, so an interruption aborts the call
   * through the SDK's AbortController. A callback runs its Effects through the runtime; if one fails,
   * the first failure is kept in a typed Deferred (its exact `CallbackError` type, no cast at the
   * Promise boundary; finding 10), the call is aborted, and the call fails with it. A defect in a
   * callback still rejects the callback's Promise. The messages are shown and the usage recorded as
   * they arrive; the outcome is the pure reduction of the list at the end.
   */
  const call = (session: Ref.Ref<string | null>, prompt: string, purpose: PlanningPurpose | "execution", show: "none" | "tools" | "text", options: Options, permission: (inCallback: InCallback) => CanUseTool, callbacks: (inCallback: InCallback) => Options = () => ({})): Effect.Effect<CallOutcome, CallbackError> =>
    Effect.gen(function* () {
      yield* ui.notify({ _tag: "AgentCallStarted", agent: "claude", purpose });
      const controller = new AbortController();
      const callbackFailure = yield* Deferred.make<never, CallbackError>();
      const inCallback: InCallback = (effect, fallback) =>
        Effect.runPromise(
          effect.pipe(
            Effect.catch((e: CallbackError) =>
              Deferred.fail(callbackFailure, e).pipe(
                Effect.andThen(Effect.sync(() => controller.abort())),
                Effect.as(fallback),
              ),
            ),
          ),
          { signal: controller.signal },
        );
      const full: Options = { ...options, ...callbacks(inCallback), cwd: store.project, abortController: controller, canUseTool: permission(inCallback) };
      const resumed = yield* Ref.get(session);
      if (resumed !== null) full.resume = resumed;
      if (config.claudeModel !== null) full.model = config.claudeModel;
      full.env = claudeEnv(sdk.inheritedEnv, prompts.COMMAND_CEILING_MS);

      const failed = (e: unknown): string => (e instanceof Error ? e.message : String(e));
      // Starting the call can throw synchronously (for example when the SDK cannot start its CLI);
      // that is a call error like a failure of the stream, not a defect.
      const started = yield* Effect.try({ try: () => sdk.query({ prompt, options: full })[Symbol.asyncIterator](), catch: failed }).pipe(Effect.result);
      if (Result.isFailure(started)) return reduceMessages([], started.failure);
      const iterator = started.success;
      const seen: SDKMessage[] = [];
      let streamError: string | null = null;
      let streamCode: string | null = null;
      /** The next message, or null at the end; a failure of the stream ends the call with its text and its code (issue #26). */
      const next = (): Effect.Effect<SDKMessage | null> =>
        Effect.tryPromise({ try: () => iterator.next(), catch: (e: unknown) => e }).pipe(
          Effect.map((step) => (step.done ? null : step.value)),
          Effect.catch((e) =>
            Effect.sync(() => {
              streamError = failed(e);
              streamCode = errorCode(e);
              return null;
            }),
          ),
        );
      const consume = Effect.gen(function* () {
        for (let message = yield* next(); message !== null; message = yield* next()) {
          seen.push(message);
          if (message.type === "system" && message.subtype === "init") {
            yield* Ref.set(session, message.session_id);
            if ((yield* Ref.get(announcedModel)) !== message.model) {
              yield* ui.say(`Claude Code model: ${message.model}`);
              yield* Ref.set(announcedModel, message.model);
            }
          } else if (message.type === "assistant") {
            for (const block of message.message.content) {
              if (show === "text" && block.type === "text" && block.text.trim() !== "") yield* ui.notify({ _tag: "ClaudeSaid", text: block.text.trim() });
              if (block.type === "tool_use" && block.name !== "StructuredOutput") {
                const input = block.input as Record<string, unknown>;
                const target = String(input?.file_path ?? input?.pattern ?? input?.command ?? "");
                yield* ui.notify({ _tag: "ToolUsed", agent: "claude", tool: block.name, target });
                if (show === "tools") yield* ui.say(`  [claude: ${block.name} ${target}]`);
              }
            }
          } else if (message.type === "system" && message.subtype === "api_retry") {
            // Issue #26: the SDK's own retry of a failed request, invisible until now.
            yield* ui.notify({ _tag: "AgentReconnecting", agent: "claude", by: "sdk", attempt: message.attempt, of: message.max_retries, delayMs: message.retry_delay_ms, detail: prompts.apiRetryDetail(message.error_status, message.error) });
          } else if (message.type === "result") {
            yield* store.recordUsage({ agent: "claude", session: yield* Ref.get(session), turns: message.num_turns, totalCostUsd: message.total_cost_usd });
          }
        }
      });
      // On every early exit — an interruption, or a typed failure such as a record that could not be
      // written — abort the call and close the stream, as the `for await` loop of the Promise version
      // did through the iterator's return(); otherwise the Claude Code process could outlive the halt.
      const close = Effect.promise(async () => {
        controller.abort();
        await iterator.return?.().catch(() => undefined);
      });
      yield* consume.pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.succeed(undefined) : close)));
      if (yield* Deferred.isDone(callbackFailure)) return yield* Deferred.await(callbackFailure);
      return reduceMessages(seen, streamError, streamCode);
    }).pipe(
      // Every exit ends the activity: a call error, a typed failure and an interruption are ok: false.
      Effect.onExit((exit) => ui.notify({ _tag: "AgentCallEnded", agent: "claude", ok: Exit.isSuccess(exit) && exit.value.error === null })),
    );

  /** The planner over one session: the run's main one, or a fresh one of a decision loop (D4); the hooks and callbacks are shared. */
  const plannerOver = (session: Ref.Ref<string | null>): PlannerShape => ({
    planning: (prompt, schema, purpose = "planning", capability: PlanningCapability = "records") =>
      Effect.gen(function* () {
        const decider = yield* Decider;
        const outcome = yield* call(
          session,
          prompt,
          purpose,
          purpose === "interview" ? "tools" : "none",
          {
            permissionMode: "default",
            outputFormat: { type: "json_schema", schema: agentJsonSchema(schema) },
            hooks: { PreToolUse: capability === "readOnly" ? [{ hooks: [denyAllButOutput] }] : capability === "readProject" ? [{ hooks: [denyAllButReading] }] : [{ matcher: EDIT_TOOLS.join("|"), hooks: [restrictEdits] }] },
          },
          capability === "readOnly" ? () => readOnlyPermission : capability === "readProject" ? () => readProjectPermission : planningPermission(decider),
        );
        if (outcome.error !== null) return yield* Effect.fail(callFailure(outcome.error, outcome.failure));
        return { output: outcome.structured, resultText: outcome.resultText, costUsd: outcome.costUsd };
      }),
    executing: (prompt, reporter) =>
      Effect.gen(function* () {
        const decider = yield* Decider;
        const stop = yield* Ref.make<Stop | null>(null);
        /**
         * One attempt of the call (issue #26, Q4): the first sends the prompt, a retry resumes the session with the continue
         * prompt, with the same hooks, stop and report_step server. It fails with TransportFault only for a transport fault
         * without a recorded stop and without a valid report; otherwise the outcome is interpreted.
         */
        const attempt = (n: number): Effect.Effect<ExecOutcome, CallbackError | TransportFault | UsageLimited> =>
          Effect.gen(function* () {
            const outcome = yield* call(
              session,
              n === 1 ? prompt : prompts.executionContinuePrompt,
              "execution",
              "text",
              {
                permissionMode: config.execPermissionMode,
                outputFormat: { type: "json_schema", schema: agentJsonSchema(S.ExecReport) },
                hooks: { PreToolUse: [{ hooks: [denyAfterStop(stop)] }, { matcher: EDIT_TOOLS.join("|"), hooks: [denyPlanFileEdits] }] },
                allowedTools: [prompts.REPORT_STEP_TOOL_NAME],
              },
              (inCallback) => executionPermission(stop, decider, inCallback),
              // report_step (issue #6, Q2): each report runs the phase's reporter; a failure to write aborts the call.
              (inCallback) => ({
                mcpServers: { [prompts.REPORT_STEP_SERVER]: sdk.stepReporter((r) => inCallback(reporter(r.id, r.status), { text: prompts.STEP_NOT_RECORDED, isError: true })) },
              }),
            );
            const recorded = yield* Ref.get(stop);
            // Issue #68: a usage limit with a stated reset is waited out like a transport fault is retried, under the
            // same conditions; a valid report before either stands.
            const temporary = outcome.error !== null && classifyClaude(outcome.failure).kind !== "permanent";
            if (temporary && recorded === null && execReport(outcome.structured) === null) {
              return yield* Effect.fail(callFailure(outcome.error ?? "", outcome.failure) as TransportFault | UsageLimited);
            }
            return interpretExecution(outcome, recorded, temporary);
          });
        // The retry lives here, where the call's session, stop and reporter are (P2-R2-1): no TransportFault leaves.
        return yield* withTransportRetry("claude", prompts.TRANSPORT_WHAT_EXECUTION, attempt, Effect.void).pipe(
          Effect.provideService(Ui, ui),
          Effect.provideService(Store, store),
          Effect.provideService(RunConfig, config),
        );
      }),
    sessionId: Ref.get(session),
    fresh: Ref.make<string | null>(null).pipe(Effect.map(plannerOver)),
  });
  return plannerOver(yield* Ref.make<string | null>(null));
});

export const claudePlannerLayer: Layer.Layer<Planner, never, Sdk | Ui | Store | RunConfig> = Layer.effect(Planner, makeClaudePlanner);

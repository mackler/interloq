// Claude Code through the Claude Agent SDK, as the Planner service. This file keeps stream consumption,
// cancellation, persistence and the SDK's tool-name strings; decoding and reduction are in src/claudeEvents.ts.

import type { CanUseTool, HookCallback, Options, PermissionResult, PreToolUseHookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Clock, Deferred, Duration, Effect, Exit, Layer, Ref, Result } from "effect";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { pathOf } from "./artifacts.ts";
import { type BackgroundState, type CallOutcome, checkBackground, claudeOpenProcesses, claudeOutputOf, EMPTY_CLAUDE_OUTPUT, type OutputCommand, toolTarget, decodeQuestions, decodeToolTarget, execReport, foldBackground, interpretExecution, nameTasks, NO_BACKGROUND, type Question, reduceMessages, type Stop, type NamedEnd, taskName, waitingOn } from "./claudeEvents.ts";
import { plainOutput } from "./liveOutput.ts";
import { ClaudeCallFailed, ClaudeSessionTooLong, ProcessEnded, type RunError, TransportFault, UsageLimited } from "./errors.ts";
import { type ClaudeFailure, classifyClaude, errorCode, type ProcessEnd, processEndOf } from "./transport.ts";
import { withTransportRetry } from "./retry.ts";
import { costWarningOf } from "./usage.ts";
import type { ExecCallOutcome } from "./schema.ts";
import { failureLineOf, secretsOf } from "./callFailureRecord.ts";
import { askOffering, byLine, numberedOptions, permissionDraft, programContext, type QuestionDraft } from "./offer.ts";
import { plainPieces } from "./pieces.ts";
import { parseRelayedQuestion, type QuestionOrigin } from "./question.ts";
import { chooseOption } from "./input.ts";
import { agentJsonSchema } from "./jsonSchema.ts";
import * as prompts from "./prompts.ts";
import * as S from "./schema.ts";
import { Decider, type DeciderShape, EXECUTION_PURPOSE, Planner, type PlannerShape, type PlanningCapability, type PlanningPurpose, RunConfig, Sdk, Store, Ui } from "./services.ts";

const EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
/** How often a wait for background commands looks at the call's state (issue #154). */
const BACKGROUND_POLL_MS = 50;

/**
 * What a callback of the SDK can fail with: the user stopping, a record that could not be written, malformed callback
 * data, or the error of a decision loop that the user started from a relayed question or a permission request.
 */
type CallbackError = RunError;
/**
 * A failed call: TransportFault when src/transport.ts identifies a transport fault (issue #26), UsageLimited for a usage
 * limit (issues #68 and #170), ClaudeSessionTooLong for a session too long to accept (issue #122), ClaudeCallFailed
 * otherwise. Exported so that the scripted planner of test/helpers.ts fails a call by the same mapping (issue #170).
 */
export const callFailure = (message: string, failure: ClaudeFailure | null): ClaudeCallFailed | ClaudeSessionTooLong | TransportFault | UsageLimited => {
  // Issue #157 (P1-R1-1): classified without the process ending, so a planning or context call keeps the
  // classification it had before; only an execution call's attempt classifies with it.
  const kind = classifyClaude(failure === null ? null : { ...failure, processEnd: null });
  switch (kind.kind) {
    case "transport":
      return new TransportFault({ agent: "claude", message, status: failure?.apiStatus ?? null });
    case "limited":
      return new UsageLimited({ agent: "claude", message, reset: kind.reset, limitType: kind.limitType });
    case "contextTooLong":
      return new ClaudeSessionTooLong({ message });
    case "permanent":
    case "processEnded": // never: the ending was removed above
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

/** What the adapter takes beside its services: the bound of one wait for background commands (issue #154), shorter in tests. */
export type ClaudePlannerOptions = Readonly<{ backgroundBoundMs: number }>;
export const makeClaudePlannerWith = (plannerOptions: ClaudePlannerOptions): Effect.Effect<PlannerShape, never, Sdk | Ui | Store | RunConfig> => Effect.gen(function* () {
  const sdk = yield* Sdk;
  const ui = yield* Ui;
  const store = yield* Store;
  const config = yield* RunConfig;
  /** The model Claude Code last announced for the session; the announcement is repeated only when it changes. */
  const announcedModel = yield* Ref.make<string | null>(null);
  const callCount = yield* Ref.make(0);
  /** The values of the inherited environment's credential-named variables, which no failure line may contain (issue #192). */
  const secrets = secretsOf(sdk.inheritedEnv);

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
    askOffering(byLine((p) => ui.ask(p)), hint, draft, acceptable).pipe(Effect.provideService(Decider, decider), Effect.provideService(Store, store), Effect.provideService(Ui, ui));

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
      if (parsed !== null) return { origin, context: { blocks: parsed.context, by: "agent" }, history: parsed.history, explanations: parsed.explanations, question: parsed.question, options: options.map((o, i) => ({ ...o, shown: parsed.options[i] ?? o.shown })), decision: null };
      const { plan } = yield* store.readContext();
      return { origin, context: programContext(origin), history: [], explanations: [], question: plainPieces(q.question), options, explain: prompts.relayedFacts(store.root, plan), decision: null };
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
  const call = (session: Ref.Ref<string | null>, prompt: string, purpose: PlanningPurpose | typeof EXECUTION_PURPOSE, show: "none" | "tools" | "text", options: Options, permission: (inCallback: InCallback) => CanUseTool, callbacks: (inCallback: InCallback, ended: AbortSignal) => Options = () => ({}), observe: (message: SDKMessage) => Effect.Effect<void> = () => Effect.void): Effect.Effect<CallOutcome, CallbackError> =>
    // Issue #184 (S13): the call's id, numbered by the planner's counter shared by its fresh sessions, on its start and end.
    Ref.updateAndGet(callCount, (n) => n + 1).pipe(Effect.map((n) => `claude-${n}`), Effect.flatMap((callId) => Effect.gen(function* () {
      yield* ui.notify({ _tag: "AgentCallStarted", agent: "claude", purpose, callId });
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
      const full: Options = { ...options, ...callbacks(inCallback, controller.signal), cwd: store.project, abortController: controller, canUseTool: permission(inCallback) };
      const resumed = yield* Ref.get(session);
      if (resumed !== null) full.resume = resumed;
      if (config.claudeModel !== null) full.model = config.claudeModel;
      full.env = claudeEnv(sdk.inheritedEnv, prompts.COMMAND_CEILING_MS);

      const failed = (e: unknown): string => (e instanceof Error ? e.message : String(e));
      /**
       * Issue #192 (requirements Q1): a failed request's facts are written to usage.jsonl, its credentials redacted,
       * before the outcome is classified. A failure of Interloq's own (a callback's) and an interruption never get here.
       */
      const recorded = (outcome: CallOutcome): Effect.Effect<CallOutcome, CallbackError> => {
        const message = outcome.error;
        return message === null
          ? Effect.succeed(outcome)
          : Ref.get(session).pipe(
              Effect.flatMap((id) => store.recordCallFailure(failureLineOf({ session: id, purpose, callId, message, failure: outcome.failure }, secrets))),
              Effect.as(outcome),
            );
      };
      // Starting the call can throw synchronously (for example when the SDK cannot start its CLI);
      // that is a call error like a failure of the stream, not a defect.
      const started = yield* Effect.try({ try: () => sdk.query({ prompt, options: full })[Symbol.asyncIterator](), catch: failed }).pipe(Effect.result);
      if (Result.isFailure(started)) return yield* recorded(reduceMessages([], started.failure));
      const iterator = started.success;
      const seen: SDKMessage[] = [];
      let streamError: string | null = null;
      let streamCode: string | null = null;
      let processEnd: ProcessEnd | null = null;
      /** The next message, or null at the end; a failure of the stream ends the call with its text and its code (issue #26). */
      const next = (): Effect.Effect<SDKMessage | null> =>
        Effect.tryPromise({ try: () => iterator.next(), catch: (e: unknown) => e }).pipe(
          Effect.map((step) => (step.done ? null : step.value)),
          Effect.catch((e) =>
            Effect.sync(() => {
              streamError = failed(e);
              streamCode = errorCode(e);
              // Issue #157: an aborted call (Stop task, or the adapter's own abort) is never read as a process ending.
              processEnd = controller.signal.aborted ? null : processEndOf(e);
              return null;
            }),
          ),
        );
      // Issue #49: the call's live output, folded per message; every process left open is ended with the call.
      const output = yield* Ref.make(EMPTY_CLAUDE_OUTPUT);
      const live = (command: OutputCommand): Effect.Effect<void> =>
        command._tag === "Emit"
          ? ui.output(command.event)
          : Effect.tryPromise({ try: () => sdk.readOutputTail(command.path), catch: () => null }).pipe(
              Effect.catch(() => Effect.succeed(null)),
              Effect.flatMap((tail) => {
                const text = tail === null ? "" : plainOutput(tail);
                return text === "" ? Effect.void : ui.output({ _tag: "Printed", key: command.key, name: command.name, text });
              }),
            );
      const endOpen = Ref.get(output).pipe(Effect.flatMap((state) => Effect.forEach(claudeOpenProcesses(state), (e) => ui.output(e), { discard: true })));
      const consume = Effect.gen(function* () {
        for (let message = yield* next(); message !== null; message = yield* next()) {
          seen.push(message);
          yield* observe(message);
          const received = message;
          const commands = yield* Ref.modify(output, (state) => {
            const [nextState, emitted] = claudeOutputOf(state, received);
            return [emitted, nextState] as const;
          });
          yield* Effect.forEach(commands, live, { discard: true });
          if (message.type === "system" && message.subtype === "init") {
            yield* Ref.set(session, message.session_id);
            if ((yield* Ref.get(announcedModel)) !== message.model) {
              yield* ui.notify({ _tag: "ModelNamed", model: { agent: "claude", name: message.model } });
              yield* Ref.set(announcedModel, message.model);
            }
          } else if (message.type === "assistant") {
            for (const block of message.message.content) {
              if (show === "text" && block.type === "text" && block.text.trim() !== "") yield* ui.notify({ _tag: "ClaudeSaid", text: block.text.trim() });
              if (block.type === "tool_use" && block.name !== "StructuredOutput") {
                const target = toolTarget(block.input);
                yield* ui.notify({ _tag: "ToolUsed", agent: "claude", tool: block.name, target, callId });
                if (show === "tools") yield* ui.say(`  [claude: ${block.name} ${target}]`);
              }
            }
          } else if (message.type === "rate_limit_event") {
            // Issue #170 (requirement Q3): every notice of every request, kept whole, so that a later refusal shows
            // which notices arrived.
            yield* store.recordRateLimit({ session: yield* Ref.get(session), info: message.rate_limit_info });
          } else if (message.type === "system" && message.subtype === "api_retry") {
            // Issue #26: the SDK's own retry of a failed request, invisible until now.
            yield* ui.notify({ _tag: "AgentReconnecting", agent: "claude", by: "sdk", attempt: message.attempt, of: message.max_retries, delayMs: message.retry_delay_ms, detail: prompts.apiRetryDetail(message.error_status, message.error), callId });
          } else if (message.type === "result") {
            const id = yield* Ref.get(session);
            yield* store.recordUsage({ agent: "claude", session: id, turns: message.num_turns, totalCostUsd: message.total_cost_usd });
            // Issue #122: a request whose cost is more than the amount set is warned about, as the records attribute it.
            const cost = costWarningOf((yield* store.usageLines()).calls, id, config.costWarningUsd);
            if (cost !== null) {
              const line = prompts.costWarningLine(id, cost, config.costWarningUsd);
              yield* ui.say(line);
              yield* store.converse(`${line}\n\n`);
            }
          }
        }
      });
      // On every exit — an interruption, a typed failure such as a record that could not be written, and the
      // stream's end, a failed stream's included — abort the call and close the stream, as the `for await` loop of
      // the Promise version did through the iterator's return(); otherwise the Claude Code process could outlive
      // the halt. Issue #154 (W1-R1-1): the abort also ends every callback still running, a hook's background wait
      // among them, so that none goes on after its call; after a normal end the query has ended and it is harmless.
      const close = Effect.promise(async () => {
        controller.abort();
        await iterator.return?.().catch(() => undefined);
      });
      yield* consume.pipe(Effect.ensuring(Effect.andThen(endOpen, close)));
      if (yield* Deferred.isDone(callbackFailure)) return yield* Deferred.await(callbackFailure);
      return yield* recorded(reduceMessages(seen, streamError, streamCode, processEnd));
    }).pipe(
      // Every exit ends the activity: a call error, a typed failure and an interruption are ok: false.
      Effect.onExit((exit) => ui.notify({ _tag: "AgentCallEnded", agent: "claude", ok: Exit.isSuccess(exit) && exit.value.error === null, callId })),
    )));

  /**
   * The wait of an execution call for its background commands (issue #154, decision Q1): nothing while a stop is
   * recorded or no task is pending; otherwise until every pending task has ended (its notification) or the bound of one
   * wait has passed, whichever comes first. The ends returned are those not yet given to Claude Code. Elapsed time
   * authorizes nothing: at the bound the command is named as still running, and the next end of the turn waits again.
   */
  type BackgroundWait = Readonly<{ kind: "none" }> | Readonly<{ kind: "ended"; ends: readonly NamedEnd[] }> | Readonly<{ kind: "bound"; names: readonly string[] }>;
  type BackgroundRefs = Readonly<{ stop: Ref.Ref<Stop | null>; state: Ref.Ref<BackgroundState>; names: Ref.Ref<ReadonlyMap<string, string>>; delivered: Ref.Ref<number> }>;
  /** The refs of one attempt with the signal of its call, aborted when the call ends however it ends (W1-R1-1). */
  type WaitRefs = BackgroundRefs & Readonly<{ ended: AbortSignal }>;
  const callEnded = (refs: WaitRefs): Effect.Effect<boolean> => Effect.sync(() => refs.ended.aborted);
  const pendingNames = (refs: BackgroundRefs): Effect.Effect<readonly string[]> =>
    Effect.gen(function* () {
      const names = yield* Ref.get(refs.names);
      return [...(yield* Ref.get(refs.state)).pending].map((id) => taskName(names, id));
    });
  const said = (line: string): Effect.Effect<void, CallbackError> => ui.say(line).pipe(Effect.andThen(store.converse(`${line}\n\n`)));
  const untilEnded = (refs: WaitRefs, deadline: number): Effect.Effect<"ended" | "bound" | "callEnded"> =>
    Effect.gen(function* () {
      if (yield* callEnded(refs)) return "callEnded" as const;
      if (!waitingOn(yield* Ref.get(refs.state))) return "ended" as const;
      if ((yield* Clock.currentTimeMillis) >= deadline) return "bound" as const;
      yield* Effect.sleep(Duration.millis(BACKGROUND_POLL_MS));
      return yield* untilEnded(refs, deadline);
    });
  const backgroundWait = (refs: WaitRefs): Effect.Effect<BackgroundWait, CallbackError> =>
    Effect.gen(function* () {
      if ((yield* callEnded(refs)) || (yield* Ref.get(refs.stop)) !== null || !waitingOn(yield* Ref.get(refs.state))) return { kind: "none" } as const;
      yield* said(prompts.backgroundWaitLine(yield* pendingNames(refs)));
      const reached = yield* untilEnded(refs, (yield* Clock.currentTimeMillis) + plannerOptions.backgroundBoundMs);
      // A wait whose call has ended says nothing more: its line would reach the page after the call, perhaps in a later phase.
      if (reached === "callEnded" || (yield* callEnded(refs))) return { kind: "none" } as const;
      if (reached === "bound") {
        const names = yield* pendingNames(refs);
        yield* said(prompts.backgroundStillRunningLine(names));
        return { kind: "bound", names } as const;
      }
      const { ended } = yield* Ref.get(refs.state);
      const recorded = yield* Ref.get(refs.names);
      const ends = ended.slice(yield* Ref.modify(refs.delivered, (count) => [count, ended.length] as const)).map((end) => ({ end, name: taskName(recorded, end.taskId) }));
      yield* said(prompts.backgroundEndedLine(ends));
      return { kind: "ended", ends } as const;
    });
  /** Runs the wait inside a hook; an interruption or a failed callback, which end the call anyway, answer nothing. */
  const waitInHook = (refs: WaitRefs, inCallback: InCallback): Promise<BackgroundWait> => inCallback(backgroundWait(refs), { kind: "none" }).catch((): BackgroundWait => ({ kind: "none" }));
  /** The Stop hook: a turn that ends while a command runs is continued with the command's end (or that it still runs). */
  const waitAtStop =
    (refs: WaitRefs, inCallback: InCallback): HookCallback =>
    async () => {
      const wait = await waitInHook(refs, inCallback);
      switch (wait.kind) {
        case "none":
          return {};
        case "ended":
          return { decision: "block", reason: prompts.backgroundEndedText(wait.ends) };
        case "bound":
          return { decision: "block", reason: prompts.stillRunningText(wait.names) };
      }
    };
  /** The hook on the structured output: no report is accepted while a command Claude Code started runs, however long. */
  const waitAtReport =
    (refs: WaitRefs, inCallback: InCallback): HookCallback =>
    async (input) => {
      const pre = input as PreToolUseHookInput;
      const wait = await waitInHook(refs, inCallback);
      const denied = (reason: string) => ({ hookSpecificOutput: { hookEventName: pre.hook_event_name, permissionDecision: "deny" as const, permissionDecisionReason: reason } });
      switch (wait.kind) {
        case "none":
          return {};
        case "ended":
          return denied(`${prompts.REPORT_WHILE_RUNNING_DENIED} ${prompts.backgroundEndedText(wait.ends)}`);
        case "bound":
          return denied(prompts.stillRunningText(wait.names));
      }
    };

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
        const attempt = (n: number): Effect.Effect<ExecCallOutcome, CallbackError | ClaudeSessionTooLong | TransportFault | UsageLimited | ProcessEnded> =>
          Effect.gen(function* () {
            // Issue #154: each attempt's background tasks start afresh, since the SDK's level signal is per process.
            const refs: BackgroundRefs = { stop, state: yield* Ref.make(NO_BACKGROUND), names: yield* Ref.make<ReadonlyMap<string, string>>(new Map()), delivered: yield* Ref.make(0) };
            const timeout = prompts.BACKGROUND_HOOK_TIMEOUT_SECONDS;
            const outcome = yield* call(
              session,
              n === 1 ? prompt : prompts.executionContinuePrompt,
              EXECUTION_PURPOSE,
              "text",
              {
                permissionMode: config.execPermissionMode,
                outputFormat: { type: "json_schema", schema: agentJsonSchema(S.ExecReport) },
                allowedTools: [prompts.REPORT_STEP_TOOL_NAME],
              },
              (inCallback) => executionPermission(stop, decider, inCallback),
              // report_step (issue #6, Q2): each report runs the phase's reporter; a failure to write aborts the call.
              // Issue #154: the Stop hook and the hook on the structured output wait for the call's background commands.
              (inCallback, ended) => ({
                mcpServers: { [prompts.REPORT_STEP_SERVER]: sdk.stepReporter((r) => inCallback(reporter(r.id, r.status), { text: prompts.STEP_NOT_RECORDED, isError: true })) },
                hooks: {
                  PreToolUse: [{ hooks: [denyAfterStop(stop)] }, { matcher: EDIT_TOOLS.join("|"), hooks: [denyPlanFileEdits] }, { matcher: "StructuredOutput", hooks: [waitAtReport({ ...refs, ended }, inCallback)], timeout }],
                  Stop: [{ hooks: [waitAtStop({ ...refs, ended }, inCallback)], timeout }],
                },
              }),
              (message) => Ref.update(refs.state, (state) => foldBackground(state, message)).pipe(Effect.andThen(Ref.update(refs.names, (names) => nameTasks(names, message)))),
            );
            const recorded = yield* Ref.get(stop);
            // Issue #157: the one classification with the process ending; callFailure classifies without it.
            const classified = outcome.error === null ? null : classifyClaude(outcome.failure);
            const kind = classified === null ? null : classified.kind;
            // Issue #122: a session too long to accept halts the run, whatever was recorded before it; never retried.
            if (kind === "contextTooLong") return yield* Effect.fail(new ClaudeSessionTooLong({ message: outcome.error ?? "" }));
            // Issue #68: a usage limit with a stated reset is waited out like a transport fault is retried, under the
            // same conditions; a valid report before either stands. Issue #157: so is a process that ended.
            const temporary = kind === "transport" || kind === "limited";
            const unreported = recorded === null && execReport(outcome.structured) === null;
            if (classified !== null && classified.kind === "processEnded" && unreported) {
              return yield* Effect.fail(new ProcessEnded({ agent: "claude", message: outcome.error ?? "", end: classified.end, attempts: n }));
            }
            if (temporary && unreported) {
              return yield* Effect.fail(callFailure(outcome.error ?? "", outcome.failure) as TransportFault | UsageLimited);
            }
            // Issue #154: a report made while a command Claude Code started still runs is never the call's end.
            const names = yield* Ref.get(refs.names);
            return checkBackground(interpretExecution(outcome, recorded, temporary || kind === "processEnded"), recorded, yield* Ref.get(refs.state), (id) => taskName(names, id));
          });
        // The retry lives here, where the call's session, stop and reporter are (P2-R2-1): no TransportFault leaves.
        // Issue #157: nor does a ProcessEnded, which becomes the call's outcome once its retries are used up.
        return yield* withTransportRetry("claude", EXECUTION_PURPOSE, prompts.TRANSPORT_WHAT_EXECUTION, attempt, Effect.void).pipe(
          Effect.catchTag("ProcessEnded", (e) => Effect.succeed<ExecCallOutcome>({ status: "processEnded", end: e.end, attempts: e.attempts, fault: e.message })),
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
export const makeClaudePlanner: Effect.Effect<PlannerShape, never, Sdk | Ui | Store | RunConfig> = makeClaudePlannerWith({ backgroundBoundMs: prompts.BACKGROUND_WAIT_BOUND_MS });

export const claudePlannerLayer: Layer.Layer<Planner, never, Sdk | Ui | Store | RunConfig> = Layer.effect(Planner, makeClaudePlanner);

// The phase Bring Up to Date (issue #216): before any question of a refinement, Codex checks the issue's title and text
// against the project as it is now, Claude Code corrects its statements of fact, and the loop goes on until a check
// raises no counted point. An Effect module over the services and the Tracker port. It reads the issues the item cites
// and writes the phase's records; it writes nothing to the tracker: the refinement run and the preparation write the
// outcome, each through its own tracker environment.
import { Effect } from "effect";
import { type CitationForm, citationFormOf, type CitedIssue, citedIdsOf, citedIssuesMarkdown, NO_URL_FORM } from "./citations.ts";
import { isTrackerError, type RunError, trackerFailureText } from "./errors.ts";
import { changeCounts, changeMarkdown, initialProtection, type UpdateOutcome, updateOutcomeOf } from "./issueUpdate.ts";
import * as prompts from "./prompts.ts";
import type { ItemText } from "./refinement.ts";
import { reviewLoop } from "./review.ts";
import { Planner, RunConfig, type Services, Store, Tracker, Ui } from "./services.ts";
import { updateSubject } from "./subjects.ts";
import type { ItemId } from "./tracker.ts";
import { readCitedWithRetry, type TrackerRetryEnv, unattendedTrackerEnv } from "./trackerRetry.ts";

/**
 * The issues the item cites and those they cite, two levels in all (requirements Q6): each read once with the tracker
 * retry and no question, the item itself never; one that cannot be read is Unreadable with its reason.
 */
export const readCitedIssues = (item: ItemId, before: ItemText, form: CitationForm, env: TrackerRetryEnv): Effect.Effect<readonly CitedIssue[], RunError, Tracker> =>
  Effect.gen(function* () {
    const tracker = yield* Tracker;
    const quiet = unattendedTrackerEnv(env);
    const readOne = (id: ItemId): Effect.Effect<CitedIssue, RunError> =>
      readCitedWithRetry(tracker, id, quiet).pipe(
        Effect.map((cited): CitedIssue => ({ _tag: "Read", ...cited })),
        Effect.catchIf(isTrackerError, (error) => Effect.succeed<CitedIssue>({ _tag: "Unreadable", id, reason: trackerFailureText(error) })),
      );
    const first = yield* Effect.forEach(citedIdsOf(`${before.title}\n${before.text}`, form, [item]), readOne);
    const tried = [item, ...first.map((c) => c.id)];
    const secondIds = [...new Set(first.flatMap((c) => (c._tag === "Read" ? citedIdsOf(`${c.title}\n${c.body}`, form, tried) : [])))];
    const second = yield* Effect.forEach(secondIds, readOne);
    return [...first, ...second];
  });

/**
 * The phase: its records (the issue as read, issue.json with the protection baseline, cited-issues.md), the loop on a
 * Claude Code session of its own, and its outcome said and written, the change shown with the points that caused it.
 */
export const bringUpToDate = (item: ItemId, before: ItemText, env: TrackerRetryEnv): Effect.Effect<UpdateOutcome, RunError, Services | Tracker> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    const config = yield* RunConfig;
    const sayAndWrite = (line: string) => Effect.andThen(ui.say(line), store.converse(`${line}\n\n`));
    yield* ui.notify({ _tag: "PhaseBegan", phase: { kind: "update" } });
    yield* sayAndWrite(prompts.updateBeganLine(item));
    const cited = yield* readCitedIssues(item, before, config.tracker === null ? NO_URL_FORM : citationFormOf(config.tracker), env);
    yield* store.saveCitedIssues(citedIssuesMarkdown(cited));
    for (const c of cited) if (c._tag === "Unreadable") yield* sayAndWrite(prompts.citedUnreadableLine(c.id, c.reason));
    yield* store.saveIssueBefore(before);
    yield* store.saveIssue({ version: 2, title: before.title, text: before.text, outcome: { kind: "current" }, developer_passages: [], protected: [...initialProtection(before)] });

    const planner = yield* Planner;
    const session = yield* planner.fresh;
    const end = yield* Effect.provideService(reviewLoop(updateSubject()), Planner, session);
    const file = yield* store.loadIssue();
    const outcome = updateOutcomeOf(before, file, end.result === "converged" ? "agreed" : "notAgreed");
    switch (outcome._tag) {
      case "Unchanged":
        yield* sayAndWrite(prompts.UPDATE_UNCHANGED_LINE);
        break;
      case "NotAgreed":
        yield* sayAndWrite(prompts.UPDATE_NOT_AGREED_LINE);
        break;
      case "Obsolete":
        yield* sayAndWrite(prompts.updateObsoleteLine(outcome.reason));
        break;
      case "Amended": {
        const counts = changeCounts(before, outcome.text);
        yield* ui.say(prompts.updateAmendedLine(counts.added, counts.removed));
        const points = (yield* store.loadLog("update")).filter((e) => e.source === "review" && !e.superseded && (e.action === "accepted" || e.action === "partially_accepted"));
        yield* store.converse(`## ${prompts.UPDATE_PHASE}: the issue brought up to date\n\n${prompts.updateAmendedLine(counts.added, counts.removed)}\n\n${changeMarkdown(before, outcome.text, points)}\n\n`);
        break;
      }
    }
    yield* ui.notify({ _tag: "PhaseEnded", phase: { kind: "update" }, result: end.result });
    return outcome;
  });

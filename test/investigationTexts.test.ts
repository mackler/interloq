// Issue #38: the texts and data of the investigation before a disagreement is put to the developer, and the validation
// of the investigation turn, with its prompts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result, Schema } from "effect";
import * as prompts from "../src/prompts.ts";
import { PresentedQuestionSchema } from "../src/protocol.ts";
import { pauseOriginOf, type PauseFacts } from "../src/question.ts";
import { investigationValidation } from "../src/round.ts";
import * as S from "../src/schema.ts";
import { TEST_ROOT } from "./helpers.ts";

const text = (s: string) => s as S.PositionText;
const resolution = (t: string, changes: string[] = []): S.Resolution => ({ text: text(t), changes: changes.map(text) });
const disposition = (id: string, action: S.Action, rationale = "r"): S.Disposition => ({ id, action, rationale, duplicate_of: "", reverses: "", concern: "c", remedy: "m", resolution: null });
const response = (dispositions: readonly S.Disposition[], self_corrections: readonly S.SelfCorrection[] = [], reviewer_feedback = ""): S.PlannerResponse => ({ dispositions, self_corrections, reviewer_feedback, questions_for_user: [] });

test("the three record labels are distinct, and the resolution's is never shown as a label of an outcome", () => {
  const labels = [prompts.REVIEWER_POSITION, prompts.PLANNER_POSITION, prompts.RESOLUTION_POSITION];
  assert.equal(new Set(labels).size, 3);
  for (const kind of prompts.DISPUTED_PAUSE_KINDS) {
    const shown = prompts.positionLabels(kind, "review");
    assert.equal(shown.resolution, "Make the change that meets both concerns", kind);
    assert.ok(!labels.includes(shown.resolution));
    assert.equal(new Set([shown.reviewer, shown.planner, shown.resolution]).size, 3, kind);
  }
  assert.ok((prompts.DISPUTED_PAUSE_KINDS as readonly string[]).includes("authorityResolution"));
  assert.deepEqual(prompts.positionLabels("authorityResolution", "review"), { reviewer: "Make the change the point asks for", planner: "Keep the file under review as it is now", resolution: "Make the change that meets both concerns" });
});

test("resolutionDescription states the resolution and names every change it would make", () => {
  assert.equal(prompts.resolutionDescription(resolution("Keep both steps.")), "Keep both steps.");
  const named = prompts.resolutionDescription(resolution("Keep both steps.", ["requirement 2", "behavior 7"]));
  assert.ok(named.startsWith("Keep both steps."));
  for (const change of ["requirement 2", "behavior 7"]) assert.ok(named.includes(change), named);
  assert.match(named, /It would change/);
});

test("outcomeLabelsRule names the third option only where the question offers one", () => {
  assert.doesNotMatch(prompts.outcomeLabelsRule(false), /third/);
  assert.match(prompts.outcomeLabelsRule(true), /third/);
  assert.match(prompts.outcomeLabelsRule(true), /both concerns/);
});

test("the investigation's lines and prompts name the ids they concern", () => {
  const ids = ["P1-R2-1", "P1-R2-3"];
  for (const t of [prompts.investigationLine(prompts.INVESTIGATION_HEADING, ids, "review"), prompts.investigationNote(ids), prompts.investigationPrompt(TEST_ROOT, "plan.json", 2, ids)]) for (const i of ids) assert.ok(t.includes(i), t);
  assert.ok(prompts.resolutionAgreedLine(prompts.RESOLUTION_AGREED_HEADING, "P1-R2-1", "Keep both steps.").includes("Keep both steps."));
  assert.ok(prompts.investigationPrompt(TEST_ROOT, "plan.json", 2, ids).includes(S.RESOLUTION_FIELD));
  assert.match(prompts.investigationTurnHeading(2), /2/);
});

test("investigationValidation accepts a change on a named id and refuses one on another id, its prompt naming the ids", () => {
  const previous = response([disposition("A", "rejected"), disposition("B", "rejected")]);
  const named = response([{ ...disposition("A", "partially_accepted", "resolved"), resolution: { text: "both", changes: [] } }, disposition("B", "rejected")]);
  assert.ok(Result.isSuccess(investigationValidation<S.PlannerResponse>(previous, ["A"])(named)));
  const other = response([disposition("A", "rejected"), disposition("B", "accepted")]);
  const refused = investigationValidation<S.PlannerResponse>(previous, ["A"])(other);
  assert.ok(Result.isFailure(refused));
  assert.deepEqual((refused.failure.error as { changedIds: readonly string[] }).changedIds, ["B"]);
  assert.ok(refused.failure.repair.includes("A") && refused.failure.repair.includes("B"), refused.failure.repair);
  assert.ok(Result.isFailure(investigationValidation<S.PlannerResponse>(previous, ["A"])(response(previous.dispositions, [], "new feedback"))));
});

test("an authorityResolution origin, built by pauseOriginOf, crosses the protocol", () => {
  const facts: PauseFacts = { pause: "authorityResolution", id: "P1-R2-1", history: [], resolution: resolution("both", ["requirement 2"]), taskDispute: false, effects: null };
  const origin = { kind: "pause" as const, heading: "Planning", pass: "review" as const, ...pauseOriginOf(facts) };
  const question = { number: 1, origin, context: { blocks: [], by: "program" }, history: [], explanations: [], question: [], options: [], attached: null, decision: null };
  const decoded = Schema.decodeUnknownResult(PresentedQuestionSchema)(JSON.parse(JSON.stringify(question)));
  assert.ok(Result.isSuccess(decoded));
  assert.deepEqual(decoded.success.origin, origin);
  assert.ok(prompts.isDisputedPause(origin));
});

test("a disputed pause's details show both agents' concerns and remedies, and a history entry shows its positions (W1-R1-3)", async () => {
  const { pauseProse } = await import("../src/render.ts");
  const { blocksText } = await import("../src/pieces.ts");
  const { reviewEntry } = await import("./resolutionFixtures.ts");
  const codex = { concern: text("codex concern X"), remedy: text("codex remedy X") };
  const claude = { concern: text("claude concern Y"), remedy: text("claude remedy Y") };
  const entry = reviewEntry("A", "rejected", { reviewer_position: codex, planner_position: claude });
  const shown = (facts: PauseFacts): string => blocksText(pauseProse(facts)).join("\n");
  const issue = { id: "A", severity: "major" as const, location: "l", problem: "p", evidence: "e", concern: "codex concern X", remedy: "codex remedy X" };
  const reraised = shown({ pause: "reraised", id: "A", history: [], issue, planner: claude, taskDispute: false, effects: null });
  const disputed = shown({ pause: "disputedSelfCorrection", id: "A", explanation: "wrong", history: [], reviewer: codex, planner: claude, taskDispute: false, effects: null, resolution: null });
  const history = shown({ pause: "authorityResolution", id: "A", history: [entry], resolution: resolution("both"), taskDispute: false, effects: null });
  for (const [name, t] of [["reraised", reraised], ["disputed", disputed], ["history", history]] as const)
    for (const want of ["codex concern X", "codex remedy X", "claude concern Y", "claude remedy Y"]) assert.ok(t.includes(want), `${name}: ${want} in\n${t}`);
});

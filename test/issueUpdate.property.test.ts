import { test } from "node:test";
import fc from "fast-check";
import { Result } from "effect";
import { initialProtection, issueUpdateValidation, protectionAfterDecisions, protectionAfterResponse, protectedPassagesOf, updateOutcomeOf } from "../src/issueUpdate.ts";
import { itemTextOf, type ItemText } from "../src/refinement.ts";
import type * as S from "../src/schema.ts";

const RUNS = { numRuns: 200, seed: 20261102 };
const word = fc.stringMatching(/^[a-z]{1,6}$/u);
const phrase = fc.array(word, { minLength: 2, maxLength: 4 }).map((ws) => `"${ws.join(" ")}"`);
const arbText = fc.array(fc.oneof(word, phrase, fc.constant("\n")), { maxLength: 10 }).map((ps) => ps.join(" "));
const arbTitle = fc.array(fc.oneof(word, phrase), { minLength: 1, maxLength: 4 }).map((ps) => ps.join(" "));
const arbItem: fc.Arbitrary<ItemText> = fc.tuple(arbTitle, arbText).map(([t, b]) => Result.getOrThrow(itemTextOf(t, b)));
const reply = (t: ItemText, passages: readonly string[]): S.UpdateResponse => ({ dispositions: [], self_corrections: [], reviewer_feedback: "", questions_for_user: [], issue: { title: t.title, text: t.text }, outcome: { kind: "current" }, developer_passages: [...passages] });

test("a reply keeping every protected passage, in either field, passes that rule; removing one fails it", () => {
  fc.assert(fc.property(arbItem, fc.boolean(), (before, inTitle) => {
    const p = { before, protected: initialProtection(before) };
    const all = p.protected.join(" ");
    const kept = Result.getOrThrow(itemTextOf(inTitle ? `x ${all}`.replace(/\n/gu, " ") : "x", inTitle ? "" : all));
    if (!Result.isSuccess(issueUpdateValidation(p)(reply(kept, [])))) return false;
    if (p.protected.length === 0) return true;
    const dropped = Result.getOrThrow(itemTextOf("x", p.protected.slice(1).join(" ")));
    const r = issueUpdateValidation(p)(reply(dropped, []));
    return Result.isFailure(r) || p.protected.slice(1).some((q) => q.includes(p.protected[0]!));
  }), RUNS);
});

test("initialProtection holds every detected passage of either field", () => {
  fc.assert(fc.property(arbItem, (t) => [...protectedPassagesOf(t.title), ...protectedPassagesOf(t.text)].every((q) => initialProtection(t).includes(q))), RUNS);
});

test("protectionAfterResponse never loses an entry, and after decisions every non-empty after is protected", () => {
  fc.assert(fc.property(arbItem, fc.array(phrase, { maxLength: 3 }), fc.array(fc.tuple(phrase, fc.oneof(phrase, fc.constant(""))), { maxLength: 3 }), (before, passages, pairs) => {
    const p = { before, protected: initialProtection(before) };
    const next = protectionAfterResponse(p, reply(before, passages));
    const decided = protectionAfterDecisions(p, { issue: { title: before.title, text: before.text }, outcome: { kind: "current" }, developer_passages: [], decided: pairs.map(([b, a]) => ({ before: b, after: a })), questions_for_user: [] });
    return p.protected.every((q) => next.includes(q)) && passages.every((q) => next.includes(q)) && pairs.every(([, a]) => a === "" || decided.includes(a));
  }), RUNS);
});

test("updateOutcomeOf: agreed and equal is Unchanged, obsolete wins, not agreed is NotAgreed", () => {
  fc.assert(fc.property(arbItem, arbItem, fc.boolean(), fc.constantFrom("agreed", "notAgreed") as fc.Arbitrary<"agreed" | "notAgreed">, (before, after, obsolete, ended) => {
    const file: S.IssueFile = { version: 2, title: after.title, text: after.text, outcome: obsolete ? { kind: "obsolete", reason: "built" } : { kind: "current" }, developer_passages: [], protected: [] };
    const out = updateOutcomeOf(before, file, ended);
    if (ended === "notAgreed") return out._tag === "NotAgreed";
    if (obsolete) return out._tag === "Obsolete";
    const same = before.title === after.title && before.text === after.text;
    return same ? out._tag === "Unchanged" : out._tag === "Amended" && out.text.title === after.title && out.text.text === after.text;
  }), RUNS);
});

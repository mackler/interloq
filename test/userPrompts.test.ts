import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { parseAskLine, parseMessage } from "../src/input.ts";
import * as prompts from "../src/prompts.ts";
import { HINTS, promptOf, type UserPrompt } from "../src/userPrompts.ts";

const quits = (p: UserPrompt, sends: string): boolean => (p.mode === "ask" ? parseAskLine(sends).kind === "quit" : parseMessage(sends).kind === "quit");
const labels = (p: UserPrompt): string[] => p.choices.map((c) => `${c.label}=${c.sends}`);

// Every text of the catalog, with the entry it must map to. S8: the options of a question (a pause's positions, the
// limit's proceed and stop, a permission's allow and deny) come with the question, not with the prompt text.
const catalog: [string, Partial<UserPrompt> & { kind: UserPrompt["kind"] }, string[]][] = [
  [prompts.decisionPrompt, { kind: "decision", mode: "ask", free: "line" }, ["Continue without deciding=", "End the run=q"]],
  [prompts.limitPrompt, { kind: "limit", mode: "ask", free: "line" }, ["End the run=q"]],
  [prompts.limitNoProceedPrompt, { kind: "limitNoProceed", mode: "ask", free: "line" }, ["End the run=q"]],
  [prompts.unchangedPrompt, { kind: "unchanged", mode: "ask", free: "none" }, ["End the run=q"]],
  [prompts.transportPrompt, { kind: "transport", mode: "ask", free: "none" }, ["End the run=q"]],
  [prompts.execInputPrompt, { kind: "execInput", mode: "ask", free: "line" }, ["End the run=q"]],
  [prompts.optionOrTextPrompt, { kind: "optionOrText", mode: "ask", free: "line" }, ["End the run=q"]],
  [prompts.permissionPrompt, { kind: "permission", mode: "ask", free: "none" }, ["End the run=q"]],
  [prompts.interviewMessagePrompt, { kind: "interviewMessage", mode: "message", free: "message" }, ["Finish clarification and start planning=/done", "End the run=/quit"]],
  [prompts.confirmSummaryPrompt, { kind: "confirmSummary", mode: "message", free: "message" }, ["Confirm=", "End the run=/quit"]],
];

for (const [text, expected, choices] of catalog) {
  test(`promptOf maps the ${expected.kind} text to its widget`, () => {
    const p = promptOf(text);
    assert.equal(p.kind, expected.kind);
    for (const [key, value] of Object.entries(expected)) assert.equal(p[key as keyof UserPrompt], value, key);
    assert.deepEqual(labels(p), choices);
    assert.equal(p.text, text);
  });
}

// S8, the seam: the text each kind's prompt shows is the text promptOf recognizes it by, both from src/prompts.ts; no
// two kinds share a text, and the catalog above covers every kind.
test("every kind's hint is recognized as that kind, and no two kinds share a hint", () => {
  for (const [kind, hint] of Object.entries(HINTS)) {
    assert.equal(promptOf(hint).kind, kind);
    assert.equal(promptOf(prompts.withOffer(hint)).kind, kind);
  }
  assert.equal(new Set(Object.values(HINTS)).size, Object.keys(HINTS).length);
  assert.deepEqual(catalog.map(([, e]) => e.kind).sort(), Object.keys(HINTS).sort());
});

test("an unknown text is free text plus Quit", () => {
  assert.deepEqual(labels(promptOf("Something new > ")), ["End the run=q"]);
  assert.equal(promptOf("Something new > ").free, "line");
});

test("promptOf never throws and always offers exactly one Quit that its input mode reads as quitting", () => {
  const texts = fc.oneof(
    fc.string(),
    fc.constantFrom(...catalog.map(([t]) => t)),
    fc.constantFrom(...catalog.map(([t]) => prompts.withOffer(t))),
  );
  fc.assert(
    fc.property(texts, (text) => {
      const p = promptOf(text);
      const quit = p.choices.filter((c) => c.label === prompts.END_RUN_LABEL);
      return quit.length === 1 && quits(p, quit[0].sends) && p.choices.filter((c) => c.label !== prompts.END_RUN_LABEL).every((c) => !quits(p, c.sends));
    }),
  );
});

// Decision support, plan step 3.2: the offer is a property of the prompt text (D1).
test("a prompt with the offer line has the entry of its text plus Help me decide before Quit; without the line nothing changes", () => {
  for (const [text, expected, choices] of catalog) {
    const offered = promptOf(prompts.withOffer(text));
    assert.equal(offered.kind, expected.kind);
    assert.equal(offered.text, prompts.withOffer(text));
    assert.deepEqual(labels(offered), [...choices.slice(0, -1), `${prompts.HELP_ME_DECIDE}=/decide`, choices[choices.length - 1]]);
    assert.ok(!labels(promptOf(text)).some((l) => l.startsWith(prompts.HELP_ME_DECIDE)), `${expected.kind} carries the offer without the line`);
  }
  assert.equal(prompts.pagePromptText("decision", prompts.withOffer(prompts.decisionPrompt)), "Choose an option, answer in your own words, or continue without deciding.");
  assert.equal(prompts.pagePromptText("unknown", prompts.withOffer("Something > ")), "Something");
});

// Issue #25 (S23): every control says what it does, in the user's words; each label is a constant of src/prompts.ts,
// the catalog holds no label of its own, and what each control sends is unchanged.
test("the controls' labels are the constants of src/prompts.ts, and none is a literal of src/userPrompts.ts", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../src/userPrompts.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /label: "/);
  assert.equal(prompts.END_CLARIFICATION, "Finish clarification and start planning");
  assert.equal(prompts.END_RUN_LABEL, "End the run");
  assert.equal(prompts.CONTINUE_WITHOUT_DECIDING, "Continue without deciding");
  assert.equal(prompts.HELP_ME_DECIDE, "Help me decide");
  assert.deepEqual([prompts.PERMISSION_ALLOW, prompts.PERMISSION_DENY], ["Allow this", "Do not allow this"]);
  assert.equal(prompts.LIMIT_STOP, "End the run");
  const sends = Object.values(HINTS).flatMap((h) => promptOf(h).choices.map((c) => c.sends));
  assert.deepEqual([...new Set(sends)].sort(), ["", "/done", "/quit", "q"]);
});

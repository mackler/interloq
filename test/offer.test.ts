// S8: every option shows the answer that chooses it, and that answer does choose it: through the option's own `matches`,
// and through the parser the run reads the answer with (the seam of the displayed text and the parsed text, P1-R1-4).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExtraRounds, parseTransportAnswer, parseUnchangedAnswer } from "../src/input.ts";
import { limitOptions, numberedOptions, type OfferedOption, permissionOptions, presentedQuestion, transportOptions, unchangedOptions } from "../src/offer.ts";
import * as prompts from "../src/prompts.ts";
import { answerOf } from "../src/input.ts";
import { para, plain } from "./helpers.ts";

/** The one option that an answer chooses. */
const chosen = (options: readonly OfferedOption[], answer: string): readonly string[] => options.filter((o) => o.matches(answer)).map((o) => o.label);
const token = (o: OfferedOption): string => {
  assert.ok("token" in o.answer, `${o.label} has no exact answer`);
  return o.answer.token;
};

test("a numbered option's answer is its number, which chooses it alone and stands for its label and description", () => {
  const options = numberedOptions([{ label: "SQLite", description: "a file" }, { label: "PostgreSQL", description: "a server" }]);
  for (const o of options) {
    assert.deepEqual(chosen(options, token(o)), [o.label]);
    assert.equal(answerOf(token(o), options), `${o.label}: ${o.description}`);
  }
});

test("a permission's options show y and n, and the permission reply reads y as allow and n as deny", () => {
  const [allow, deny] = permissionOptions;
  assert.deepEqual([token(allow), token(deny)], ["y", "n"]);
  assert.deepEqual(chosen(permissionOptions, token(allow)), [prompts.PERMISSION_ALLOW]);
  assert.deepEqual(chosen(permissionOptions, token(deny)), [prompts.PERMISSION_DENY]);
});

test("the unchanged pause's options show the answers parseUnchangedAnswer reads as their actions", () => {
  const options = unchangedOptions(false);
  const actions = ["retry", "proceed", "stop"] as const;
  options.forEach((o, i) => {
    assert.equal(parseUnchangedAnswer(token(o)), actions[i], o.label);
    assert.deepEqual(chosen(options, token(o)), [o.label]);
  });
});

test("the transport pause's options show the answers parseTransportAnswer reads as their actions", () => {
  const options = transportOptions();
  const actions = ["retry", "stop"] as const;
  options.forEach((o, i) => {
    assert.equal(parseTransportAnswer(token(o)), actions[i], o.label);
    assert.deepEqual(chosen(options, token(o)), [o.label]);
  });
});

test("the cycle limit: p proceeds, 0 stops, and More cycles takes a typed number, which parseExtraRounds reads as cycles", () => {
  const options = limitOptions(prompts.PROCEED_TO_IMPLEMENTATION);
  const [proceed, stop, more] = options;
  assert.equal(token(proceed), "p");
  assert.equal(token(stop), "0");
  assert.equal(parseExtraRounds(token(stop)), null, "0 adds no cycles: the review loop halts on it");
  assert.deepEqual(more.answer, { numeric: true });
  assert.deepEqual(chosen(options, "p"), [prompts.LIMIT_PROCEED]);
  assert.deepEqual(chosen(options, "0"), [prompts.LIMIT_STOP]);
  assert.deepEqual(chosen(options, "3"), [prompts.LIMIT_MORE]);
  assert.equal(parseExtraRounds("3"), 3);
  // Without a proceed choice, p is no option and stops like any other answer that is not a number.
  assert.deepEqual(limitOptions(null).map((o) => o.label), [prompts.LIMIT_STOP, prompts.LIMIT_MORE]);
});

test("presentedQuestion numbers the draft and keeps each option's answer, not its matcher", () => {
  const origin = { kind: "relayed" } as const;
  const q = presentedQuestion({ origin, context: { blocks: para("c"), by: "agent" }, explanations: [], question: plain("Which?"), options: permissionOptions, decision: null }, 7);
  assert.equal(q.number, 7);
  assert.deepEqual(q.options, [
    { label: plain(prompts.PERMISSION_ALLOW), description: plain(prompts.PERMISSION_ALLOW_DESCRIPTION), answer: { token: "y" } },
    { label: plain(prompts.PERMISSION_DENY), description: plain(prompts.PERMISSION_DENY_DESCRIPTION), answer: { token: "n" } },
  ]);
});

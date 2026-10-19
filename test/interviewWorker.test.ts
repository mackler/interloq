// Issue #184, work review 1 (W1-R1-1): the opening request of the first interview's worker is a request of its own, so
// an answer queued before the worker's first request still reaches Claude Code, in the next request, before the closing
// request.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Ref } from "effect";
import { INITIAL_CLARIFICATION } from "../src/clarificationState.ts";
import { makeInterviewWorker } from "../src/interviewWorker.ts";
import * as prompts from "../src/prompts.ts";
import { ASK } from "../src/retry.ts";
import type * as S from "../src/schema.ts";
import { Store } from "../src/services.ts";
import { questionEntry, summaryReply, tempRepo, testLayer } from "./helpers.ts";

const q = (id: string): S.QuestionEntry => questionEntry(id, `question ${id}?`, [["A", "a"], ["B", "b"]], { default_answer: "A", skip_if: null });

test("an answer queued before the worker's first request reaches Claude Code before the closing request", { timeout: 20_000 }, async () => {
  const SUMMARY = "# Requirements\n\nQ1: A.";
  const { layer, probe } = testLayer(tempRepo(), { closings: [{ output: summaryReply(SUMMARY) }] });
  const entry: prompts.ClarificationEntry = { kind: "agreed", id: "Q1", text: "A", option: "A" };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* Store).init("task");
      const state = yield* Ref.make(INITIAL_CLARIFICATION);
      const worker = yield* makeInterviewWorker({ questions: [q("Q1"), q("Q2")], state, heading: "You Decide", exhaustion: () => ASK });
      yield* worker.send(entry, []);
      // As clarification of src/conversation.ts does: the worker races the main fiber, so a halt of either ends the test.
      return yield* Effect.raceFirst(worker.run, worker.drain({ kind: "listDone" }));
    }).pipe(Effect.provide(layer)),
  );
  const sent = probe.planner.clarificationPrompts;
  const closing = sent.findIndex((p) => p.includes(prompts.LIST_DONE_SENTENCE));
  assert.ok(closing > 0, `no closing request after another: ${JSON.stringify(sent)}`);
  const line = prompts.clarificationRequestPrompt([entry], [], null);
  assert.ok(sent.slice(0, closing).some((p) => p.includes(line)), `the answer reached no request before the closing one: ${JSON.stringify(sent)}`);
  assert.equal(result.kind, "reply");
  assert.equal(result.kind === "reply" && result.reply.kind === "summary_proposed" ? result.reply.summary : null, SUMMARY);
});

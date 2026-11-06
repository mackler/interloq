# The page never worked with a question phase: two defects

## Context

The first real task run through the web page, a README for this project, froze at 23:03:18 today. The
page showed a partial transcript with the status chip still reading "connected"; a second tab showed
the start form with Start disabled and "A task is running". The run itself was healthy throughout and
is still waiting at the interview's first question, which no interface can answer, because this run's
Ui is the page.

Diagnosed to the field. A WebSocket client connected to the live server receives the correct frames:
`hello` with `current: 1`, then a 22 KB `replay`. Running that replay through `decodeServer` gives:

```
Expected no excess property
  at ["runs"][0]["events"][28]["event"]["response"]["questions"]
```

Event 28 is the `ResponseReceived` of question review round 1. Two separate faults produce the
symptom, and both are worth fixing.

**Defect A, the schema.** `src/uiEvents.ts:17` types `ResponseReceived.response` as `PlannerResponse`,
and `src/protocol.ts:55` encodes it as `S.PlannerResponse`. The question subject's response is a
`QuestionListResponse` (`src/schema.ts:65`), which is `PlannerResponse` plus `questions`. Decoding uses
`onExcessProperty: "error"`, so every run with a question phase breaks the page at the first response
of the question review, and stays broken for the rest of the run, replay included.

**Defect B, the silent drop.** `web/src/socket.ts:73`:

```ts
const decoded = decodeServer(String(event.data));
if (decoded._tag !== "Success") return;
```

An undecodable frame is discarded with no console error, no notice and no reconnect, so defect A
presented as a page that had simply stopped, while claiming to be connected. This is the class of
problem finding 2 named, an expected failure escaping the error algebra, at a different boundary.

**Why no test caught it.** Every web and end-to-end scenario runs without an interview: Codex's
finding 10 said exactly that ("their scenarios omit the interview"), and the two real page runs on
26 Sep used a scratch project whose `plan-review/config.json` set `questionPhase: false`. The page has
therefore never once carried a question phase, in a test or in a real run.

## Work, test first, one commit

1. **Defect B first, because it is what hid A.** Red in `web/src/socket.test.ts`: a frame that does not
   decode produces an observable consequence rather than silence. Give the socket's handlers an
   `onProtocolError`; the page turns it into a notice ("the page could not read a message from the
   server; reconnecting") and asks for a fresh connection, reusing the `needsReconnect` path that
   `web/src/state.ts` already has for a sequence gap. Observe: the fake socket delivers a bad frame
   and nothing happens.
2. **Defect A.** Red in `test/protocol.test.ts`: a `ResponseReceived` carrying a `QuestionListResponse`
   round-trips through `encodeServer`/`decodeServer`. Observe: `Expected no excess property at
   response.questions`. Then widen the event: `response: Schema.Union([S.PlannerResponse,
   S.QuestionListResponse])` in `src/protocol.ts`, and the same union in the `UiEvent` variant of
   `src/uiEvents.ts`. Check every other event whose payload is a subject-dependent shape for the same
   mistake, `ReviewReceived` in particular.
3. **The scenario that would have caught it.** Red in `web/src/state.test.ts`: folding a replay whose
   events include a question review's response and an `ClarificationTurn` yields both panels and a pending
   prompt. And in `e2e/run.spec.ts`, a scripted scenario with a question phase: the list, its review,
   one interview turn, an answer, and the requirements review. Finding 10's remedy named this
   scenario; it was deferred and this is the cost.
4. `npm test`, then a real run through the page with the question phase on, to the first interview
   answer at least. Update `docs/gui-review.md`'s Disposition rows for findings 2 and 10 to record
   that both recurred here, and add the two defects to CLAUDE.md's facts if anything about them
   surprises us on the rerun.

## Before any of it

Stop the stuck task from the page's Stop button. It cannot be answered and it holds the project. The
1.33 dollars and roughly 200,000 Codex tokens already spent are lost; the records stay in
`plan-review/` until the next run archives them, and `plan-review/question-review/` is the evidence.

## Verification

`npm test` green. A fresh tab opened during a run with a question phase shows the whole transcript and
the pending interview prompt. A deliberately corrupted frame produces a visible notice and a
reconnection rather than a frozen page.

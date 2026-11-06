# GUI and work-review review

Reviewed `ec6a1d4..364158b` against `task.txt`, `CLAUDE.md`, and the earlier functional-design review. This is eight commits, including stage 0 (`459521c`): the supplied range written as `459521c..364158b` would exclude that commit. The reported 98 files and 7,277 insertions are correct for the range starting after `ec6a1d4`.

**Verification.** `npm test` passed: type checking, 392 Node tests, 29 Vitest tests, the production build, and four Chromium end-to-end tests. Additional probes used temporary repositories, the production Effect services, scripted agents, and the built page in Chromium. No real agent was called. Browser probes using injected WebSocket messages are identified below; they exercise the actual built components, not a replacement UI. The only intentional repository source change is this report; the pre-existing untracked `task.txt` is untouched.

Severity describes impact: **High** affects the review contract or can strand/misdirect a run; **Medium** breaks a supported interaction or materially weakens verification; **Low** is a limited usability or documentation problem. Conditional risks are not claimed as failures observed in ordinary live use.

**Confirmed defects and verification gaps**

1. **High — Work-review responses can rewrite the plan without a new planning/review phase.** [src/review.ts:229](../src/review.ts#L229), [src/claude.ts:112](../src/claude.ts#L112), [src/subjects.ts:93](../src/subjects.ts#L93).

   The work subject goes through ordinary `planningCall`. Its SDK hook permits edits under `plan-review/`, and its snapshot excludes that directory. Thus behaviour 12's requirement that Claude answer without changing **any** file is only prompt text. In a temporary repository I supplied a work-response step that rejected `W1-R1-1` and replaced `plan.md`; the next work review converged, `runTask` returned 1, and the replacement plan remained on disk. Neither a guard nor a revision phase intervened. The same permissions expose requirements and review records to accidental edits. This is a missing enforcement mechanism, not evidence that a real agent has already exploited it.

   **Remedy:** Give work responses an explicit read-only call capability/policy, including repair calls. Deny editing tools and compare the relevant record files as well as the project after the call; the existing planning allowance must not apply. Add adapter and procedure tests that attempt to change `plan.md`, `requirements.md`, and the reviewed diff during a work response. This is the most consequential gap against behaviours 7, 8, and 12 and the earlier review's explicit-capability recommendations.

2. **Medium — Malformed URL encoding becomes an Effect defect instead of a handled input error.** [src/webServer.ts:21](../src/webServer.ts#L21), [src/webServer.ts:30](../src/webServer.ts#L30).

   `decodeURIComponent` runs directly inside a generator whose advertised error channel is `never`. A request to `/%ZZ` against the real scripted server returned HTTP 500. This is an expected external-input failure escaping the error algebra, the same class of problem as finding 10 of the functional-design review. It does not crash the whole server in this check.

   **Remedy:** Decode the request target with a `Result` or a typed `Effect.try`, then return a deliberate 400/404. Cover malformed percent escapes and invalid UTF-8 escapes, as well as the existing traversal examples; handle URL-construction failure at the same boundary.

3. **Medium — Optional browser persistence can prevent Start from working.** [web/src/components/StartForm.svelte:11](../web/src/components/StartForm.svelte#L11), [web/src/components/StartForm.svelte:20](../web/src/components/StartForm.svelte#L20).

   Both reading and writing `localStorage` may throw. The write happens before `onStart`, with no error handling. In Chromium, injecting a `Storage.setItem` that throws `SecurityError`, filling the task, and clicking Start produced an uncaught page error and left the form open without starting a task. A failed read can also break initial rendering. Remembering a directory should not be a prerequisite for running the program.

   **Remedy:** Put storage behind a small tested edge returning a typed result; fall back to the supplied directory when reading fails, and continue Start when remembering fails. Do not hide a failed task submission behind an uncaught exception. This is another regression against the earlier typed-error recommendation.

4. **Medium — The project validator accepts directories that the new baseline builder cannot handle.** [src/runManager.ts:60](../src/runManager.ts#L60), [src/store.ts:132](../src/store.ts#L132), [src/store.ts:138](../src/store.ts#L138).

   `git rev-parse --git-dir` accepts a subdirectory of a repository. Starting through the real manager with a temporary repository's `sub/` directory returned run id 1, then halted during initialization: `git rm --cached ... --pathspec-from-file=... --pathspec-file-nul` reported `fatal: '--pathspec-from-file' and pathspec arguments cannot be used together` (Git 2.47.3). The new baseline builder reaches this command when removing the records it just created. Existing tests use repository roots, so the directory browser can select a path that passes validation but immediately fails after initialization has begun.

   **Remedy:** Either explicitly require the worktree root and reject other directories before starting/archiving, with a useful explanation, or make tree construction and exclusions consistently aware of the repository prefix. Test the chosen contract through the manager, including a nested directory and a bare repository. Do not silently expand a selected subdirectory into a different project scope.

5. **Medium — Another tab's answer leaves the local draft attached to the next question.** [web/src/components/PromptWidget.svelte:10](../web/src/components/PromptWidget.svelte#L10), [web/src/components/App.svelte:63](../web/src/components/App.svelte#L63).

   `text` is cleared only by this component's own `send`. The component survives changes of `widget`; an `Answered` event from another tab does not reset it. In the built page, I typed `draft for question one`, delivered `Answered` for prompt 1 and `Asked` for prompt 2 over an injected WebSocket, and read exactly that draft from prompt 2's input. Pressing Enter would send the old answer under the new prompt id. This directly undermines the multi-tab requirement and error prevention.

   **Remedy:** Scope draft state to `(run id, prompt id)` and clear or explicitly withdraw it when that prompt is answered elsewhere. Preserve a draft across reconnection only when the same prompt remains pending. Add a two-tab browser test with an unsent draft in the losing tab.

6. **Medium — Enter commits an answer while an input method is still composing text.** [web/src/components/PromptWidget.svelte:27](../web/src/components/PromptWidget.svelte#L27), [web/src/components/PromptWidget.svelte:29](../web/src/components/PromptWidget.svelte#L29).

   Both handlers submit on Enter without checking `isComposing`. Dispatching an Enter keydown with `isComposing: true` in Chromium sent `{type: "answer", run: 1, prompt: 1, text: "unfinished composition"}` to the WebSocket. Input methods commonly use Enter to accept a candidate; that should not also answer an irreversible decision prompt.

   **Remedy:** Ignore composing Enter events and test composition separately from ordinary Enter and Shift+Enter. Provide a visible Send action for free text as well as the keyboard shortcut, with a persistent field label. The latter improves discoverability and touch use; the reproduced defect is premature submission.

7. **Medium — The fixed three-column layout makes the page unusable in a compact window.** [web/src/components/App.svelte:84](../web/src/components/App.svelte#L84), [web/src/components/TopBar.svelte:25](../web/src/components/TopBar.svelte#L25).

   The 14rem rail and two `1fr` panels have no adaptive layout. In the built page at 390 × 844, each chat panel measured 59 pixels wide; text wrapped approximately one character per line, the answer field was tiny, and the document overflowed horizontally to 407 pixels. I inspected the screenshot as well as measuring the DOM. This also affects narrow desktop windows and zoomed layouts. Using M3 colour tokens does not establish layout conformance: its canonical examples explicitly adapt the bar, rail, and panes across breakpoints. [Material Design layout examples](https://m3.material.io/foundations/layout/canonical-examples/overview).

   **Remedy:** Keep the requested side-by-side panels at suitable widths; collapse the rail and use stacked or selectable panels at compact widths. Adapt the top bar too. Add narrow-window and zoom-equivalent layout checks that assert usable input/panel dimensions, not merely that text nodes exist.

8. **Low — The web interview still teaches a terminal-only multiline convention.** [src/conversation.ts:23](../src/conversation.ts#L23), [web/src/state.ts:149](../web/src/state.ts#L149), [docs/ui-review.md:12](ui-review.md#L12).

   The interview begins with a `say` telling the user that `"""` on its own line starts and ends a multiline message. The page renders this as an ordinary program message, but its message input sends whole text through `parseMessage`; it never applies the terminal's `foldLine` protocol. Following that instruction in the page sends literal triple quotes to Claude. `pagePromptText` fixes the waiting prompts, not this introductory instruction, so the author's claim that terminal conventions have been removed is incomplete.

   **Remedy:** Represent interview help as a structured UI event with terminal and browser renderings, and keep its text in the prompt catalog. Test the complete interview opening in the page, not only individual prompt mappings.

9. **Medium — The new work-review property does not prove its advertised law, and its driver mismatches rounds.** [test/reviewState.property.test.ts:46](../test/reviewState.property.test.ts#L46), [test/reviewState.property.test.ts:142](../test/reviewState.property.test.ts#L142), [test/snapshot.property.test.ts:174](../test/snapshot.property.test.ts#L174).

   The property named “ends at the first correction due” checks decisions, duplicate log entries, and checkpoint prerequisites, but never checks that an accepted/partially accepted disposition or effective self-correction causes an immediate `revise`. It accepts any non-null halt when no decision is recorded. Moreover, the driver selects `script` using the old `currentRound` before handling `CallReviewer`, then advances `currentRound`: round 2's review can use script 1's issue count while its response uses script 2's count. That generates accidental `RoundInvalid` exits rather than the intended valid histories and reduces deeper policy coverage.

   The new exclusion property is weaker still: its oracle is literally `paths.filter(p => excluded(p, ignore))`, the implementation of `excludedIndexPaths`. It cannot detect an incorrect exclusion policy. In contrast, the browser's replay/live-fold equality is a meaningful consistency law, although it does not independently prove either fold's semantics or socket interleavings. Existing snapshot, round, and parsing laws retain useful independent assertions.

   **Remedy:** Correct script selection, generate valid response/review pairs by construction, and model the expected first exit independently. Assert no later agent command after a correction, and compare expected issue/log identities and pause precedence. Test exclusions against a separately specified path policy, including repository prefixes. Retain the strong example tests in `workReview.test.ts`; the finding concerns overclaiming the properties, not an absence of behavioural tests.

10. **Medium — The end-to-end suite can stay green while important page behaviour is broken.** [e2e/server.ts:18](../e2e/server.ts#L18), [e2e/run.spec.ts:19](../e2e/run.spec.ts#L19), [web/src/components.test.ts:1](../web/src/components.test.ts#L1).

    All four end-to-end tests passed alongside defects 3, 5, 6, and 7. Their scenarios omit the interview and have no accepted work-review issue; “converge” exercises an accepted **plan** issue followed by an empty work review. Reload tests reconstruction after a new page load, not an existing tab's dropped socket, queued actions, or an answer race. Stop interrupts a scripted planner rather than checking cancellation of both real adapters over the fake SDK in the browser scenario. Component tests mount five components but do not directly exercise `App` integration or `ChatPanel` scrolling; the existing browser tests use short transcripts. They also do not fail on every uncaught page error.

    **Remedy:** Add a small set of behavioural browser scenarios: an interview through confirmation, a work correction through planning/execution 2, two-tab draft/answer handling, actual connection loss and replay, and a long scrollable transcript. Listen for uncaught page errors and assert observable recovery. Test compact layout and composition as above. A targeted long-transcript probe here did confirm that scrolling up preserves position and shows the new-message chip; that positive result should become a regression test. The current suite is useful smoke coverage, not evidence for all claims in `docs/ui-review.md`.

**Conditional risks**

11. **High — Cancellation between state reservation and completion can strand a run or an answer.** [src/runManager.ts:82](../src/runManager.ts#L82), [src/runManager.ts:100](../src/runManager.ts#L100), [src/webUi.ts:61](../src/webUi.ts#L61), [src/webServer.ts:69](../src/webServer.ts#L69).

    Start reserves `current` before broadcasting `Started`, installing the fiber, and releasing its gate. Answer removes the pending entry before publishing `Answered` and completing its `Deferred`. These are multiple interruptible steps, even though each individual `Ref.modify` is atomic. The server executes them in a connection's scope.

    Deterministic probes with a deliberately blocking listener/sink reproduced both gaps. Interrupting Start during delivery left `current = 1`; Stop replied “the run is starting; try again” forever, and a new Start was refused. Interrupting Answer during delivery left `pending = null`, a rejected retry, and an unresolved asking fiber. The production listener currently only offers to an unbounded queue, so these probes demonstrate unsafe interruption boundaries, not an observed normal-network frequency. Scheduling/preemption or future asynchronous delivery can expose them.

    **Remedy:** Make each ownership transfer an explicitly cancellation-safe transaction, with rollback/finalization where needed. Keep slow external work outside the protected region. Serialize event publication if delivery order is part of the contract. Add interruption-injection tests at each transition, including connection closure, and prove that the next Start/answer or Stop can recover. Typed `Ref` state alone does not solve this lifecycle problem.

12. **High — Run ids can be reused after a server restart, allowing a queued action to target a different task.** [src/runManager.ts:48](../src/runManager.ts#L48), [web/src/socket.ts:49](../web/src/socket.ts#L49), [src/protocol.ts:24](../src/protocol.ts#L24).

    The manager restarts numbering at 1; the browser retains queued answers/stops and validates them only against `hello.current`. If a tab queues Stop for old run 1, the server restarts, and another tab starts new run 1 before the first reconnects, the queued Stop passes the guard and interrupts the unrelated task. Prompt numbers also restart, so an old answer can match a new run's prompt. This follows directly from the protocol and queue checks; I did not reproduce a process-restart race with live agents.

    **Remedy:** Include a server-incarnation/run identity that cannot be reused across restarts, and bind both prompts and queued commands to it. Discard old-incarnation actions with an explicit notice. Test a reconnect where the numeric run and prompt ids match but their incarnation differs. Preserving records without supporting resume does not justify treating two tasks as the same task.

13. **Medium — Whole-run replay has unbounded buffering and quadratic copying costs.** [src/runManager.ts:56](../src/runManager.ts#L56), [src/webServer.ts:53](../src/webServer.ts#L53), [web/src/state.ts:81](../web/src/state.ts#L81).

    Every event copies the growing run array; chat messages copy growing panel arrays; each tab has an unbounded forwarding queue. Tool activity is retained even though the page displays only its latest value. Long agent sessions or slow readers can therefore accumulate substantial memory and copying work. This is a capacity risk inferred from the implementation, not a measured out-of-memory failure. Retaining only the current and last run limits run count, not run size.

    **Remedy:** Preserve the promised full transcript using chunked/persistent storage and incremental replay, and define slow-client handling that closes/replays rather than growing a queue indefinitely. Keep activity state separate where loss of intermediate activity is acceptable under an explicit protocol decision. Measure a long scripted run before selecting limits; do not silently truncate the required conversation.

**Design tradeoffs**

14. **Low — Mutable resources at the edge are justified, but the sanitizer's shared configuration has implicit ownership.** [web/src/markdown.ts:7](../web/src/markdown.ts#L7), [web/src/socket.ts:40](../web/src/socket.ts#L40), [src/runManager.ts:44](../src/runManager.ts#L44).

    The new pure reducers, readonly event variants, validated rounds, and service-injected work-review interpreter largely preserve the functional-design improvements. Socket callbacks, SDK stream builders, and manager `Ref`s are resource-owning edges; replacing every local array builder or sequential loop with recursion would not improve correctness. The material problems are the lifecycle and error boundaries above.

    One avoidable exception is `DOMPurify.addHook` on an imported singleton at module load. It mutates shared library configuration before an explicitly constructed renderer owns it; future consumers can affect one another. No sanitizer bypass was found, and the Markdown tests passed. **Remedy:** Construct a private sanitizer/renderer at the browser boundary and inject or close over it, documenting that edge explicitly. Treat M3's estimated progress indicator and text phase glyphs as documented visual compromises, not correctness defects; test their status and reduced-motion behaviour if relying on those claims.

**Assessment against the requested standards**

The central work-review flow is implemented coherently: it runs after finished, needs-input, and aborted execution outcomes; stop input is recorded before it; it has its own subject/thread/log; accepted issues and effective self-corrections leave for revision; the work round limit has no proceed option; completion requires both finished execution and convergence. The tests verify several difficult decision exits with `readCheckpoint`, and both recomputed work content and `changes.diff` bytes are guarded during Codex turns, including repair. The existing execution stop hook still permits only `StructuredOutput` after the stop. These are substantive behavioural tests, not merely lines executed. Finding 1 qualifies the read-only response contract; finding 11 qualifies cancellation robustness. I found no new regression in unique dispositions, supersession, safe integer parsing, or the established usage aggregation.

The recommendations to keep a pure core and narrow effects to edges have mostly survived. Expected browser/HTTP exceptions and cancellation ownership are the notable regressions. Returning readonly records is helpful; it does not make a sequence of effects atomic. Tests of event sequences and persisted artifacts provide substantially more assurance than a count of test files.

The rule audit has limits. Commit messages record the required observed red failures for the application stages, but final commits cannot independently prove that every implementation edit followed a failing test. Some recorded reds (notably stage 5's empty scenario scripts) prove that the harness needs valid fixtures, not that it detects a broken page. Both TypeScript configurations enforce erasable syntax and checks passed. Agent and waiting-prompt texts are centralized; finding 8 identifies remaining interface-specific help outside that model. Dependencies added in this range match the current explicitly permitted list and pin tests; the original task alone is not evidence that the later documented library approvals were unauthorized. The Effect ledger covers the major added APIs, including `forkDetach`, `Ref.modify`, and WebSocket acquisition ordering, but its new `NodeHttpServer.layer`/`layerTest` row at [docs/effect-v4-api.md:274](effect-v4-api.md#L274) omits the declaration line numbers required by the literal rule; fill those in when updating the ledger. Test coverage is not limited to directly imported component files—some are exercised by Playwright—but finding 10 explains the remaining behavioural gaps. No claim is made that all non-wiring code is adequately tested merely because the suite passes.

I partially agree with `docs/ui-review.md`: the authorship separation, readable reviews, status rail, fixed-choice buttons, direct Stop, default directory, and introductory task explanation are useful. The long-transcript probe supports its scrolling claim. Its assessment is too categorical about error prevention, input efficiency, recovery, and removal of terminal conventions, and omits adaptive layout and multi-tab drafts. In terms of Nielsen's ten heuristics: status, familiar conversation structure, user control, and recognition have solid foundations; consistency and minimalism are broadly successful on a wide window; prevention, efficient input, recovery, and contextual help need the fixes above. That is a heuristic assessment, not a substitute for keyboard, assistive-technology, contrast, and reduced-motion testing. [Nielsen's ten heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/).

The documented open question about streamed thread context is deliberately not a finding. Dependency freshness was checked without upgrading anything: Codex SDK 0.157.1 was available versus pinned 0.155.1; Effect's `rc` tag remained 4.0.0-rc.117.

## Disposition

Applied 26 Sep 2026 in the stages of `docs/gui-review-response.md`, which is the agreed disposition of every finding.
Stage A was committed first and alone; the rest ran through Interloq itself (decision D2), from the installed
copy at `/opt/interloq`, which did not yet contain stage A. Row 15 was found by the developer after the review.

| # | Severity | Outcome | Commit |
|---|---|---|---|
| 1 | High | Done: a work response and its repair turn run under a `readOnly` capability, one `PreToolUse` hook without a matcher that denies every tool but `StructuredOutput`; the review, the phase's log entries and `changes.diff` are in the prompt (decision Q1); a changed guarded record halts with `RecordsChanged`, a changed project with `ProjectChanged`. Behaviour 12's wording of the two halts corrected after work review 1 (W1-R1-1) | `a8a3924`, `45c4c67` |
| 2 | Medium | Done: `requestTarget` decodes the target with `Result.try`; a malformed URL or escape is a 400, traversal stays 404. Recurred 27 Sep 2026 at another boundary: the page's socket dropped a frame it could not decode in silence (defect B of `docs/page-question-phase-defects.md`), which hid defect A behind a page that read "connected"; now the reason is a notice and a console error, the page reconnects with backoff, and after three in a row it is `failed`, with its actions refused and no typed text lost | `ca03527`, `bbb3602` |
| 3 | Medium | Done: `web/src/storage.ts` guards the acquisition of `localStorage`, the read and the write; the form falls back to the server's directory and Start always starts | `ca03527`, `061f499` |
| 4 | Medium | Done: the project must be a worktree's top-level directory; a subdirectory is refused with the root named, a bare repository is refused, before anything is archived or initialised | `45c4c67` |
| 5 | Medium | Done: the draft is keyed by (incarnation, run, prompt) and reconciled with the view after every message, live or replayed; another tab's answer withdraws it with a notice that quotes it; a two-tab browser scenario | `837b954`, `061f499` |
| 6 | Medium | Done: a composing Enter does not send; persistent field labels, a hint and a visible Send (the hint's text moved to `src/prompts.ts` after work review 2, W2-R1-4) | `837b954`, `061f499`, `5112ae7` |
| 7 | Medium | Done (decision D1: in scope; decision Q3: selectable panels): below 840 px a progress disclosure, one panel at a time with a badge, a prompt selecting "You and Interloq", a wrapping top bar; layout tests at 390 × 844, 640 × 400 and 1280 × 800. After work review 2 (W2-R1-1, W2-R1-3) and planning 3 (P3-R1-1): the panels stay mounted and keep their reading position across a switch or a resize, a hidden panel follows its end when shown again, and a prompt is recognised by its full key | `9aa731e`, `5112ae7` |
| 8 | Low | Done: the interview's opening is the event `ClarificationOpened`, rendered by the terminal with `"""` and by the page with Shift+Enter; an interview scenario in the browser | `837b954`, `061f499` |
| 9 | Medium | Done: the vacuous exclusion property deleted and replaced by one against an independent path policy; the driver's script selection fixed; the first exit, its round and its pauses checked against an independent model, and nothing after a correction's logged checkpoint but the exit | `061f499` |
| 10 | Medium | Done: every browser test fails on an uncaught or console error in any page of its context; scenarios for the interview, a work correction through phase 2, two tabs with a draft, a dropped socket, a long transcript, refused storage and composition. Recurred 27 Sep 2026: the interview scenario's question review raised no issue, so no scenario carried a question list's response, and defect A of `docs/page-question-phase-defects.md` (the response's `questions` refused by the page's decoding) reached the first real run with a question phase; now a replay fold of a question phase through `decodeServer` and the end-to-end scenario `questionReview` (the list, its review with an issue, the response, an interview turn, an answer, the requirements review, and a second tab's replay) cover it | `061f499`, `9aa731e`, `04811df`, `d2caaea` |
| 11 | High | Done: publication (record and offer) is one serialized, uninterruptible step; Start reserves the run with its fiber in one uninterruptible region; an answer is taken, published and delivered in one; interruption-injection tests at each transition | `45c4c67` |
| 12 | High | Done, rating kept (refinement 6): an incarnation per start of the server in `hello`, `answer` and `stop`; the manager refuses and the page discards, with a notice, the actions of an earlier incarnation; stale answers tested as well as a stale Stop | `45c4c67` |
| 13 | Medium | Done in part, as agreed: each tab's queue is bounded at 1,000 and a tab that falls behind is told, closed and recovers by replay. Chunked storage not needed at the measured size (decision Q4): 10,030 events, a 1.55 MB replay delivered in 45–51 ms, about 4 MB retained, about 230 ms to publish them with copying, against a criterion of 1 s or 50 MB | `061f499` |
| 14 | Low | Done: `makeRenderer` builds a private DOMPurify instance with the link hook; the imported singleton is never configured | `ca03527` |
| 15 | Medium (developer, 26 Sep 2026) | Done: the server's finalizer, registered after `serveEffect`, tells every tab `closing` and closes its socket, so Ctrl+C ends the server with tabs open; the page says the server has ended, above the panels in a compact window whichever panel is shown (W2-R1-2) | `45c4c67`, `5112ae7` |

Decisions of the developer: D1, finding 7 is in scope (the adaptive layout was kept in the task); D2, the stages after A
went through plan-review as one task. Decisions of the task's question phase (`plan-review/requirements.md` of that
run): Q1, the work response's prompt carries the review, the phase's log entries and the diff; Q2, finding 15 in
stage C; Q3, selectable panels below 840 px; Q4, chunked storage only if the measurement exceeds 1 s or 50 MB.

Not done by this task: one real run through the work review in the terminal and one in the page, which the response
document's verification asks for after the last stage.

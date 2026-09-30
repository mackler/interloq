# History of Interloq

A record of the decisions made while the program was designed, written for a reader who was not
present. Dates are 20 and 21 September 2026.

## Starting point

The developer ran Claude Code and Codex in two Docker containers per project, both mounting the
project at `/workspace`, and used them through two terminal windows. The manual procedure: put
Claude Code into plan mode, have it write a plan, copy the plan file into the project, have Codex
review it, copy the issues to Claude Code, have Claude Code act on or reject each issue, repeat
until Codex reported no issues, then tell Claude Code to apply the plan in auto mode. Every stop
during implementation was answered by hand, and the developer sometimes switched back to plan mode
first so that the plan could be revised.

The developer's requirements: automate this, prevent non-terminating loops, and wait for the
developer only where a decision is required.

## Bash script (versions 1 to 5, superseded)

The first implementation was a Bash script, `plan-review.sh`, that started `claude -p` and
`codex exec` through `docker exec` from the host. Its mechanisms were carried into the TypeScript
program and are still the program's design:

- Structured exchange through JSON schemas instead of copied text: Codex returns issues with an
  id and a severity; Claude Code returns one disposition per issue with a rationale addressed to
  Codex.
- An issue log that Codex reads every round, so rejection rationales reach Codex without copying.
  Later entries with the same id supersede earlier ones.
- Five dispositions: accepted, partially_accepted, rejected, no_change_needed,
  clarification_requested. The last allows a question from Claude Code to Codex; a second
  clarification request for the same id pauses for the user.
- Self-corrections, so that Claude Code can report an error in its own earlier answers, and
  reviewer feedback that concerns no single issue.
- Pause conditions rather than hard limits: a rejected issue raised again (same id, or a new id
  that Claude Code identifies through `duplicate_of`), a correction that would reverse an earlier
  accepted one, identical file content to an earlier round, a change to the file with no recorded
  cause, consecutive rounds without an accepted issue, and a round limit at which the user adds
  rounds, proceeds, or stops. The round limit (`maxRounds`, default 5) is a placeholder value with
  no measurement behind it.
- Convergence is a review with zero counted issues. `countMinor` (default true) decides whether
  minor issues count; the developer chose to match the manual procedure, which ended only at "no
  issues".
- Alternation of planning phases and execution phases, with every stop during execution leading
  to a revision and a new review.
- Change detection: the project state outside `plan-review/` is compared before and after each
  planning call.

The Bash script was replaced because its logic had outgrown the shell: about twenty embedded jq
programs, global variables as the only state, and defects caused by `IFS` and by `while read`
loops that consumed the terminal's standard input.

## Why TypeScript and the agent SDKs

Both vendors publish SDKs, and TypeScript is the only language in which both are released
(`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`). The SDKs change three things compared
with the CLI flags:

1. A stop is an event. `AskUserQuestion` and permission requests arrive in the `canUseTool`
   callback, and the callback can stay pending indefinitely. The Bash script had to rely on
   Claude Code reporting a status field.
2. Edits outside `plan-review/` are denied by a `PreToolUse` hook before they happen, not detected
   afterwards.
3. Codex keeps one thread per review loop with a different output schema per turn; the CLI
   documentation did not state whether that combination works, and the SDK prototype showed that
   it does.

Two prototypes (`prototypes/proto.ts`, `prototypes/proto-codex.ts`) were run in the developer's
containers before the port. Results: the Agent SDK uses the container's existing login
(`apiKeySource: none`); the hook denies a `Write` outside the permitted directory; questions and
permission requests arrive as events; the Codex SDK runs with the credentials in `~/.codex`;
thread context is kept across turns with a schema per turn.

## Container arrangement

- Both SDKs start a local CLI, so the program must run where both agents are installed. The
  developer chose one container with both CLIs (the project's `cc` service) over an orchestrator on
  the host. The project's `.devcontainer/Dockerfile` already installed both CLIs.
- The project's firewall script (`init-firewall.sh`) allows hosts per agent keyword. A third
  keyword `orchestrator` was added that loads `common.txt`, `claude.txt`, and `codex.txt`, and the
  `cc` service passes it. Running the script a second time in a running container disables all
  network access (the default DROP policy remains while the rules are flushed and the GitHub
  fetch fails), so the keyword can only be set in the start command.
- The Codex credentials volume of the Codex compose project (`iou-notes-codex_codex-config`) is
  mounted into the `cc` service as an external volume, so one login serves both containers.
- This repository is mounted read-only at `/opt/interloq` in project containers.
  `node_modules` installed on the developer's desktop (Linux x86-64 glibc, Node 24) works in the
  containers (Node 22/26).

## Codex sandbox

Under `--sandbox read-only`, every shell command Codex runs fails in the containers with
`bwrap: No permissions to create a new namespace`, because Docker's default seccomp profile does
not permit user namespaces. Codex could then read nothing from the project. The developer's own
Codex launcher already uses `danger-full-access` for the same reason. Decision: Codex review turns
run with `danger-full-access` and `approvalPolicy: never`, and the program halts if the project or
the reviewed file changed during a Codex turn. Making bubblewrap work (`seccomp=unconfined` and
related settings) was rejected because it would loosen the container that runs Claude Code in auto
mode.

## The question phase

Added after the first version of the TypeScript program. Decisions, taken one at a time:

1. The interview takes place in the orchestrator's terminal, not in Claude Code's own interface
   (control, complete record, and only verified mechanisms; the interface option had three
   unverified handovers between the SDK session and the interactive program).
2. Claude Code proposes the end with a summary; the user confirms or continues.
3. Follow-up questions outside the agreed list are unrestricted.
4. Each list entry has question, reason, proposed answers, and a default.
5. Codex reviews the confirmed requirements for gaps before planning; accepted gaps lead to a
   second interview on those points only. Codex also reads `requirements.md` in every plan review.
6. An empty agreed list still offers a conversation; Enter starts planning.

The review procedure was generalized to a `Subject` so that the same code reviews the question
list, the requirements, and the plan.

## First real run (21 Sep 2026)

A documentation-only task in the developer's project ran through: question phase, requirements
review, three planning phases, two stops with `AskUserQuestion`, and `finished`. Findings and
corrections:

- The first attempt halted because Claude Code's state file, `.devcontainer/claude.json`, is a
  tracked file inside the project that Claude Code modifies on every call. The halt message was
  changed to name the changed paths, and an `ignorePaths` setting was added (shared `config.json`
  for all projects, overridable per project).
- After a stop, the hook that denied all further tools also denied the `StructuredOutput` tool,
  through which the final status report is delivered. The hook now permits that tool.
- Every Codex review in that run returned zero issues in round 1, so the exchange between the
  agents has run only in the scripted tests.
- A `usage.jsonl` record was added; whether `total_cost_usd` is per call or cumulative per session
  is not yet known.

## Development arrangement

`~/work/interloq` is the installed program that project containers mount. Development happens in
a separate clone, `~/work/interloq-dev`, in its own Claude Code container (`compose.cc.yaml`,
`bin/dev-claude`). The developer adopts a version with `git pull ~/work/interloq-dev main` in the
installed directory. A worktree was rejected for the development clone because its `.git` file
refers to a host path that does not exist inside the container. In the development container the
state file is stored in the `claude-config` volume because the base image sets
`CLAUDE_CONFIG_DIR`, so no tracked file changes there.

## Type checking and SDK versions (21 Sep 2026)

`npm test` runs the type check before the tests, and a tracked pre-commit hook
(`.githooks/pre-commit`) refuses a commit with a type error, because Node.js runs the code without
checking types. The Agent SDK was pinned from `latest` to 0.3.278 and the Codex SDK from `^0.155.1`
to 0.155.1, the versions on which the established facts were verified. The developer wants to keep both SDKs current, so CLAUDE.md asks
for a version check at the start of every session and describes a deliberate upgrade.

## Effect v4 (24 and 25 Sep 2026)

The developer chose to rewrite the program with the Effect library
(github.com/Effect-TS/effect), full adoption on version 4 (release candidate 117 at the time, chosen
over the stable 3.x so that no 3-to-4 migration follows), and required a strict test-first procedure:
every step's test is written and seen to fail before its code, and the observed failure is recorded
in the commit message. The plan was written by Claude Code and reviewed by Codex through this very
program (a run of about $96 of Claude Code usage that halted on a Codex usage limit in planning
phase 10; the plan was carried out by hand from `plan-review/plan.md` afterwards). Decisions taken
in the question phase of that run:

- Q1 pre-release policy: go ahead only if Effect 4 is at least a release candidate, and pin that
  exact version (a beta would have stopped the plan at stage 0); Q2 `@effect/platform-node` added for the Node layers and the runner, both packages
  pinned to the same exact version; Q3 Ctrl+C ends like a halt with exit code 130 after both SDK
  calls are aborted and readline is closed; Q4 an invalid `config.json` stops the program before any
  agent call and names the file and the field; Q5 an invalid structured reply gets one repair turn in
  the same session or thread and a second one stops the run, with the replies kept on disk, and
  execution reports excluded; Q6 the SDKs are injected as a service so that the adapters are tested
  with fakes; Q7 a prototype proves that both agents accept the generated JSON Schema before any
  production schema is written; Q8 the same version policy as for the SDKs.

What the rewrite produced, stage by stage (one commit per stage or sub-step):

0. The pins, the API ledger `docs/effect-v4-api.md` (every Effect name with its declaration; v4
   differs from v3 and from most material online), and the acceptance proof: 28 calls, all accepted,
   the raw and strict JSON Schema variants byte-identical, so the raw variant is sent.
1. `src/schema.ts`: one Effect Schema per kind of data, generating the JSON Schema that the legacy
   hand-written schemas had, compared byte for byte against the proof.
2. `src/errors.ts`: fifteen tagged errors and `describe` in place of the single `Halt` class; raw
   `fs`, `JSON.parse` and git errors became typed.
3. The `AgentSdk` interface and a fake, so that the adapters' logic (message loop, hooks, stops,
   session resume) got its first tests. Learned here: a scaffold that still imported the real SDK
   started a real Claude Code process during a test run; the plan's rule R8 (no scaffolding may
   reach a real agent) came from that incident.
4. Types from the schemas; validation of the config, the state files and the agent replies, with
   the repair turn.
5. The five services, the procedure as `Effect.gen`, the store on Effect's FileSystem, Path and
   child-process services (git runs through the spawner, whose `string` does not fail on a non-zero
   exit, so the store checks the exit code), the terminal as one readline interface held for the
   whole run (which keeps pasted lines between prompts, and which must pass Ctrl+C on because
   readline swallows it in terminal mode), and the adapters as layers with abort signals and
   callback failures that surface as typed errors.
6. `src/program.ts` with the endings and the exit codes; `src/main.ts` reduced to the wiring and
   `NodeRuntime.runMain`.

Rejected during the design: a hand-written JSON Schema as the fallback if the agents had refused the
generated one (a pure, tested transform of the generated schema was chosen instead, and was not
needed); repair turns in execution sessions (a recorded stop must take precedence, and an invalid
report is treated as a missing one); `runPromiseWith` with a captured context for the SDK callbacks
(the adapters capture the services as values, so `runPromise` with the call's abort signal suffices).

The first real run after the rewrite (25 Sep 2026, a README task on a scratch project in the
development container) went through all phases and finished. It settled an open question: the Agent
SDK's `total_cost_usd` is the running total of the session (0.49, 1.06, 1.77 across the three calls),
so the usage summary, which had summed the calls, was changed to report each session's last value.

Observed about Effect 4 during the work and recorded in the ledger: `Effect.exit` does not capture
an interruption from outside, so the INTERRUPTED output is printed by `onInterrupt` finalizers and
the exit code comes from the runner's teardown; `runPromise` rejects with the typed error object
itself; `Schema.Decoder<T>` is the type that both `toJsonSchemaDocument` and `decodeUnknownSync`
accept.

## Applying the functional design review (25 Sep 2026)

Codex reviewed the Effect rewrite three times through its own `codex review` / `codex exec`: two
regressions of the rewrite (the Claude Code message loop did not close its stream on a typed
failure; a synchronous SDK start failure was a defect) were fixed test first, and the third run, with
the developer's functional-programming instructions, produced `docs/functional-design-review.md`:
32 findings and recommendations A–F. The developer chose to apply all of it, in the order of
recommendation F, with `fast-check` permitted as the one new dependency.

The plan for that work was made by this program on itself: question phase (eight decisions,
`plan-review/requirements.md` of that run), then Codex reviewed the plan in rounds — 6, 4 and 1
issues, all accepted, the first real run in which the exchange between the agents took place — until
the run halted in round 4 on a Codex usage limit (3.2 million input tokens over seven turns, the
thread's context growing with every round). Resume is not implemented, so the reviewed plan
(`plan-review/plan.md` of that run, archived by any later run) was carried out by hand from here.

- Stage 0: `fast-check` 4.10.2 as a pinned devDependency; `test/deps.test.ts` checks the pin.
- Stage 1: regression tests and the least fixes for the confirmed defects. `describeChange` reports diff
  entries that appear or disappear (finding 1); git runs with `-z`, so names are never quoted, and one
  exclusion predicate covers `plan-review/` and `ignorePaths` in both commands (2); a review with
  duplicate ids, or a response with a missing, duplicate or unknown disposition, halts with `RoundInvalid`
  before anything is counted or recorded — decision Q3, replacing `MissingDispositions` (3); the
  program's own records constrain counts, costs and ids, and the round-limit answer is parsed as a
  whole safe integer (5); reviewer start failures are `CodexCallFailed` (11); the identical-content
  message names the round after which the content was seen, also after an idle decision (14); only a
  whole in-range number chooses an option (18); the store reads the time and serializes when the effect
  runs, and an unserializable reply is kept as a note instead of crashing (22); the scripted Ui shares
  the terminal's command parsing, script steps are typed, the doubles expose readiness signals instead of
  being polled, and temporary directories are removed (31). `src/input.ts` holds the pure parsers.
- Stage 2: `src/round.ts` validates a review and a response into one readonly value (unique non-empty ids,
  exactly one disposition per issue, references normalised per Q3 with a note in the record for each dropped
  one, generated self-correction ids), and the log transitions take that value, so a missing disposition is
  unrepresentable there; the Q2 overlap order is applied in `appendRound`. `src/snapshot.ts` is the Q1
  snapshot: porcelain v2 records and the working-tree entry per path, compared into typed changes that the
  errors carry. Answers to Claude Code's questions are keyed by question index, with a note when two questions
  share a text. Property-based tests (fast-check) cover the rounds and the log, the snapshot (including
  generated file operations on a real repository against a git oracle), the input parsers and the record
  schemas; the input properties passed at once, as they specify what stage 1 had built.
- Stage 3: the review loop is a pure state machine, `src/reviewState.ts` (`advance(state, event)` → next
  state and commands; the pause order of behaviour 7 is the order of its steps), and `reviewLoop` its
  interpreter; the user's decision is one typed event from which both the record lines and the
  `decided_by_user` log entry derive, so a decision on a reraised issue now reaches the log too (Q7,
  finding 15). The usage summary is a pure fold (`src/usage.ts`, Q8: calls without a session id are their
  own sessions and are counted), the reader's agent type is closed, and `program.ts` renders the structured
  summary. Properties: bounded generated event traces through `advance` against a model in the test, and
  the usage fold's laws. Small helpers: `planningCall` reports `repaired` (a `Ref` instead of a mutable
  binding), `askNonEmpty`, the interview's message variants and the line-protocol fold in `src/input.ts`.
- Stage 4: a subject's two planning operations are typed by their schemas (`Subject<R, D>`, finding 12);
  the reviewer returns a `ReviewSession` bound to its thread (`startPhase`; no nullable `Ref`, finding 11);
  the planner's decoding and reduction are pure (`src/claudeEvents.ts`: `AskUserQuestion` input decoded,
  partial output explicit, the stop per execution call, the terminal dialogue serialized with a
  `Semaphore`; findings 17, 19, 20); the decoders return `Result` and `lift` is gone, the callback
  failure travels through a typed `Deferred`, and `haltMessage` validates the payload of a tag
  (`decodeRunError`; finding 10 — `isRunError` was not split into a trusted variant, because after the
  `Deferred` no value crosses a Promise boundary inside the program). Records (Q5): log entries are a
  union tagged by `source` with `superseded` required and `null` references, the three logs are
  `{ version: 2, entries }`, usage lines are per-agent records, `questions.json` carries the version, and
  every round gets `round-<n>.json` (`no_response` after the review, `validated` after the response);
  `src/records.ts` reads both versions, reconstructs a version-1 round against its pre-round history
  (`historyBefore`; the archive case with a generated self-correction id is the fixture
  `test/fixtures/run-v1/`) and converts a run directory idempotently. Interview turns, execution reports
  and the question list become variants after decoding (`src/schemaNormalize.ts`; finding 8, Q4; duplicate
  question ids halt with `QuestionListInvalid`). The planning hook resolves edit targets through symlinks
  (finding 21; race policy: the check is at hook time, the snapshot comparison after the call is the
  second check). The strict JSON Schema fallback is total (`Result<Json, UnsupportedSchema>`, finding 24).
  Readonly views for the exchanged records (finding 26). Properties: `historyBefore` against the log as
  it was, the question-list normalisation, and the strict transform on generated acyclic schema graphs.
- Stage 5: the catalog of the records (`src/artifacts.ts`: `SubjectId`, `Artifact`, one `pathOf` used by the
  subjects, the store, the readers and the prompts) and the interview in its own module, so that the
  value-import graph of `src/` is acyclic (`test/modules.test.ts` checks it; finding 28). The Store offers
  one domain operation per artifact and no path-taking write (finding 27, recommendation D); the markdown
  of the records is rendered in `src/render.ts`; `loadConfig` and `platformLayer` are `src/config.ts` and
  `src/platform.ts`. The store reads the Clock service (finding 22), a second archive in the same clock
  instant gets a suffix, and invalid-reply files are created exclusively with the number retried (finding
  23). JSON records are written to a temporary name and renamed into place, and `checkpoint.json` names
  the last committed transition (`started`, `reviewed`, `responded`, `logged`, `decided`, `executed`;
  finding 16, Q6; no journal, no resume); `readCheckpoint` verifies the named records. The prototype
  counts a call as accepted only when its reply decoded (`prototypes/classify.ts`; finding 32). Properties:
  a decision's log entry and transcript lines agree and rendering is pure; with a write failure injected
  at any one persistence step of a scripted run, the checkpoint never names incomplete records. The
  `liveSdk()` factory of finding 29 and `src/convert.ts` of stage 4 were written after the developer
  approved their texts (25 Sep 2026).
- 26 Sep 2026: the Agent SDK pin moved from 0.3.278 to 0.3.283 (Claude Code 2.1.283), because the model
  the developer chose, Opus 5.5, is refused by Claude Code 2.1.278 ("version 2.1.280 or newer is
  required"); the model name reached the API, so the name itself is right.
- 26 Sep 2026: the run prints the models it uses — the model Claude Code's init message reports,
  once per change, and the configured Codex model — after a planning run consumed a Claude session
  limit on the login's default model without showing it.
- Same day (25 Sep), on the developer's instruction: the readers of the old record shape, the reconstruction of
  old rounds (`historyBefore`, `readRound`), the converter and its fixture were removed. Only the
  version-2 shape is read; the old records of earlier runs stay as they are and are not readable by
  the program. The version marker stays, so that a later change of shape can be told apart.

## The web GUI and the work review (26 Sep 2026)

The task: a web page for the program next to the terminal, and a new review phase, in stages, test first.
The question phase settled what the task left open (`plan-review/requirements.md` of that run):
marked + dompurify (Q1), m3-svelte (Q2), a vertical timeline rail for the progress (Q3), the port as a
command-line argument with 8090 as the default (Q4), one `notify(event)` on the Ui for everything the page
shows beyond the terminal's lines (Q5), the work review's changes as a diff between two git trees built in
a temporary index (Q7), a directory browser in the page (Q8), WebSocket in both directions (Q9), everything
in `npm test` (Q10), jsdom (Q11) and svelte-check (Q12) as further devDependencies, no "p" at a work
review's round limit (Q13), leaving the work review at the first accepted issue before the observation
(Q14), and any user decision at a work-review pause leading back to planning (G-R1-1).

- Stage 0: the pins. `m3-svelte` 7 writes its styles with CSS `@function`/`@mixin`, so the developer
  added `vite-plugin-functions-mixins`; that plugin requires Vite 7, so `vite` stays on 7.x and
  `@sveltejs/vite-plugin-svelte` on 6.x (developer's decision). The Codex SDK stayed on 0.155.1 although
  0.157.1 was out (developer's decision). Chromium's system libraries were installed by the developer as root.
- Stage 1: `UiEvent` and `UiShape.notify`; the prompts to the user moved into `src/prompts.ts`, with the
  widget catalog `src/userPrompts.ts`; the interview prompt now prescribes numbered answers as `<n>. <answer>`
  so that the page can offer them as buttons; Codex turns are streamed (`runStreamed`) for the activity line.
- Stage 2: the work review (behaviour 12). Codex's review of the plan found, in five rounds, the decision
  exits that would have written checkpoints `readCheckpoint` rejects, the replay boundary per run, stale
  diffs, tracked files matching `.gitignore` lost from the trees, `ignorePaths` read as git patterns, and
  an edit of `changes.diff` itself passing the guard; each was corrected in the plan before the code.
- Stage 3: the server. Two facts were found by the tests: a detached fiber interrupted before it first ran
  never runs its `onExit` (hence `forkDetach({ startImmediately: true })`), and Effect's WebSocket accepts
  the upgrade only once its reader is acquired, so a session that writes first waits forever.
- Stage 4: the page. The review against Nielsen's heuristics (`docs/ui-review.md`) replaced the terminal's
  key conventions in the page's prompts (`pagePromptText`) and added a help text to the form; m3-svelte
  leaves the density function to the app (`web/src/theme.css`).
- Stage 5: four Playwright tests against the real server over the scripted agents.

Rejected or deferred in this work: `HttpRouter` (a dispatcher on the request needs fewer names for three
routes), the SSE module (Q9), a confirmation for Stop (behaviour 1), an icon set for the timeline (a further
dependency), and persistence of the page's runs beyond the records (the server keeps the current and the
last run in memory).

## A failed call and an unchanged file (issues #26, #30 and #31, 28 and 29 Sep 2026)

Three issues were applied as one subject: a run must not die from a failure that a retry would fix, and the reviewer
must be able to see when a response did nothing.

- #31: each issue-log entry of a response records `file_change`, what the program measured of the reviewed file
  during that response (changed, lines added and removed), from the same observation the guard compares. Codex reads
  it as fact; the terminal and the page do not show it.
- #30: an accepted issue with the reviewed file unchanged no longer halts. The question list, the plan and a decision
  get one corrective turn in the same session, whose dispositions are re-evaluated; if the file is still unchanged,
  the user chooses Retry, Proceed or Stop. The requirements go straight to that pause, because their unchanged file
  is the summary the user confirmed; the work review cannot meet the condition.
- #26: transport faults are classified and retried with backoff, the user decides when the retries are exhausted,
  and the retries are shown.

**Two mechanisms, not four.** The schema repair (behavior 10), the validation repair (#37), the corrective turn (#30)
and the transport retry (#26) all spend a second attempt, and the task asked for them to be unified as far as their
meaning allows. The first three answer a *defective reply* in the same session: the reply exists, the program found a
defect in it, and one more turn says what was wrong. They became one executor, `repairTurn` in `src/review.ts`, with a
budget per kind. The transport retry repeats a *call that produced no reply*: there is no defect to describe, it waits
between attempts, its budget is configured, and the guard must also be checked after a failed attempt. It became one
combinator, `withTransportRetry` in `src/retry.ts`. `TransportFault` is kept out of `RunError` and out of
`Planner.executing`, so the type check rejects an agent call that is not wrapped; the execution call is retried inside
the Claude Code adapter, which alone holds its session, its stop and its `report_step` server.

**The Codex halt of #26.** The halt's text was the message of a Codex `error` event, naming the CLI's reconnection at
2 of 5. The adapter consumes a streamed turn to its end, but `reduceTurn` then failed the turn retrospectively on the
first `error` event, whereas the SDK's own `thread.run()` treats only `turn.failed` as a failure. So the turn was
probably not cut short but misclassified after it had recovered; this is read from the SDK's source and has not been
seen in a run. An `error` event is now a notice.

**The records guard during a wait.** A read-only call's records guard compared a fixed snapshot. With retries, the
program itself writes guarded records while it waits (the retry line, the pause's answer, a decision's records), and a
journal that kept only each write's result would adopt an external edit made before an append. The Store now journals
every write to a guarded record with its preimage, and the guard replays the journal from its baseline.

## Every question put to the user (issues #46, #59, #34, #36, #25, #20, #19, #57 and #58, 29 Sep 2026)

The questions the user was asked came from a dozen places. Each was presented in its own way: a relayed question as
Claude's message, a pause with the records' JSON, the cycle limit with a composed "Decision on:" line, an interview
turn as a numbered list inside Claude's message. The user had to recognize each shape and look up what its words
meant. The task made one shape of them. `QUESTION_RULES` in `src/prompts.ts` is the one statement of what a question
must be: self-contained, every thing named, no bare identifier or number, the question last, a context paragraph of
five points, determinate options, and every unfamiliar term explained. The writing prompts and the review prompts are
rendered from it, and `validateQuestion` checks its mechanical part with the repair turn of behavior 10. Every
question reaches the user through `askOffering` as one `QuestionPresented` event, numbered for the run.

The decisions of the run:

- Q1: an agent writes the context of the questions the program composes. This is a context call in a fresh session;
  after W1-R1-1 of the work review it runs with a capability of its own, `readProject`, which reads and changes
  nothing.
- G-R1-1: that call is skipped when Claude Code is the agent that cannot be reached, and any other failure leaves the
  program's fixed paragraph, so the question is always asked.
- Q2 and G-R1-2: a question Claude Code relays carries its context and terms in its text. When it does not, a separate
  call writes them.
- Q4: one plain status line while an analysis is prepared.
- Q5 and Q6: terms are bound to their exact words, and the terminal prints a "Terms:" block.
- Q8: a fresh session writes the terms of the agreed list after the question review, followed by their own review
  loop.
- Q10: the question takes over the left panel.
- Q11: Ctrl+C is unchanged.
- Q12: the questions outside the agreed list get the rules in their prompts and the validation, with no Codex review.

At the stop of the first execution phase, the developer decided that End the run (`q`, `/quit`, the button) is an
interruption with exit code 130, like Stop task and Ctrl+C, where it had been a halt with 1. Stop at the cycle limit
stays a halt with 1, as decided in the plan review. Every answer that ends the run is now confirmed first, in the
terminal and in the page, by one predicate.

The work review found five gaps, all corrected:

- The context call had write access to the records (now `readProject`).
- A permission request did not show what the tool would do. Its input is now shown field by field, and after P2-R1-2
  a field with no plain label keeps its own name, explained as a term, so that two such fields never look alike.
- A turn with a blank id escaped the validation.
- A context call's terms were checked against facts the user never sees.
- "Help me decide" dropped the context and terms the question had been shown with.

## A question's terms as pieces of its text (issues #36, #59 and #66, 30 Sep 2026)

Three ways of binding an explanation to the words it explains were considered, and the reasons are recorded here so that a
fourth change is argued rather than guessed at (issue #36 asked for this).

- **Exact words** (decision Q5 of the run of 29-30 Sep 2026, built). The agent supplied `{ term, explanation }` and the
  page marked every case-sensitive, whole-word occurrence after sanitizing. It worked, but it cost ten of the fifty-six
  review issues of that run, every one of them the renderer failing to find or reach an occurrence in real HTML: an
  empty explanation passing the checks, a link holding several terms exposing only the first, focus routing that missed
  tooltips, a code span collapsing line breaks, a term split by inline Markdown, text nodes joined across a nested
  element. A plural or a capitalized first word was never explained at all, because its words differ from the term's.
- **Markers in prose** (chosen 30 Sep 2026, never built). The agent would mark each term where it occurs and the page
  convert the markers after sanitizing. Planning phase 11 of that run spent all five of its cycles on it without
  converging, four of them on one objection: the placement rules still accepted markers that rendering or sanitizing
  removes (inside HTML comments, `<script>`, `<pre>`, link-reference titles, HTML blocks across blank lines). The class
  of such cases could not be enumerated, only discovered.
- **Pieces** (chosen and built 30 Sep 2026). Both earlier mechanisms tried to recover a position after the text had been
  flattened into one string; here the agent creates the position. A question's text is a sequence of pieces, a piece
  with a `ref` carries the words as they stand in the sentence, and the explanations are a list the pieces refer to, so
  "execution calls" and "Execution call" are two pieces with one explanation. Validation is checks on data, and nothing
  reads Markdown to find anything. The price is a larger agent schema (blocks of pieces everywhere a question's text
  was a string), which awaits the schema acceptance proof.

In the same task the rules of issue #59 for what an option says (only how it differs from the others, after a preamble
that is never shown), how the context paragraph opens and names the owner of a purpose, and that the question asks
what the user wants joined `QUESTION_RULES`; and the rule of issue #66 replaced the restriction of `fast-check` to the
properties recommendation E of `docs/functional-design-review.md` named.

## Rejected or deferred

- `--permission-mode plan` and `plansDirectory` for the planning phases: the location of the
  plan file under `-p` was not documented; a hook-restricted `default` mode is used instead.
- Streaming Claude Code's interview replies: the reply is part of the structured output and exists
  only when the turn is complete; tool-call progress lines are shown instead.
- Resuming an interrupted run: wanted by the developer, not yet designed.
- An `ndt`-style launcher shared across projects: possible later; not needed for one development
  clone.
- Forcing a two-round Codex review to observe a thread's context under `runStreamed`: four real loops
  converged in round 1 with no issue, `countMinor` is already true, and no honest lever was left. Recorded
  as not established rather than provoked artificially (26 Sep 2026).

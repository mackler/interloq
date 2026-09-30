# Functional design review

**Findings**

1. **High — The snapshot model cannot support the promised change detection.** [src/store.ts:199](../src/store.ts#L199), [src/state.ts:30](../src/state.ts#L30), [src/state.ts:37](../src/state.ts#L37).

   `projectSnapshot` hashes only unstaged tracked diffs. Editing an already-untracked file can leave the snapshot identical; replacing one staged version with another can also leave the same status and no unstaged diff. The untracked limitation is documented in the source, but matters because snapshots enforce planning/reviewer restrictions. `describeChange` only compares hashes when a path exists in both maps; added/deleted map entries are invisible unless status text changes. A direct check with unchanged status and a newly added diff returned no change.

   This is a modeling problem before it is a mutation problem: `string[]` plus a partially populated map does not represent complete project state. See recommendation A for typed snapshots and independent comparison laws.

2. **High — Git output is treated as display text instead of a structured protocol.** [src/store.ts:201](../src/store.ts#L201), [src/store.ts:206](../src/store.ts#L206), [src/store.ts:105](../src/store.ts#L105).

   Splitting on newlines, removing surrounding quotes, and slicing three characters do not decode Git's quoted/escaped filenames or rename records. An escaped path can be passed back to `git diff` as if it were the actual filename, or fail to match `ignorePaths`. Also, `plan-review/` is filtered from status but not from diff names; tracked record files can consequently appear in the hash comparison despite the documented exclusion. Parse NUL-delimited machine output into path/status records and apply one exclusion policy consistently.

3. **High — Review/response relationships are not validated, so counts and recorded actions can disagree.** [src/issueLog.ts:37](../src/issueLog.ts#L37), [src/issueLog.ts:42](../src/issueLog.ts#L42), [src/issueLog.ts:51](../src/issueLog.ts#L51), [src/review.ts:202](../src/review.ts#L202).

   `missingDispositions` checks presence only. Duplicate review IDs, duplicate disposition IDs, and dispositions for nonexistent review issues pass. `appendRound` takes the first matching disposition, while `acceptedCount` counts every accepted disposition. Confirmed counterexample: dispositions `A/rejected`, then `A/accepted` produce no missing IDs, accepted count 1, and a log entry recording rejection. Duplicate review issues produce two nonsuperseded entries for the same ID. Extra accepted dispositions can distort progress checks and requirements amendments.

   Construct a validated round value that guarantees unique IDs and exactly one disposition per issue before applying it. Decide explicitly how a self-correction overlapping a current review issue is ordered; the current batch only supersedes older log entries, not other entries in the same batch.

4. **Medium — The ostensibly pure issue-log API is partial and accepts mutable collections.** [src/issueLog.ts:7](../src/issueLog.ts#L7), [src/issueLog.ts:46](../src/issueLog.ts#L46), [src/issueLog.ts:54](../src/issueLog.ts#L54), [src/issueLog.ts:74](../src/issueLog.ts#L74).

   `appendRound` throws an untyped `Error` if a disposition is missing. Its caller currently prechecks this, but the function's signature hides the precondition and an independent caller can violate it. All log parameters/results are mutable `LogEntry[]`, despite the functions not modifying their inputs. Accept readonly collections and either require the validated round from finding 3 or return a typed failure value. The local `Set` lookups are reasonable pure implementation details; they do not make these functions observably impure.

5. **Medium — Domain numeric constraints stop at “finite.”** [src/schema.ts:96](../src/schema.ts#L96), [src/schema.ts:114](../src/schema.ts#L114), [src/schema.ts:140](../src/schema.ts#L140), [src/review.ts:157](../src/review.ts#L157).

   Round limits accept negative and fractional values; `maxRounds: -0.5` was confirmed to decode. Phase/round numbers and token/turn counts likewise allow nonsensical values. The extra-rounds regex accepts arbitrarily long integers, whose conversion can overflow to infinity or lose integer precision, disabling the intended bound. Use validated safe integers with domain-specific ranges; preserve phase zero for question/requirements reviews, or replace that sentinel with a subject identity. Costs should have an explicit nonnegative policy too.

6. **Medium — Log entries are products of unrelated optional fields rather than a sum of valid variants.** [src/schema.ts:94](../src/schema.ts#L94), [src/schema.ts:103](../src/schema.ts#L103), [src/issueLog.ts:65](../src/issueLog.ts#L65), [src/issueLog.ts:82](../src/issueLog.ts#L82).

   `source` is a literal union, but `action` is any string, so `"accpeted"` survives persisted-record validation. Review, self-correction, and user entries share a structure that permits missing review metadata and incompatible source/action combinations. Define a tagged union with the action set and required fields appropriate to each source. The existing literal unions for severity and planner action are already good FP design; strings constrained to a closed union are not inherently stringly typed.

7. **Medium — IDs and absence markers conflate different concepts.** [src/schema.ts:10](../src/schema.ts#L10), [src/schema.ts:28](../src/schema.ts#L28), [src/schema.ts:31](../src/schema.ts#L31), [src/schema.ts:36](../src/schema.ts#L36), [src/issueLog.ts:60](../src/issueLog.ts#L60), [src/store.ts:183](../src/store.ts#L183).

   Issue IDs, question IDs, session IDs, paths, hashes, and arbitrary prose are interchangeable strings. Empty strings mean “no duplicate,” “no reversal,” “new self-correction,” “no decision,” and “missing file,” depending on context. A nonempty `reverses` is used without verifying that it references an accepted correction; nonexistent duplicates simply fail to match history. Generated self-correction IDs also share the agent-controlled namespace.

   Decode external strings into branded identifiers and explicit optional/reference variants. Validate references against the relevant history. Keep free-form problem/evidence text as text: it does not need an elaborate algebraic type.

8. **Medium — Interview and execution types admit contradictory states.** [src/schema.ts:54](../src/schema.ts#L54), [src/schema.ts:71](../src/schema.ts#L71), [src/schema.ts:78](../src/schema.ts#L78), [src/schema.ts:85](../src/schema.ts#L85), [src/interview.ts:28](../src/interview.ts#L28).

   `complete: true` can carry an empty summary; `finished` can carry pending input and remaining work; `needs_input` can have no question. A question default need not name a proposed answer, and question/answer IDs have no uniqueness or membership validation. `answered_ids` is decoded but not used to track coverage. The workflow compensates with conditionals or trusts the agent.

   Introduce internal variants such as `InterviewContinuing | SummaryProposed` and `Finished | AwaitingInput | Blocked | Aborted`, validating relationships at the boundary. Whether complete coverage is required before an interview can finish is a product policy to decide explicitly; user-confirmed early completion must remain possible.

9. **Medium — Usage records have neither a closed agent type nor reliable session identity.** [src/schema.ts:135](../src/schema.ts#L135), [src/services.ts:59](../src/services.ts#L59), [src/store.ts:165](../src/store.ts#L165).

   `recordUsage` accepts any object, while `UsageEntry.agent` accepts any string. Unknown agents decode but disappear from the summary. Missing/null Claude session IDs all become the same empty-string key, potentially collapsing distinct sessions' totals. Optional unrelated Claude/Codex fields obscure which totals are cumulative and which are additive. Use per-agent variants, preserve an explicit unknown-session case, and define its aggregation policy rather than silently identifying all unknown sessions.

10. **Medium — Several expected failures escape the advertised error algebra.** [src/state.ts:11](../src/state.ts#L11), [src/state.ts:20](../src/state.ts#L20), [src/store.ts:27](../src/store.ts#L27), [src/services.ts:83](../src/services.ts#L83), [src/errors.ts:85](../src/errors.ts#L85), [src/claude.ts:147](../src/claude.ts#L147).

    Parsing helpers throw rather than describing failure in their return types. `lift<A,E>` then casts *any* recognized `RunError` to the caller-selected `E`; the runtime check cannot establish that narrower union. Callback failure capture repeats this narrowing cast. `isRunError` itself checks only a recognized `_tag`, not the payload required by `describe`. This works by convention inside trusted code but is not a sound validator for arbitrary caught values. Prefer typed decoding results/effects and explicit error mapping; distinguish trusted tagged errors from validated external objects.

11. **Medium — Reviewer creation requires an invisible call-order protocol.** [src/services.ts:35](../src/services.ts#L35), [src/codex.ts:15](../src/codex.ts#L15), [src/codex.ts:20](../src/codex.ts#L20), [src/codex.ts:32](../src/codex.ts#L32).

    `review` requires `newPhase` first, but both are independently available and an out-of-order call dies. A synchronous `startThread` failure also becomes a defect because creation uses `Effect.sync`; Claude startup already translates the analogous case into a typed call failure. Return a review-session capability from `startPhase`, with typed startup errors, and keep that session local to the review loop. This removes both nullable thread state and accidental session replacement by another loop.

12. **Medium — `Subject` loses the type relationship between decoded output and its handler.** [src/review.ts:19](../src/review.ts#L19), [src/review.ts:38](../src/review.ts#L38), [src/review.ts:114](../src/review.ts#L114), [src/subjects.ts:29](../src/subjects.ts#L29).

    The response is generic, but decision application is `Decoder<unknown>`, its shared handler accepts `unknown`, and `applyDecisions` takes `Subject<any>`. The question subject recovers the intended relationship with `as QuestionList`. The present configurations work, but a future mismatched schema/handler would compile. Give response and decision-application outputs separate type parameters and handlers, or package each decoded operation with its handler in a closure. Optional callbacks also make the lifecycle implicit.

13. **Medium — Review state is spread across mutable variables and positionally related arrays.** [src/review.ts:140](../src/review.ts#L140), [src/review.ts:187](../src/review.ts#L187), [src/review.ts:208](../src/review.ts#L208), [src/review.ts:261](../src/review.ts#L261), [src/review.ts:284](../src/review.ts#L284).

    `hashes`, `counts`, `costs`, `idle`, `limit`, `n`, `issueLog`, `decided`, `userDecisions`, and `hash` collectively encode the state machine. Nested `decide` mutates its enclosing state. Pause detection, display, agent calls, persistence, and transitions interleave in one large generator. These locals are recreated for each execution, so this is not automatically a shared-state race; the problem is that invariants and transition ordering cannot be inspected or tested independently. An immutable review state and pure transition functions would make the central teaching example substantially stronger.

14. **Medium — History position is incorrectly used as a round identifier.** [src/review.ts:274](../src/review.ts#L274), [src/review.ts:282](../src/review.ts#L282), [src/review.ts:292](../src/review.ts#L292).

    Each round normally appends one hash, but an idle-pause decision that applies changes appends another. After that, `hashes.indexOf(hash)` is no longer a round number, yet it is printed as one. The same implicit-index design makes future checkpointing awkward. Store observations as `{ round, stage, hash }`; compare content independently from the metadata used to explain when it occurred.

15. **Medium — Decision recording is inconsistent across pause paths.** [src/review.ts:188](../src/review.ts#L188), [src/review.ts:210](../src/review.ts#L210), [src/review.ts:252](../src/review.ts#L252), [src/store.ts:147](../src/store.ts#L147).

    Decisions on reraised IDs are written to Markdown through `askDecision`, but its returned text is discarded. Later pause paths collect issue decisions and append `decided_by_user` log entries. Thus the same domain concept has different machine-readable representations depending on which branch prompted it. The reraised path does not preserve a user override in the issue log. Use one typed decision event, including subject/issue identity and reason, and derive both the log and readable record from it. Preserve the existing point at which the next planner call consumes the decision.

16. **Medium — Domain transitions are persisted through separate writes with no committed-round representation.** [src/review.ts:200](../src/review.ts#L200), [src/review.ts:201](../src/review.ts#L201), [src/review.ts:255](../src/review.ts#L255), [src/store.ts:88](../src/store.ts#L88), [src/store.ts:147](../src/store.ts#L147).

    The response is saved and the question file can be changed before cross-response validation. Conversation, feedback, decisions, and the issue log are written independently. Failure/interruption can leave a partial round, and direct JSON overwrites can leave an incomplete record. This is especially relevant to the documented future desire to resume. Distinguish raw evidence from validated/committed transitions, write replacement records atomically, and define a checkpoint or commit marker before implementing resume. A full event-sourcing system is optional.

17. **Medium — SDK callbacks trust assertions where decoding is required.** [src/claude.ts:61](../src/claude.ts#L61), [src/claude.ts:94](../src/claude.ts#L94), [src/claude.ts:106](../src/claude.ts#L106), [src/claude.ts:182](../src/claude.ts#L182).

    `as Question[]` does not establish that `questions` is an array or that every question has `options`. Malformed callback data can fail in `q.options.entries()` outside the intended typed error contract. Tool inputs are similarly cast and coerced with `String`. Normalize SDK events at one boundary into a small validated event union. Keep vendor-required tool-name strings in that adapter; use domain commands internally.

18. **Medium — Numeric choice parsing changes legitimate free text.** [src/claude.ts:51](../src/claude.ts#L51), [src/claude.ts:52](../src/claude.ts#L52).

    `parseInt` accepts prefixes: `"1 please explain"` becomes option 1, and `"1.5"` also selects option 1. This conflicts with the offered “Number or free text” choice. Duplicate question text overwrites earlier answers because the answers object uses question text as identity. Parse only a complete valid option number; represent answers by validated question identity internally, converting to the SDK-required object at the edge. Reject or explicitly handle duplicate textual keys there.

19. **Medium — The planner mixes transport, permission policy, dialogue, aggregation, and outcome interpretation.** [src/claude.ts:43](../src/claude.ts#L43), [src/claude.ts:60](../src/claude.ts#L60), [src/claude.ts:140](../src/claude.ts#L140), [src/claude.ts:156](../src/claude.ts#L156), [src/claude.ts:240](../src/claude.ts#L240).

    The adapter mutates `answers`, `full`, `out`, and `callbackFailure`, while also managing session/stop `Ref`s. `CallResult` allows success data and error text to coexist without identifying whether that is intentional partial output. Extract pure message reduction, outcome interpretation, choice parsing, and permission decisions; retain stream consumption, cancellation, and persistence in the shell. Model partial output explicitly because execution deliberately retains it on abort. Moving every local variable into `Ref` would merely effect-wrap the same design.

20. **Medium — Mutable callback state assumes serialization without expressing it.** [src/claude.ts:40](../src/claude.ts#L40), [src/claude.ts:77](../src/claude.ts#L77), [src/claude.ts:109](../src/claude.ts#L109), [src/claude.ts:229](../src/claude.ts#L229), [src/ui.ts:29](../src/ui.ts#L29), [src/ui.ts:50](../src/ui.ts#L50).

    The stop flag is shared across planner calls and set only after answers are collected. Overlapping calls could clear/replace another call's state; concurrent SDK callbacks could issue multiple prompts while execution still appears unstopped. The terminal supports just one pending waiter, which a second ask overwrites. These are conditional risks, not a demonstrated race in the current sequential orchestrator. Make the single-active-call/ask contract explicit and enforced, keep stop state per execution call, and consider a queue plus serialized dialogue. A `Ref` makes an individual update explicit; it does not make a multi-step protocol atomic.

21. **Medium — Path authorization is lexical rather than a validated filesystem capability.** [src/claude.ts:39](../src/claude.ts#L39), [src/claude.ts:63](../src/claude.ts#L63), [src/services.ts:51](../src/services.ts#L51).

    Resolving a path and checking its string prefix handles ordinary `..` traversal and sibling-prefix confusion, but does not establish that a symlink under `plan-review/` stays inside it. Arbitrary path/name strings also pass through Store operations without a domain distinction between record paths and project paths. Use normalized path types and a defined symlink policy at the filesystem boundary. Canonicalization alone still needs a race policy if filesystem contents can change concurrently. This recommendation preserves the documented container arrangement and does not propose changing Codex's sandbox mode.

22. **Medium — Time and serialization can run when an effect is constructed.** [src/store.ts:92](../src/store.ts#L92), [src/store.ts:132](../src/store.ts#L132), [src/store.ts:151](../src/store.ts#L151), [src/review.ts:80](../src/review.ts#L80).

    `recordUsage(entry)` reads `new Date()` and serializes immediately, before the returned append effect runs; reusing that effect reuses its timestamp. The archive timestamp is evaluated during execution but still uses ambient wall-clock time rather than an injected clock. `writeJson` accepts `unknown` and eagerly stringifies it, so cyclic objects/BigInt can throw outside its declared `StoreError` channel. Invalid-reply serialization has the same partiality concern. Use effectful clock access and typed serialization inside execution. Let the store own the timestamp; currently an `entry.time` property can override it through the spread.

23. **Low — File naming uses mutable directory state as an implicit ID generator.** [src/store.ts:132](../src/store.ts#L132), [src/store.ts:190](../src/store.ts#L190).

    Millisecond archive names can collide, and `count + 1` invalid-reply numbering can overwrite an existing file if the sequence has a gap; concurrent writers can choose the same name. Existing sequential clean-directory use reduces the risk but is not encoded in the API. Inject a run/record identity or use exclusive creation with collision handling. Keep human-readable ordering as metadata rather than deriving uniqueness from directory length.

24. **Medium — The strict JSON Schema transform promises more than it handles.** [src/jsonSchema.ts:12](../src/jsonSchema.ts#L12), [src/jsonSchema.ts:27](../src/jsonSchema.ts#L27), [src/jsonSchema.ts:33](../src/jsonSchema.ts#L33).

    `Json` is only `Record<string, unknown>`, and `$ref` resolution assumes a present, simple, acyclic local definition. A missing reference was confirmed to return `undefined` despite the declared `Json` result; cyclic definitions recurse indefinitely. Reference siblings are dropped and traversal treats arbitrary object-valued keywords as schema nodes. The current seven schemas use the raw path, so this is a latent fallback defect, not a current agent-call failure. Either restrict and validate the supported schema subset or return a typed unsupported-schema error. Its local result-object mutation is otherwise compatible with a pure transform.

25. **Low — Small orchestration helpers still use implicit mutable state and string commands.** [src/review.ts:108](../src/review.ts#L108), [src/run.ts:24](../src/run.ts#L24), [src/run.ts:32](../src/run.ts#L32), [src/run.ts:50](../src/run.ts#L50), [src/interview.ts:22](../src/interview.ts#L22), [src/interview.ts:41](../src/interview.ts#L41), [src/ui.ts:73](../src/ui.ts#L73).

    Repair mutates `last` inside `Effect.map`; run tracks `k`, `answered`, and `input`; interview tracks `prompt` and `reply`; multiline parsing tracks `block` and `collected`. Empty strings and `/done`, `p`, `q`, `y` are interpreted across multiple modules. Return repaired output together with its metadata, extract reusable nonempty-input effects, and parse terminal commands into variants at a context-aware boundary. Simple sequential loops can remain where they are clearer than a reducer; the command semantics matter more than eliminating every `let`.

26. **Low — Readonly discipline is inconsistent across public types.** [src/state.ts:30](../src/state.ts#L30), [src/services.ts:25](../src/services.ts#L25), [src/services.ts:54](../src/services.ts#L54), [src/review.ts:19](../src/review.ts#L19), [src/errors.ts:6](../src/errors.ts#L6), [src/errors.ts:18](../src/errors.ts#L18).

    Schema-derived structs are readonly already, but handwritten `Snapshot`, `PlanningResult`, `PlanningCall`, `Subject`, `Wiring`, callback records, and exposed arrays/maps often are not. Even `readonly changes: string[]` permits mutation of the contents. Use readonly fields, readonly arrays/tuples, and `ReadonlyMap`/`ReadonlySet` for returned views. Types alone do not freeze runtime values; optional freezing belongs mainly in tests and trusted construction boundaries. Avoid claiming that `const` or a `readonly` property makes its referenced collection immutable.

27. **Low — Store is a broad service containing several independent policies.** [src/services.ts:44](../src/services.ts#L44), [src/store.ts:46](../src/store.ts#L46), [src/store.ts:67](../src/store.ts#L67), [src/store.ts:157](../src/store.ts#L157).

    Configuration loading, platform wiring, Git snapshots, archival, generic file writing, domain logs, Markdown rendering, invalid replies, and usage aggregation live together. The usage fold is pure business logic embedded in file I/O; callers receive the formatted string rather than a structured summary. Extract those pure calculations and record renderers first. Split service capabilities where distinct consumers justify it, rather than creating one service for every function.

28. **Low — Workflow modules form an avoidable runtime cycle, and paths are repeated as protocol strings.** [src/interview.ts:10](../src/interview.ts#L10), [src/subjects.ts:5](../src/subjects.ts#L5), [src/subjects.ts:51](../src/subjects.ts#L51), [src/prompts.ts:6](../src/prompts.ts#L6), [src/prompts.ts:173](../src/prompts.ts#L173), [src/store.ts:64](../src/store.ts#L64).

    `interview.ts` imports subject factories while `subjects.ts` imports `interview`. Deferred invocation makes this work today, but it couples generic subject description to orchestration. Subject/store/prompt code independently reconstructs log and round paths, and plan completion remains a prose marker interpreted by the agents. Move conversation execution into a module below subject composition, or inject the amendment operation. Centralize artifact identity and path rendering. A structured plan-step format is only worthwhile if the orchestrator needs to validate progress; natural-language plans are an intentional product feature.

29. **Low — Some local mutation and impurity are appropriate, but should be taught accurately.** [src/state.ts:34](../src/state.ts#L34), [src/jsonSchema.ts:34](../src/jsonSchema.ts#L34), [src/store.ts:167](../src/store.ts#L167), [src/store.ts:205](../src/store.ts#L205), [src/ui.ts:24](../src/ui.ts#L24), [src/sdkLive.ts:8](../src/sdkLive.ts#L8), [src/main.ts:15](../src/main.ts#L15).

    Local output arrays/maps, private membership sets in `issueLog.ts:5` and `errors.ts:78`, and hash builders use mutable implementations. Provided input/shared state is not changed, local builders can still implement referentially transparent functions. Terminal callbacks, abort controllers, file/git operations, and SDK objects are necessarily effectful boundaries. Keep their ownership narrow. The module-level `new Codex()` is an eager construction boundary; a live-layer factory would give it explicit lifecycle and startup-error handling. Process streams, argv, cwd, signal forwarding, and the runner belong in the composition root and terminal adapter.

30. **Medium — The test design emphasizes examples and legacy equivalence, leaving algebraic laws uncovered.** [test/schema.test.ts:7](../test/schema.test.ts#L7), [test/jsonSchema.test.ts:23](../test/jsonSchema.test.ts#L23), [test/run.test.ts:10](../test/run.test.ts#L10), [test/state.test.ts:121](../test/state.test.ts#L121).

    Existing scenario/adapter tests are valuable, and all 115 pass. However, there are no direct law-oriented tests for `issueLog.ts` or `describeChange`; schema tests compare legacy shapes and a few hand-picked values. Duplicate IDs, overlapping correction batches, multiple idle/history transitions, unusual paths, and schema-reference graphs form large input spaces that examples do not cover well. The snapshot test also asserts the implementation's command sequence, which can discourage a better representation. Add the properties below while retaining behavioral scenarios and SDK contract fixtures.

31. **Low — Test doubles have avoidable string protocols and a live/fake behavior mismatch.** [test/helpers.ts:38](../test/helpers.ts#L38), [test/helpers.ts:47](../test/helpers.ts#L47), [test/helpers.ts:59](../test/helpers.ts#L59), [test/fakeSdk.ts:12](../test/fakeSdk.ts#L12), [test/fakeSdk.ts:40](../test/fakeSdk.ts#L40), [test/program.test.ts:64](../test/program.test.ts#L64).

    Script queues, call journals, counters, and observation flags are intentionally mutable simulations of effects. They need not be rewritten as pure production code. But `"<wait>"` is a hidden control token, and fake `askMessage` delegates to `ask`: it treats `q` as quit while the live multiline interface uses `/quit`. Broad double assertions hide missing SDK fields. Use typed script steps, share command parsing with the real UI, narrow the transport event surface or supply valid fixture builders, and replace polling sleeps with explicit readiness signals where practical. Temporary repositories/shared-config directories also need test-owned cleanup (`test/helpers.ts:27`, `test/helpers.ts:201`).

32. **Low — Prototype code contains the same imperative patterns, plus a string-derived success classification.** [prototypes/proto.ts:22](../prototypes/proto.ts#L22), [prototypes/proto.ts:71](../prototypes/proto.ts#L71), [prototypes/proto-codex.ts:67](../prototypes/proto-codex.ts#L67), [prototypes/proto-schema.ts:61](../prototypes/proto-schema.ts#L61), [prototypes/proto-schema.ts:101](../prototypes/proto-schema.ts#L101), [prototypes/proto-schema.ts:130](../prototypes/proto-schema.ts#L130).

    Prototypes perform top-level SDK/filesystem/terminal I/O, mutate answer/summary objects and counters, cast parsed JSON, use `any`, read ambient time, and mutate a result string during streaming. This is acceptable exploratory scaffolding outside the program. The schema prototype is also used as acceptance evidence, though: it counts any line containing `": accepted"` as accepted, including an accepted reply that “DOES NOT DECODE.” Represent transport acceptance and successful decoding separately and render text from that result. Preserve historical artifacts; if the prototype remains an upgrade tool, turn the result classifier into a small tested function.

**Recommendations**

**A. Keep Effect as the shell; strengthen a pure domain core.**

The program already makes good use of injected services, schema-derived types, tagged errors, scoped terminal resources, cancellation, and pure prompt/log helpers. Retain that foundation and the documented behavior in `CLAUDE.md` and `docs/history.md`. A second wholesale rewrite would provide less value than extracting the remaining policy.

Use the following dependency direction, with module boundaries driven by responsibility rather than a mandatory directory hierarchy:

```text
CLI composition
      |
      v
Effect workflows ----> pure domain types / validation / transitions
      |
      v
service capabilities
      |
      v
SDK, terminal, record-store, filesystem/Git adapters
```

Start with pure functions for validated rounds, pause detection, review progress, SDK outcome interpretation, usage summaries, and snapshot differences. Return structured findings/events and render their messages separately. `describeChange` should return `Added | Removed | ContentChanged | StatusChanged` records, not ready-made diagnostic strings. A snapshot should specify exactly which working-tree/index/untracked state it observes; collect a complete representation for that policy before comparing it. Use machine-readable Git output and explicit path normalization/exclusions.

Do not confuse pure construction of an Effect with pure execution: a function returning a filesystem Effect can be referentially transparent as a *description*, while running it still changes the world. Expected errors belong in values or Effect's error channel; wrapping an eager throw or clock read after the fact does not achieve that separation.

**B. Separate wire schemas from validated domain values.**

The seven proven agent schemas can remain compatible initially. Add a normalization step after structural decoding that turns their empty strings, broad products, and IDs into internal variants. For example, keep the SDK's flat execution report but normalize it into an internal outcome union with only fields relevant to its status. Normalize issue references into optional branded IDs, then validate them against history.

Define a validated round that guarantees unique IDs, complete dispositions, and an explicit policy for self-correction overlap. The pure log transition should consume that value, so “missing disposition” is unrepresentable there. Use one derived action vocabulary for schemas and internal logic. Introduce brands selectively for identifiers, phase/round counts, record paths, and digests; branding every sentence would add ceremony without preventing a realistic mistake.

Keep historical JSON compatibility through versioned readers or conversion functions if persisted shapes change. A stricter internal model does not require silently changing agent contracts, the one-repair rule, execution's stop precedence, or user-approved workflow behavior.

**C. Make workflow state and ownership explicit.**

Replace the review loop's parallel arrays and closure flags with readonly state containing the round, limit, idle count, log, and identified observations. Extract a small pure transition for each meaningful stage before attempting a single large reducer. Preserve pause ordering deliberately: several decisions can apply within one round, so a naive set of unordered checks would change behavior.

A possible conceptual signature is:

```ts
type Transition = Readonly<{
  state: ReviewState;
  commands: readonly ReviewCommand[];
}>;

// Pure: validated domain values in; next state and requested actions out.
declare function advance(state: ReviewState, event: ReviewEvent): Transition;
```

The Effect interpreter executes commands, feeds back their results, and persists committed transitions. Use a discriminated command union, not a new collection of arbitrary command strings. Keep a simple generator for straightforward sequential work. This approach prepares for resume without pretending that replaying a journal can safely repeat agent calls or file edits: resumed execution needs explicit idempotency and completion rules.

Give each review loop its own initialized reviewer session. Give each planner execution its own stop state. Keep SDK callback-to-Effect execution in the adapter, enforce serialized dialogue, and preserve abort/stream finalization on every error path. Use effect-aware queues/references only where state crosses callbacks or fibers; readonly accumulator values are sufficient for ordinary pure transitions.

**D. Improve organization at the points where concepts currently cross boundaries.**

Extract usage aggregation and rendering from Store; split JSON decoding from snapshot comparison in `state.ts`; move config parsing/loading out of the storage implementation; separate live platform wiring from persistence. Separate conversation execution from the question-phase coordinator to remove the `interview`/`subjects` cycle. Move record rendering out of orchestration while leaving natural-language agent prompts in `prompts.ts`.

Centralize an artifact catalog that maps typed subject/phase/round identity to paths. Let Store offer operations such as saving a round or appending a decision rather than forcing every workflow to construct paths and arbitrary JSON. Retain lower-level file operations inside the adapter. Replace the two-output `Subject` escape hatch with typed operations. Avoid overfragmentation: the codebase is small enough that a handful of cohesive modules is preferable to a framework of tiny services.

Make clocks, IDs, and serialization explicit effect dependencies. Use exclusive names and atomic replacement for records, then introduce a committed-round/checkpoint concept before adding resume. Treat transcript Markdown as a projection for people, not the only representation of important decisions.

**E. Property-based tests would add substantial value in the pure core.**

_Note of 30 Sep 2026 (issue #66): this table is the record of where property testing began in this program. It no longer lists what authorizes each use: CLAUDE.md, under Rules for changes, has property tests written wherever a function is pure and an invariant can be stated over arbitrary input._

Prioritize the following properties. Generate valid domain objects directly and separately generate invalid boundary data; filtering arbitrary JSON until it happens to be valid gives poor coverage. Preserve seeds and shrink failures to small counterexamples. No property-testing dependency was added in this review; adopting one would need to follow the repository's dependency policy. Small deterministic exhaustive generators can cover finite action combinations in the meantime.

| Target and existing test anchor | Properties worth checking | Priority |
|---|---|---|
| Round validation/log transitions — `src/issueLog.ts:37`, `test/run.test.ts:10` | Inputs are unchanged; every validated review issue gets exactly one entry; duplicate/extra/missing dispositions fail validation; unrelated IDs retain their current meaning; appending a user decision supersedes earlier entries for that ID; valid transitions preserve the chosen one-current-entry invariant. Define overlap semantics before asserting that invariant. | Highest |
| Issue detection/counting — `src/issueLog.ts:12`, `src/issueLog.ts:88` | Reraised IDs come from both the current nonaccepted history and current review; second clarification requires earlier clarification; counted issues with minor excluded never exceed total issues; a bijective renaming of IDs preserves decisions/counts. Do not require permutation invariance for chronological history. | High |
| Review transitions — `src/review.ts:132`, `test/run.test.ts:91` | At most one repair attempt; repair retains session identity; execution stop precedes report interpretation; no execution before convergence or explicit proceed; progress counters follow policy; every recorded hash retains its true round/stage after idle decisions. Compare bounded generated event traces with a simple independent model. | Highest after extraction |
| Snapshot comparison/Git decoding — `src/state.ts:33`, `test/state.test.ts:121` | Comparing a snapshot to itself yields no changes; changing each represented component is detected; normalization respects directory boundaries; ordering of equivalent status records does not alter the semantic result; additions/deletions are reported. Add generated temp-repository cases for staged/untracked changes, renames, tabs/newlines/quotes, ignored paths, and symlinks. | Highest |
| Schema/domain validation — `src/schema.ts:9`, `test/schema.test.ts:35`, `test/config.test.ts:32` | Encode/decode round trips preserve normalized values; negative/fractional/unsafe counts fail; empty required identifiers fail; references/defaults obey membership constraints; configuration override is right-biased by supplied key and rejects unknown keys. Keep normalization-aware equality and explicit permitted-zero cases. | High |
| Terminal choice parsing — `src/claude.ts:51`, `test/ui.test.ts:1` | Only an entire in-range integer selects an option; other text is preserved; multiline parsing preserves content except documented trimming; command parsing agrees between fake and live UI. Bounded event sequences test EOF/cancellation separately from text parsing. | High |
| Usage fold — `src/store.ts:157`, `test/state.test.ts:176` | Claude cost equals the sum of each identified session's last reported numeric total; earlier totals for that session do not change final cost; Codex token counts add; interleaving independent sessions preserves totals when each session's internal order is preserved. Unknown-session behavior follows its explicit policy. | High |
| JSON Schema fallback — `src/jsonSchema.ts:27`, `test/jsonSchema.test.ts:23` | For the supported acyclic schema subset: deterministic, input-preserving, idempotent transform; every object is closed and required keys match properties. Dangling/cyclic/unsupported references produce typed rejection, not undefined or nontermination. Limit graph depth/size and do not assume semantic equivalence: requiring optional keys intentionally changes it. | Medium; fallback is inactive |
| Decision/record projection — `src/store.ts:147`, `src/review.ts:252` | One decision event produces consistent issue-log and transcript identities; rendering does not change semantic data; checkpoint recovery rejects or identifies incomplete transitions. Inject write failures around persistence boundaries. | Medium |
| Plan validation (issue #6, 28 Sep 2026) — `src/plan.ts`, `test/plan.property.test.ts` | A valid recorded plan revised to its own steps is itself, statuses included: `validatePlan(p, stripStatuses(p))` is `p`, without notes. | High |
| Rendered plan (issue #6, decision F2) — `src/plan.ts`, `test/plan.property.test.ts` | `plan.md` rendered from a plan reads back, by a reader of the test's own, as that plan: every stage title, step id, number, label, text and status. | High |

Keep example tests for exact prompts, archive layout, exit codes, SDK options, cancellation, and known regressions. Generated tests against real LLMs would be slow, nondeterministic, and poor at shrinking; use scripted transports. Type-level readonly/variant checks belong in compile-time tests. Historical schema fixtures remain useful compatibility evidence, but should not prevent intentional improvements to the internal domain model.

**F. Refactor in order of observable benefit.**

First add regression cases for findings 1–3, 14, 18, and the fake/live command mismatch. Then implement validated rounds, structured snapshots, and complete numeric-choice parsing. Next extract progress/history policy and usage calculation into pure functions and add their laws. Follow with typed subject operations, reviewer session ownership, callback decoding, and typed errors. Finally narrow Store, remove the module cycle, add persistence checkpoints, and decide whether resume justifies a durable event log.

For a class, show three contrasting examples: `issueLog` demonstrates mostly pure domain transformation with a hidden precondition; `reviewLoop` demonstrates why effectful orchestration still benefits from a pure transition core; `terminalUi` demonstrates necessary mutable resource ownership at the boundary. The aim is explicit invariants, composability, and predictable effects—not mechanically replacing every loop with recursion or every mutable builder with repeated copying.

**Review scope and verification**

Reviewed all production modules in `src/`, the test architecture and relevant examples, the three prototype scripts, and the documented design history. Shell/container launch scaffolding and generated historical run records are not application-domain FP examples. Findings distinguish confirmed behavior from conditional concurrency risks and design tradeoffs; this is a static review with targeted local checks, not a claim of exhaustive behavioral verification.

`npm test` passed: **115 tests, 0 failures** (including TypeScript checking). Small read-only checks confirmed conflicting duplicate-disposition accounting, duplicate current log entries, acceptance of a negative fractional limit, an undetected new diff-map entry, a missing schema reference returning `undefined`, and prefix-based numeric parsing. No real agents were called. This Markdown report is the only repository change.

**Disposition (applied 25 Sep 2026)**

Every finding was applied in the order of recommendation F, by the plan this program made for itself (`plan-review/plan.md` of that run) and carried out by hand after the run halted on a Codex usage limit. Test first throughout; each commit message records the failures observed before the change. Commits: stage 0 `a33c9a9`, stage 1 `8cff739`, stage 2 `2df7977`, stage 3 `3e84f05`, stage 4 `99a4b70`, stage 5 `aed0285`, the approved wiring files `c1cbe48`. Product decisions were taken in the question phase of that run (Q1–Q8 of its `requirements.md`). "Kept" marks a part deliberately not done, with the reason.

| Finding | Outcome | Commits |
|---|---|---|
| 1 | Done: appearing and disappearing entries are reported (1.1); the snapshot is git's porcelain v2 output with the working-tree entry of every listed path (file hash, link target, directory, missing; decision Q1) and laws over generated snapshots. Kept: gitignored files stay unobserved (Q1) | `8cff739`, `2df7977` |
| 2 | Done: one exclusion predicate for `plan-review/` and `ignorePaths`, NUL-delimited output, porcelain v2 records, renames | `8cff739`, `2df7977` |
| 3 | Done: `RoundInvalid` halts for duplicate review ids (before the convergence shortcut) and for duplicate, missing or extra dispositions; validated review and round; overlap order of decision Q2; laws | `8cff739`, `2df7977` |
| 4 | Done: `appendRound` takes the validated round; readonly collections; nothing throws | `2df7977` |
| 5 | Done: safe integers with ranges, bounded extra-round parsing, nonnegative costs, non-empty record identifiers. Kept: phase 0 as the phase of the question and requirements logs (the subject is the log file) | `8cff739`, `2df7977` |
| 6 | Done: log entries are a union tagged by `source` with closed action sets; version-2 files (logs, usage, questions, `round-<n>.json` as `validated` / `no_response`), decision Q5. The readers of the old shape and the converter were removed on the developer's instruction the same day: only the current shape is read | `99a4b70`, `c1cbe48`, and the removal commit after `2e22490` |
| 7 | Done: `IssueId` brand, empty required ids rejected, the `""` wire sentinels normalised to `null`, references validated against the history (decision Q3), a generated-id collision is invalid. Kept: session ids and hashes are not branded (recommendation B's "selectively"); paths are branded where 4.7 and 5.1 need them | `2df7977`, `99a4b70` |
| 8 | Done: interview turns, execution reports and the question list become variants after decoding; no coverage check (decision Q4); a default that names no proposed answer is null with a note; duplicate ids halt with `QuestionListInvalid` | `99a4b70` |
| 9 | Done: per-agent usage records, the unknown-session policy of decision Q8, a structured summary | `3e84f05`, `99a4b70` |
| 10 | Done: `Result`-returning decoders, `lift` removed, the callback failure in a typed `Deferred`, `haltMessage` validates the payload of a tag (`decodeRunError`). `isRunError` deleted rather than split: after the `Deferred` no value crosses a Promise boundary inside the program | `99a4b70` |
| 11 | Done: typed start-up failures; `startPhase` returns a `ReviewSession` bound to its thread, held by the loop | `8cff739`, `99a4b70` |
| 12 | Done: `Subject<R, D>` with two operations typed by their schemas | `99a4b70` |
| 13 | Done: the review loop is `advance(state, event)` plus an interpreter (decision Q7); bounded event traces against an independent model | `3e84f05` |
| 14 | Done: observations `{ round, stage, hash }` name the right round | `8cff739`, `3e84f05` |
| 15 | Done: one `DecisionEvent`, from which the record lines and the log entry derive; a decision on a reraised issue reaches the log | `3e84f05` |
| 16 | Done: JSON records written to a temporary name and renamed into place; `checkpoint.json` names the last committed transition and its reader verifies the named records (decision Q6). Kept: resume itself (the task's limit) | `aed0285` |
| 17 | Done: the `AskUserQuestion` input and the edit target are decoded; malformed data is a typed failure of the call | `99a4b70` |
| 18 | Done: only a whole in-range integer chooses an option; answers keyed by question index; duplicate question texts noted at the edge | `8cff739`, `2df7977` |
| 19 | Done: pure reduction of the message list (`partial` explicit) and pure outcome interpretation; the adapter keeps the stream, cancellation and persistence | `99a4b70` |
| 20 | Done: the stop is per execution call; the terminal dialogue is serialized with a `Semaphore` | `99a4b70` |
| 21 | Done: edit targets resolved through symlinks before the check; `ProjectPath` / `RecordPath` brands; race policy recorded (hook time, then the snapshot comparison). Container arrangement and Codex sandbox mode unchanged | `99a4b70` |
| 22 | Done: time and serialization inside the effect, the store owns the timestamp, the Clock service is the source of time | `8cff739`, `aed0285` |
| 23 | Done: invalid-reply files created exclusively with the number retried; a second archive in the same clock instant gets a suffix | `aed0285` |
| 24 | Done: `strictJsonSchema` is total (`Result<Json, UnsupportedSchema>`: dangling, cyclic, sibling and depth rejections) with laws on generated acyclic graphs; the raw path the agents receive is unchanged | `99a4b70` |
| 25 | Done: `planningCall` reports its repair, command variants, `askNonEmpty`. Kept: the sequential loops of `run.ts` (the review's own caveat) | `3e84f05` |
| 26 | Done: readonly views for the exchanged records, checked at compile time. Kept: no runtime freezing in production (the review's caveat) | `2df7977`, `99a4b70` |
| 27 | Done: the usage fold extracted; the Store offers one operation per artifact of the catalog and no path-taking write; config and platform split out; rendering in `src/render.ts` | `3e84f05`, `aed0285` |
| 28 | Done: the artifact catalog (`src/artifacts.ts`) and the interview in its own module; `test/modules.test.ts` keeps the value-import graph acyclic. Kept: a structured plan-step format (natural-language plans are a product feature) | `aed0285` |
| 29 | Done: `liveSdk()` is a factory. Kept: local builders, terminal callbacks and the composition root as the boundaries they are | `c1cbe48` |
| 30 | Done: every row of the table in recommendation E has a property test (below); scenario and fixture tests kept | `a33c9a9` – `aed0285` |
| 31 | Done: shared command parsing between the fake and the live Ui, typed script steps, cleanup of temporary directories, readiness signals instead of sleeps where the double can expose one. Kept: the broad casts of `test/fakeSdk.ts` (the fake carries only what the adapters read) | `8cff739`, `2df7977` |
| 32 | Done: `prototypes/classify.ts` counts a call as accepted only when its reply decoded; the run record and the other prototypes are unchanged | `aed0285` |

The properties of recommendation E, with `fast-check` 4.10.2 (numRuns 150–200, seed 20260925; generators build valid values directly and invalid boundary data separately):

| Row | Property test |
|---|---|
| Round validation / log transitions | `test/round.property.test.ts` |
| Issue detection / counting | `test/round.property.test.ts` (detection and counting laws; renaming) |
| Review transitions | `test/reviewState.property.test.ts` |
| Snapshot comparison / git decoding | `test/snapshot.property.test.ts` |
| Schema / domain validation | `test/schema.property.test.ts`, `test/schemaNormalize.property.test.ts` |
| Terminal choice parsing | `test/input.property.test.ts` |
| Usage fold | `test/usage.property.test.ts` |
| JSON Schema fallback | `test/jsonSchema.property.test.ts` |
| Decision / record projection | `test/checkpoint.property.test.ts` |

Note (26 Sep 2026, finding 9 of `docs/gui-review.md`): the exclusion property that the web GUI added to
`test/snapshot.property.test.ts` compared `excludedIndexPaths` with `excluded`, so it could not test the policy the
two share. It was deleted and replaced there by a property against an independent statement of the path policy
(`plan-review/` at the root only, look-alike names, literal glob characters, entry prefixes). In
`test/reviewState.property.test.ts` the driver now takes the script of the round each command belongs to, and a
work review's first exit, its round and its pauses are checked against an independent model of behaviour 7.

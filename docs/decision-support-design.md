# Decision support: design note

**Status: a proposal for the developer to check. Nothing here is decided behavior yet.** The
developer settled four points on 28 Sep 2026; they are marked **Decided** below.

This note describes a new part of the program: whenever the user must choose between options,
Interloq offers to work out the arguments for and against each one before the user chooses. The form
of that analysis is fixed by `docs/decision-making.md`, which is the authority for its content and
layout; this note covers everything else — where the offer appears, what happens when it is taken,
what is recorded, and how the result is shown.

## 1. The rule

Any time the user is given a choice between two or more options, the program must offer to help the
user make that choice.

There is no exception and no list of qualifying prompts to maintain: the rule is a property of the
prompt, namely that it offers more than one option. A prompt that offers a single action is not a
choice between options and carries no offer.

Applying the rule to the prompt catalog in `src/userPrompts.ts` as it stands today:

| Prompt | Options | Offer |
|---|---|---|
| A clarification question | its numbered answers | yes |
| A question Claude raises mid-implementation | the options it supplies | yes |
| A decision at a review-loop pause | the reviewer's and the planner's positions | yes |
| A permission request | Allow, Deny | yes |
| The cycle limit | Proceed, Stop | yes |
| Confirm the summary | Confirm | no — one action |
| Start planning | Start planning | no — one action |

Quit is present on every prompt as an escape from the program, not as an option of the question, and
does not make a single-action prompt into a choice.

The offer is **one button per question**, not one per option: the analysis covers the whole decision.
Its label is "Help me decide".

The rule binds both interfaces. The page shows a button; the terminal, which has no buttons, offers
it the way it offers every other choice.

## 2. What happens when it is taken

A decision loop runs. It has the same shape as the four review loops the program already runs, and
for the same reason: a single pass by one agent is not trusted, so the other reviews it and the two
cycle until the reviewer raises nothing.

1. Claude Code produces the representation of the arguments, following `docs/decision-making.md`.
2. Codex reviews it against that same document and against the context of the run.
3. Claude Code responds to each issue with one of the five dispositions, as in every other loop.
4. Cycles continue until a review raises no counted issue.
5. The representation is shown to the user, who then answers the original question.

The pause conditions of decided behavior 7 apply unchanged, including the cycle limit — and the
prompt at that limit is itself a choice between options, so it too carries the offer.

Validation follows decided behavior 10: a reply that does not match its schema is kept in
`invalid-replies/` and the agent gets one repair turn; a second mismatch stops the run.

The analysis call is a planning call under decided behavior 3. It may write only under
`plan-review/`, and it cannot reach the network. Everything it reasons from must already be in the
project or in the prompt.

## 3. Where it sits in a run

A decision loop is a loop inside a phase, exactly as the question review sits inside requirements
gathering and the plan review sits inside planning. It is not a phase of its own.

Nothing about the run's phases changes. The user who was answering question 3 is still answering
question 3 afterward. The progress panel is unchanged.

Unlike the existing loops, a decision loop can occur inside any phase, so its name alone does not say
where it happened. Decisions are therefore numbered in order across the whole run — decision 1,
decision 2, decision 3 — and the phase recorded alongside them in the checkpoint says where each one
took place.

**Decisions may contain decisions.** While a decision loop runs, Claude may ask the user something,
and that question carries the offer like any other. The nesting is unbounded in principle; in
practice it is bounded by the user, who must press the button each time.

## 4. Records

Decided behavior 8 fixes the records of every loop, and `src/artifacts.ts` is the catalog that no
workflow may bypass. A decision loop needs its own entries, which means behavior 8 is amended — the
developer's instruction is required for that.

| What | Proposal |
|---|---|
| `SubjectId` variant | `{ decision: k }`, k counted across the run |
| Subject directory | `decision-<k>/` |
| Per-cycle files | `review-<n>.json`, `cc-<n>.json`, `round-<n>.json`, as every loop has |
| Log file | `decision-log.json`, `{ version: 2, entries }` — a fifth log; behavior 8 currently names four |
| Reviewed file | `decision-<k>/analysis.json`, a new artifact kind |
| Issue id prefix | `D<k>-R<n>-<i>` |
| Checkpoint subject | `decision-<k>`, with the phase in the existing `phase` field |

**Decided, 28 Sep 2026:** behavior 8 may gain a fifth log and a fifth loop directory. The amendment
to `CLAUDE.md` is part of the work, not a reason to stop and ask.

`guardedRecord` needs no change: it is a denylist, so new paths under `plan-review/` are guarded
automatically.

The question that prompted the decision, the representation, and the option the user finally chose
should all be recoverable afterward. `user-decisions.md` already records the user's decisions at
review pauses and is the natural place for the choice; the representation itself is the reviewed
file above.

## 5. The representation is structured data

Not prose. Codex must review it against a specification with numbered requirements, and the page must
render columns, nested argument chains and cross-references, so the shape has to be machine-readable.
That means a new Effect Schema in `src/schema.ts`, which also generates the JSON Schema the agents
receive.

The shape follows `docs/decision-making.md`. Four things in that document drive the design:

- **Every entry has seven elements** ("Elements of an advantage or disadvantage"): comparative condition, starting cause, intermediate
  steps, threshold, effect on persons, reason the effect matters, extent of the effect. The extent
  has four parts of its own ("Elements of an advantage or disadvantage"). These are fields, not free text, even though each is written as
  prose sentences.
- **Counterarguments attach to an element, not to the entry** ("Layout and wording" and
  "Counterarguments", as the developer revised them on 28 Sep 2026). Each counterargument sits
  immediately after the one element of the seven that it disputes and begins with "But,". So every
  element carries its own list, rather than the entry carrying one list at its end.
- **Counterarguments nest without limit** ("Counterarguments"): under each counterargument its defenses, under each
  defense its further counterarguments, "until no further counterargument or defense exists". The
  schema is therefore recursive. Whether Effect Schema's recursive types survive the JSON Schema
  generation that both agents accept is the first thing to verify — the seven existing schemas were
  proved to work in `prototypes/proto-schema.ts`, and this one should be proved the same way before
  it is built.
- **Entries are cross-referenced by symbol** ("Equivalence symbols"): a counterargument equivalent to an entry
  elsewhere is written once and marked, and the symbols are assigned in a fixed sequence. Symbols are
  a rendering concern derived from the references; the data needs stable entry identifiers so that a
  reference points at something, and the renderer assigns the symbols.
- **Reversals point at entries too** ("Reversals"), and are listed in full in a column while appearing as a
  single sentence with a symbol under the entry they counter.

An open question for the schema: the document requires that a claim derived by reasoning must not be
labeled as reasoning ("Source of each claim"), and that unknown values are stated as unknown with the measurement that
would settle them ("Source of each claim"). Both are properties of the prose inside a field, so neither is enforceable
by the schema; they are for Codex to check in review.

## 6. Context

`docs/decision-making.md` requires the system, its users and its constraints as input ("Inputs"), and
forbids assuming a value the input does not contain ("Inputs").

The prompt should therefore carry whatever exists at that moment: the task, `requirements.md` and
`plan.md` when they exist, the phase, and the question itself with its options. The project is
readable during a planning call, so Claude can consult the code.

The hardest case is the earliest one. During requirements gathering there is no `requirements.md` and
no `plan.md`, and that is exactly where the user is most likely to want help. Analyses there will be
dense with "this is unknown", which the document requires rather than forbids, but the developer
should see one before judging whether it is useful.

## 7. Showing the result

`docs/decision-making.md` specifies one column per option ("Layout and wording"). That is straightforward on a wide
window and impossible at 390 px, where the page already shows one panel at a time.

**Decided, 28 Sep 2026:**

- **Where it appears.** A separate browser window if that can be done; otherwise the representation
  covers both chat columns until the user chooses. A window opened from the button's click is
  permitted by browsers, because the click is a user gesture, but a second window is a second page
  with its own connection to the server and its own copy of the run's state. Build the in-page form
  first and treat the separate window as a later addition.
- **Below 390 px.** No attempt to lay the representation out. A message tells the user to enlarge the
  window.
- **The recommendation.** Neither required nor prohibited. The agent producing the representation may
  recommend one option, and if it does, the recommendation must carry the affirmative case that the
  document's "Recommendation" section describes. So the schema has an optional recommendation, and
  Codex checks that a recommendation that is present is supported as required.

- **The terminal.** It has no columns, so the arguments for and against each option are shown one
  after another.

Details the renderer owns rather than the agent: the heading "Disadvantages:" above the second half
of each column, the visual offset of a counterargument from the element it disputes — indentation or
parentheses, the document allows either — and the symbol sequence ("Equivalence symbols").

**Amended, 28 Sep 2026 (issue #35), with `docs/decision-making.md`:**

- **The header** is `Decision <k>: ` and the question alone: not the record of an earlier answer, the
  options or the default. For an interview turn the question is the turn's `current_question`, and an
  agreed question's id is written out, "Question 4: " (a follow-up's "Follow-up question 2: ").
- **Both headings**, "Advantages:" and "Disadvantages:", and each entry **labeled** within its heading,
  "Advantage 1:", "Disadvantage 2:", numbered from one in each heading of each column. The renderer
  owns them, as it owns the symbols.
- **Which side a text is on.** A text is shown in the scheme's error color exactly when it argues
  against the column's option: a disadvantage, its title and its elements; a counterargument to an
  advantage; a defense under a disadvantage; and so on, each level of reply turning the side. The
  headings and the option's name keep their color. The terminal, which has no color, puts `✗ ` after
  the indentation of those lines.
- **An unclear option.** A column is argued or unclear. An unclear column carries, in place of the
  option's arguments, what is unclear about it and which readings are possible, and is shown under
  the option's heading in place of the two headings.

### The wait (issue #153)

While the analysis is prepared, the question stays on the page with its choices, its context, its attached material and
its term explanations, and the status line reports the wait beside it; it carries neither "Help me decide" nor "Explain
the terms". Its controls stay live. An answer given during the wait abandons the decision: Interloq interrupts the
decision loop, records the answer in `decision-<k>/chosen.json`, writes the abandoned line and the choice to
`conversation.md`, says the abandoned line on the page, and returns the answer as if no help had been asked for; the
analysis files written so far stay. The decision's allocation is uninterruptible, so every allocated decision gets these
records. Whichever of the answer and the finished analysis reaches the server first wins. A question the decision loop
asks before the analysis is ready takes the question's place, and the question returns, as the same prompt, when that
question's whole asking has ended; Help me decide on it follows the same rule, so no nested decision is open when an
outer one is abandoned. A question being analyzed raises no notification and no waiting mark.

## 8. What this costs

A decision loop is a full review loop: at least one Claude Code call and one Codex turn, and more if
the review raises issues. The completeness requirement ("Completeness") — every argument an informed person
could make, every counterargument, every defense — is unbounded by construction, and Codex reviewing
for completeness has an obvious way to raise an issue in every cycle.

Two consequences the developer should weigh:

- **The cycle limit is the only bound**, and reaching it produces a prompt that itself offers the
  button.
- **A permission request is answered with an agent call in flight.** Claude is mid-turn, waiting.
  Taking the offer there holds that call open while a second agent conversation runs to convergence
  inside it. This works, but it is a different kind of interruption from the others, and it is worth
  knowing that the paused call's session is held for the duration.

## 9. Out of scope

- No change to the progress panel.
- No change to the phases of a run or to their numbering.
- No change to `docs/decision-making.md`, which is the authority for the analysis and is the
  developer's to edit.

## 10. What is still open

Nothing. The last item — whether a recursive schema survives the JSON Schema generation and both
agents — was proved on 28 Sep 2026 by `prototypes/proto-recursive-schema.ts`, run in the development
container against Opus 5.5 and gpt-6-astra. It carries one constraint into the work:

- **The representation's root must be a concrete object, never a bare `$ref`.** Codex accepted every
  schema tried, but the Agent SDK rejected the one whose root was `{"$ref": "#/$defs/..."}` with an
  "API Error:" after three seconds, twice, while accepting the two whose root was an object. All
  three were equally recursive, so the recursion is not the cause. `Schema.Struct` at the top gives
  the required shape at no cost.
- `Schema.suspend` generates a `$ref`/`$defs` cycle carrying `additionalProperties: false` and a
  complete `required` list — the shape the program already sends. Replies decoded with
  counterarguments nested three and four levels deep.
- `strictJsonSchema` rejects a recursive schema as `cyclic_ref`, by construction: it inlines every
  `$ref`, and a cycle cannot be inlined. The program sends the raw variant, so this costs nothing
  today, but the fallback that `src/jsonSchema.ts` documents does not exist for this schema.

Settled on 28 Sep 2026: behavior 8 may gain a fifth log and loop directory; the representation covers
both chat columns, or a separate window later, with a message to enlarge below 390 px; the terminal
shows each option's arguments one after another; a recommendation is optional but must carry its
affirmative case when made; the phase is called clarification, with issue #24 renaming the code to
match; and the developer revised `docs/decision-making.md` so that "Disadvantages:" heads only a
column's disadvantages while a counterargument begins with "But," beside the element it disputes.

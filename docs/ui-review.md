# Review of the web page (plan step 4.7, 26 Sep 2026)

The page (`web/src/`) checked against Jakob Nielsen's ten usability heuristics and against Material Design 3,
as CLAUDE.md's section "User interface" requires. "Changed" names what this review changed; each change has a test.

## Nielsen's heuristics

| Heuristic | Where the page satisfies it | Changed in this review |
|---|---|---|
| 1. Visibility of system status | Timeline rail with the whole run as far as it is known (issue #6): every phase done, active, stopped, ahead or not reached, a step its phase ended without as not needed, the rounds per review loop, and the plan's stages and steps under the Implementation that carries it out, with the step being worked on marked only while an execution call runs; an indeterminate progress indicator while an agent works, with the measured time of the current call beside it (issue #42); activity line with the current agent call and its last tool use; the connection chip in the app bar ("connected", "reconnecting…"); a notice when a queued action was discarded. Issue #50: the indicator is on the step that runs, its mark replaced by an indeterminate circular indicator with the current call's time beside the step, and the phase carries the linear indicator only while none of its steps runs; each phase shows how long it took, or has run. Issue #53: at most one plan step is current, the one the latest report started; a step left open reads as unfinished. Issue #54: an ended Implementation keeps the steps it acted on. Issue #51: the clarification and its follow-ups are one step | — |
| 2. Match between the system and the real world | Two chat panels like a messaging app, with the authors named (Interloq, You, Codex, Claude Code); the agents' Markdown rendered | Prompts were shown with the terminal's key conventions ("Enter = none, q = quit >"), which do not exist in the page; they are now stated in the page's words (`pagePromptText` in `src/prompts.ts`), and the buttons carry the choices. That removal was incomplete (finding 8 of `docs/gui-review.md`): the interview's opening still taught the terminal's `"""` convention, which the page does not implement. The opening is now the event `InterviewOpened`, which the terminal renders with `"""` and the page with Shift+Enter (`interviewHelp` in `src/prompts.ts`) |
| 3. User control and freedom | Stop task at any time (like Ctrl+C); Quit at every prompt, as in the terminal; the chat does not scroll away from a user who has scrolled up (a "new messages" chip instead); New task after the end | — |
| 4. Consistency and standards | Every button sends exactly the text the terminal would receive; one top app bar; M3 components and colour roles throughout | — |
| 5. Error prevention | Start is disabled until the directory and the task are filled and no run is active; the path is checked by the server before a run starts (a worktree's top-level directory); an unsent draft belongs to its prompt, and an answer from another tab withdraws it with a notice that quotes it, instead of leaving it under the next prompt; Enter while an input method is composing does not send; a failure to remember the directory never blocks Start; Stop is outlined, labelled "Stop task", placed in the app bar away from the prompt, and disabled without a run (no confirmation dialog, which behaviour 1 excludes) | — |
| 6. Recognition rather than recall | The directory browser; the last project path remembered; the fixed choices of a prompt as buttons; the interview's numbered answers and the options of a relayed question as cards that show the whole option (issue #12) | — |
| 7. Flexibility and efficiency of use | Buttons for the fixed choices and typing where free text is meaningful; Enter sends (Shift+Enter for a new line in a message), and a visible Send button does the same for touch and discovery | Findings 5 and 6 of `docs/gui-review.md`: a draft stayed attached to the next prompt after another tab answered, and Enter answered while an input method was composing. Both are fixed and tested (the draft over a live answer and over a replay; composition on both fields) |
| 8. Aesthetic and minimalist design | Only the newest run is shown; the agents' exchange is in its own panel; blank terminal lines and the interview's duplicated lines are not shown | Found in the end-to-end check (stage 5): an agent's message repeated its author as a "### Codex" heading, a review without issues showed only that heading, and the timeline repeated "Planning phase 1" under "Planning 1". The heading is dropped, an empty review reads "No issue: the review has converged.", and a phase names its review loops only when it has more than one |
| 9. Help users recognize, diagnose, and recover from errors | The server's refusal (a missing path, not a git repository, a run in progress) is the field's error text; halts and interruptions appear as the program's messages with the terminal's text, naming where the state is kept; answers made for an ended run are reported as not sent | — |
| 10. Help and documentation | The form's supporting texts; the answer fields' persistent labels ("Your answer", "Your message") and the hint under them; the interview's opening help in the page's own terms | The form did not say what happens after Start; it now explains the procedure in two sentences, where the records are kept, and what Stop task does |

## Material Design 3

- **Components** (m3-svelte 7.2.1): `Button` (filled for the primary action, tonal for other choices, outlined for Stop, Quit and Browse, text for Cancel), `Card` (outlined, one per option an agent proposes; issue #12), `TextFieldOutlined`, `TextFieldOutlinedMultiline`, `Dialog` (the directory browser), `Chip` (assist, elevated: "new messages"). Written by hand after the M3 guidelines, because m3-svelte has no such component: the indeterminate linear progress indicator (issue #42) and the rich tooltip of a plan step (issue #6). Issue #50: the indeterminate circular progress indicator (`CircularIndeterminate.svelte`), also written by hand.
- **Colour roles** from the tonal-spot 2025 scheme of m3-svelte's live theme (`--m3v-source`), light and dark through `color-scheme` / `light-dark()`: surface and surface containers for the panels, secondary container for the active phase, primary container for the user's messages, tertiary and secondary containers for Codex and Claude Code, error container for the reconnecting chip and the notices.
- **Typography**: the M3 type scale classes (`m3-font-title-large` for the app bar, `title-small` for panel headings, `body-*` for messages, `label-*` for authors and the chip).
- **Elevation**: the app bar at level 2; the dialog at m3-svelte's dialog elevation; the "new messages" chip elevated.
- **States**: disabled, hover, focus and pressed states come from m3-svelte's buttons; the hand-styled directory rows and answer fields have hover and focus-visible states in the scheme's colours.
- **Motion**: the indeterminate progress indicator's travelling segment (`web/src/theme.css`), replaced by a slow pulse in place when the user prefers reduced motion. The circular indicator's arc turns while it grows and shrinks (issue #50); with reduced motion the step's static glyph shows in its place.
- **Deviations**, each with what the substitute asserts, as CLAUDE.md's substitution rule requires (issue #43):
  - *The busy indicator.* Until 28 Sep 2026 `LinearProgressEstimate` of m3-svelte stood in for M3's indeterminate linear progress indicator, which m3-svelte lacks. It was not a substitute but a different statement: it filled the track over time toward completion, so it asserted an estimate of how much of the work was done and a coming end, which the program does not know (issue #42). It is replaced by the indeterminate indicator written by hand after M3 (`web/src/theme.css`, `TimelineRail.svelte`): a segment that travels along the track without end, `role="progressbar"` without `aria-valuenow`. It asserts that an agent is working, and nothing about how much remains, as the specified component does.
  - *The indicator during a retry* (issue #26, W1-R1-4). While the program waits to retry a call that lost its connection, no agent call runs, so the rail shows no indicator; the activity line shows the same hand-built indeterminate indicator (`Indeterminate.svelte`, shared with the rail), labeled "Waiting to retry the connection", beside "connection lost, retry n of m". It asserts that the program is busy waiting to retry, nothing about when the retry starts or whether it will succeed: no value, no countdown. The attempt count beside it counts the attempts made, which is a fact, not an estimate.
  - *The elapsed time beside it* ("running for m:ss") is an addition, not a substitute: it asserts the time measured since the publication of the current call's start event, which the program knows, and no estimate. A call nested in another (a decision inside an execution call) shows its own time, and the outer call's again when it ends.
  - *The circular indicator on a running step* (issue #50) is written by hand after M3's indeterminate circular progress indicator, which m3-svelte lacks: an SVG arc in primary on a secondary-container track, turning without end, in the mark's own 1em box, `role="progressbar"` without `aria-valuenow`, named for the step's state and the work. It asserts that an agent is working on this step and nothing about how much remains, as the specified component does. It appears only on a step the program knows to run: the active step of Gather Requirements while a call runs, or the plan step the latest `started` report of the running execution call named. The time beside it is the current call's; the phase's own time ("took m:ss", "m:ss so far") is measured from its PhaseBegan to its end.
  - *The marks of phases and steps* are text glyphs rather than Material Symbols, because an icon set would be another dependency: ✓ done, ● in progress, ■ stopped, ○ ahead, a muted ○ not reached, – not needed (a step whose phase ended without it: the dash asserts that the phase ended without needing the step, not that the step was done, nor that anything is left to do); for a step of the plan ✓ done, ● in progress, ◐ begun and not finished, ○ not begun. Each asserts the state its accessible name gives, the same state an icon would, and nothing more: no count, no progress within a step. A step is marked in progress only while an execution call runs; a step the last call began and did not finish is marked as such, not as current.
  - *The rich tooltip of a plan step* is written by hand after M3's rich tooltip, which m3-svelte lacks (`StepTooltip.svelte`): the surface container role, elevation level 2, the medium shape, a size limit with its own scrolling, placed inside the viewport, opened by hover and by keyboard focus, kept open by a click or tap, closed by Escape or leaving. Opened by hover, it stays open while the pointer moves from the step into it (a grace delay of 150 ms, W1-R1-1), so that a long text can be scrolled with the mouse. It asserts what the specified component asserts: supplementary text about the step it describes (the step's full text from the plan, rendered from Markdown and sanitized). It has no actions, so it claims no control the rich tooltip would offer.
  - *The disclosure of a decision's entry* (issue #87, 6 Oct 2026) is written by hand after M3's list item with an expand affordance, which m3-svelte lacks: a native button holding a chevron, the entry's label and its whole title (wrapped, never cut), a state layer of the on-surface color on hover (8 %), focus and press (10 %), a focus ring, and the standard easing for the chevron's turn and the body's appearance, none of it under reduced motion. It asserts that the entry is open or closed, through `aria-expanded` and the chevron, and nothing more. The warning mark beside an entry, in the error color and named "Contains an argument against this entry", asserts only that a text inside the entry argues the other side; it does not say how strong that text is. Which entries are open is shared by every tab of the run, held by the server for as long as it runs.
  - *The answer fields* are m3-svelte's outlined text fields with persistent labels, not substitutes; the deviation is their key behaviour: Enter sends, Shift+Enter adds a line in a message, and a filled Send button sits beside them. The fields assert what an outlined text field asserts, a place to type an answer; the hint under them states the keys, so the behaviour is not left to be guessed.

## Layout across window sizes (finding 7 of `docs/gui-review.md`, 26 Sep 2026)

The page was a fixed grid of a 14rem rail and two equal panels. At 390 px each panel was 59 px wide and the page
overflowed sideways; at a 200 % zoom of a desktop window (a 640 × 400 CSS viewport) the panels were 184 px wide. The
layout now follows M3's window size classes (`web/src/layout.ts`, `App.svelte`, `TopBar.svelte`):

- **Expanded (840 px and wider)**: unchanged, the rail and both panels side by side.
- **Below 840 px**: the rail becomes a one-line disclosure ("Progress: Planning 1, round 2 of 5") that opens the whole
  rail [visibility of system status: the current phase stays in view; aesthetic and minimalist design: the detail
  is one tap away]. One panel is shown at a time, chosen in an M3 segmented group labelled with the panels' own titles
  [consistency and standards: the same names as the wide page; recognition rather than recall]. The hidden panel's
  button counts its new messages ("· 3 new") [visibility of system status], and a new prompt selects "You and
  Interloq", where it is answered; otherwise only the user changes the panel [user control and freedom]. Below
  that height the page scrolls vertically, and a panel keeps at least 12.5rem.
- **The top bar** wraps: the title, the connection and Stop stay on the first line (the title at M3's 22 px below
  600 px), and the project and the task move to a second line.
- **The answer field** has the full width in every window, with the hint and Send on the row beneath it.
- **Corrections after work review 2** (W2-R1-1 to W2-R1-3): both panels stay mounted and CSS alone hides one, so a
  switch or a resize across 840 px keeps each panel's reading position [user control and freedom]; a panel that was
  hidden goes to its end when shown again if it was following, and otherwise keeps the user's place with the chip
  counting what arrived; the latest notice stands above the panels in a compact window, so the server's end or a
  withdrawn draft is seen whichever panel is shown [visibility of system status]; a new prompt is recognised by its
  full identity, so a new run's first prompt selects "You and Interloq" after a reconnection too.

`e2e/layout.spec.ts` checks, at 390 × 844 and at 640 × 400, that nothing overflows sideways, that the shown panel is
at least 300 px wide (and 400 or 200 px high) and the answer field at least 280 px wide, the panel switch, the badge
and the selection by a prompt; and at 1280 × 800 that the rail and both panels stand side by side.

## The agents' options as cards (issue #12, 27 Sep 2026)

An interview turn's numbered answers and a relayed question's options were m3-svelte `Button`s in the row of the
fixed choices, the first filled. An option can run to a paragraph, and a button's fixed 40 dp height cannot hold one:
the label spilled out of every button, over its neighbours in a wide window and below it in a narrow one. The
developer's decisions of the interview:

- **Cards with the full text** (Q1): each option is an outlined M3 `Card` rendered as a native button, one per row in
  a group named "Proposed answers", above the fixed choices. The user reads the whole option where it is chosen
  [error prevention; recognition rather than recall]; the repetition of the text of the message above is accepted for
  that. The card sends only the number, as the button did, and is operated by keyboard like any button.
- **The transcript keeps the full line** (Q2): the user's message is the chosen option's whole line.
- **No implied default** (Q3): every option has the same variant, because the agent's first option is not
  necessarily its default [consistency and standards]; the fixed prompts keep their filled primary action.
- **Both kinds of agent option** (Q4): the interview's and a relayed question's.

Several paragraphs scroll within their group (at most a quarter of the window's height), so that the answer field,
Send and the fixed choices stay in a phone's window. `e2e/layout.spec.ts` (L9) checks, at 390 × 844 and at
1280 × 800, that each of three paragraph options fits its card, that nothing overflows sideways, that the field,
Send and End interview are in the window, and that a card chosen with the keyboard sends its number and leaves its
full line in the transcript. The terminal is unchanged: it never rendered these choices.

## The confirmation before a run ends (issue #25, 29 Sep 2026)

End the run, Stop task and Stop at the cycle limit ended the run on one click or one typed answer, although a run
cannot be resumed. Every submission that ends the run now opens an M3 `Dialog` first, whether it is a click on the
button, `q` or `/quit` typed with Enter or Send, or at the cycle limit any answer that stops it (`0`, an empty answer,
anything that is neither `p` nor a count). The page and the terminal decide by one predicate, `endingOf` in
`src/input.ts` [consistency and standards]. The dialog says what ends, that the records in `plan-review/` remain, and
the exit code: 130 for End the run and Stop task, which are interruptions, and 1 for Stop at the cycle limit, which is
a halt [visibility of system status; error prevention]. Only its confirming button sends the answer or the stop.
Cancel closes it, keeps the typed text in the field and returns focus to the control [user control and freedom]. The
run-ending buttons (End the run in the question pane, Stop task in the top bar) and the confirming button use M3's
error color role, the role of a destructive action. End the run stands apart at the end of the row of choices. Ctrl+C in
the server's terminal is unchanged and asks nothing.

A confirmation is bound to what it was opened for (W2-R1-1, P3-R1-1, 30 Sep 2026): Stop task to the server's
incarnation and the run, End the run to the prompt's full key (incarnation, run, prompt). If another tab answers the
prompt, the run ends, or another run or server start takes its place while the dialog is open, the dialog closes
without acting, so confirming can never stop another run or answer another prompt [error prevention].

## The question pane and the explanations of terms (issues #46, #59, #36, #20; 29 Sep 2026)

**One presentation for every question.** Every question the user is asked, whatever produced it, is presented the
same way in the terminal and in the page: its number in the run, where it came from in ordinary words, a context
paragraph, what it is about (a pause's facts as prose, the summary to confirm, a permission's input), its terms and
their explanations, the question itself, and its options with the answer that chooses each [consistency and standards;
match between the system and the real world]. A context the program wrote is marked as such [visibility of system
status].

**The question takes the left column** (decision Q10). While a prompt is pending, `QuestionPane` replaces the
transcript in the left column. From top to bottom it has the heading and origin; a top region that scrolls on its own,
with the context, the details and the terms; the question, fixed between the regions and never inside a scrolled one;
and a bottom region that scrolls on its own, with the option cards, the field and the buttons. The question and its
first option stay in view together at 390 × 844, 640 × 400 and 1280 × 800 (`e2e/layout.spec.ts`, L19), so a long
transcript can no longer scroll the question out of view (issue #20) [recognition rather than recall; visibility of
system status]. The context takes at most three tenths of the pane. The transcript is one click away ("Show the
conversation") and back ("Back to the question"), and an answer gives the column back to the transcript [user control
and freedom]. The question joins the transcript with its answer once it is answered. Beside a decision's analysis,
which shows the question with its context and terms, the pane keeps only the answers, so the question is not shown
twice [aesthetic and minimalist design]. What the question is about (a permission's input, a pause's facts, an
agreed question's reason) follows the context in the same region (W3-R1-3), as the terminal prints it. There only the
context scrolls, in a region of its own about one and a half
lines high (2.75rem), and the question text follows it outside any scrolled region, so a long context cannot push the question
out of view while its answers are shown (W2-R1-2; L20 at 390 × 844 and 640 × 400).

A permission request's tool input is shown literally (W3-R1-2, P4-R1-1, 30 Sep 2026): every text value is set as code,
its delimiters chosen so that no character of it is read as Markdown or HTML and no space at its edges is lost. The
empty text and a value of spaces alone, which code cannot show, read "(empty text)" and "(n spaces)". What the user is
asked to allow is exactly what Claude Code would do [visibility of system status; error prevention].

Since S48 (P5-R1-1, P5-R1-2), a value of whitespace alone is named as its runs in order ("(1 tab, then 2 spaces)"), so
that two values with the same characters in another order never look alike. A character that a code span or the browser
would change or hide (a carriage return, a control or zero-width character, a special space at an edge) is written as a
visible escape of plain ASCII characters, with a note saying what the escapes stand for. The value shown is then the
value allowed, character for character [visibility of system status; error prevention].

A line break at the start or end of a multi-line value is written as the escape `\n` too (S54, W3-R1-2 of work review 6): a
fenced block drops the last line break of its content, so "a\nb" and "a\nb\n" would otherwise look alike. The line breaks
between the lines stay real.

A field that Interloq has no plain label for shows its own name the same way, as code on one line, with every line break
and every hidden character written as its escape (S55, W6-R1-1, P7-R1-1): "**mode**" and "mode", or "a<line break>b" and
"a b", never look alike, and "<target>" is not removed. Its term is the name as displayed, so its explanation is found
where it is shown. The table of plain labels is looked up by its own entries only, so a name such as "constructor" is
shown as an unknown setting.

An empty list and an empty object in a tool's input read "(empty list)" and "(empty object)", and an input with no
settings reads "(no settings)", as plain text rather than code, so that none of them looks like an empty value or like
the others (S60, W8-R1-2 of work review 8) [error prevention].

Two names still looked alike after that: a key with a line break and the literal key `a\nb`, and a name of spaces or
tabs alone and a key spelled like its phrase ("(1 space)"). Since S57 (W6-R1-1 of work review 7, P8-R1-1), a name with a
backslash is shown with escapes too, its backslashes doubled, and a name of whitespace alone has each character written
as its escape (a space as `\u0020`); the note on escapes is shown beside every escaped name. An empty name reads "The
tool's setting with an empty name", with no term. Distinct names therefore never display alike, and each keeps a term
of its own [error prevention; visibility of system status].

The page also keeps that whitespace when it renders the value (S51, W3-R1-2 of work review 5). A code element's text
keeps every space, but the browser's default white-space collapses runs and drops the spaces at the edges, so "a b",
"a  b" and "a<tab>b" would look alike and " a " like "a". One rule in `web/src/theme.css`, shared by the question pane,
the question beside an analysis and the transcript, sets code in rendered Markdown to `white-space: break-spaces` with
a tab size of 4, inline code as an inline block so that its tab stops are measured from its own start (a tab is never
the width of one space), and code blocks to `white-space: pre`, scrolling sideways (L22 measures the widths in all
three places).

The question of a permission request names the tool and the kind of action and points at the input shown above it; it
never contains the input itself (S49, W4-R1-1). A long command therefore stays in the details, where it scrolls, and
cannot push the question's answers out of view (L21 at 390 × 844 and 640 × 400, in the pane and beside an analysis)
[visibility of system status; recognition rather than recall].

The same holds for every question the program composes (S52, W5-R1-1): no question embeds text of an agent or an SDK,
only names the program chooses (a phase's heading, a file's name, an agent). The exhaustion pause names the agent and
the call and asks whether to retry; the attempts and the last fault are in its details, the fault shown literally as
code, since it is the SDK's text and not Markdown (P6-R1-1). At an execution stop without a question, Claude Code's
description is in the details, as Markdown like all of Claude's prose. The question pane's bottom region is at least
6rem high (5rem before the option labels took a line of their own, below), so that an option card is seen whole in a
short window (L23: a fault of 2,500 characters at 390 × 844 and 640 × 400) [visibility of system status; recognition
rather than recall].

**Explanations of terms.** m3-svelte has no rich tooltip, so the one of a term is built by hand (`TermTooltip`), as
the plan step's is. It asserts only the explanation the agents wrote and Codex reviewed: plain text, nothing more, and
not the term's name, since the words themselves are its anchor. Since 30 Sep 2026 (issue #36) a question's text is a
sequence of pieces written by the agent, and a piece that refers to an explanation is a focusable word in the context,
the details, the question, the options, the answered question in the transcript and the question beside an analysis;
a plural or a capitalized word refers to the same explanation as the exact one. The analysis text carries none. The
tooltip opens on hover and on keyboard focus, closes on Escape or when the pointer or focus leaves, stays inside the
viewport, and scrolls when long [help and documentation; flexibility and efficiency of use]. The page searches for
nothing and converts nothing: each piece is rendered on its own, a plain piece as inline Markdown through its own
sanitizer that allows inline elements alone, so no markup of an agent passes into the page unsanitized and no piece
opens a block. The list of terms that the question pane showed above the question is removed: an explanation costs no
screen space until the reader asks for it [aesthetic and minimalist design]. The terminal prints the terms as a "Terms:"
block above the question, one line per explanation labeled with its term (decision Q6).

**A tool's yes-or-no settings (work review 1 of 30 Sep 2026, W1-R1-1).** In a permission request's input, a setting that is
true or false is shown as `(yes)` or `(no)`, and one without a value as `(none)`: phrases in parentheses, like the phrases
for an empty list or an empty text, so that none reads as a text the tool received. A number is shown as code, like any
other value the tool received. The parentheses mark the program's words for a value apart from the label beside them, and
they are what lets the program check that a context call which rephrased the question kept every value [error prevention;
consistency and standards].

**Option cards (issue #59).** Each option's label is in bold on a line of its own, its description below it, as separate
elements, in the question pane, beside an analysis and in the transcript, so that the options can be compared by their
labels alone [recognition rather than recall]. To keep a card of three lines as tall as one of two was, a card's
vertical padding is 12 dp in the pane and 8 dp beside an analysis, instead of the card's 16 dp; this changes only
spacing and asserts nothing the card does not. The question pane's bottom region is at least 6rem high, so that such a
card is seen whole in a short window (L23), and beside an analysis the answers scroll within 15 % of the window's height,
at least 3.75rem and at most 7rem (L14, L20, L21).

The answered question in the transcript keeps the exact text of its plain fields (S62, W9-R1-1 of work review 9): the
question, the options and the terms are plain text in the pane, and they are encoded so that no character of them is
read as Markdown or HTML there either. "<cache>" is not removed, a bare web address does not become a link, and a blank
line does not split the question [consistency and standards; visibility of system status].

Since 30 Sep 2026 (W2-R1-3, W2-R1-5, P3-R1-2, P3-R1-3):
- A term inside a link is marked too, but without a focus stop of its own, so that no interactive element is nested in
  another. Hovering the mark explains that term; focusing the link opens one tooltip that explains every term the link
  contains, in order.
- The tooltip is rendered after the whole text, so the natural tab order would pass it by. Focus is therefore routed
  as for a disclosure. Tab on a term (or link) whose tooltip is open moves into the tooltip, where the arrow and Page
  keys scroll a long explanation. The next Tab moves to what follows the term, never back into the tooltip. Shift+Tab
  and Escape there close it and return to the term [user control and freedom; flexibility and efficiency of use].
- The tooltip is attached to the document's body, not placed inside the text it explains (W3-R1-1, 30 Sep 2026), so it
  is never inside an option's card or a link, and a click in it answers nothing [error prevention]. The text of an
  option's card sits above the card's state layer, so that a term in it is reached by the pointer, not only by the
  keyboard.

<script lang="ts">
  // The question the run waits on (decision Q10): it takes the left column while its prompt is pending, so that the
  // question and its answers are never scrolled out of view by the conversation [visibility of system status;
  // recognition rather than recall]. Issue #137 (the developer's instruction of 11 Oct 2026, which superseded S27): from
  // top to bottom, the heading, which is the question itself with its number; where the question came from, in small
  // type; the choices, side by side where there is room; the hint, the fixed choices, the field and Send; and then the
  // context and the question's attached material as collapsed sections that expand (Disclosure.svelte, the control of
  // DecisionView's entries). What is new when a question appears is the question and its choices, so they come first
  // and largest; the context has usually been read already. The pane scrolls as one region, nothing in it on its own,
  // so with the choices directly under the question the question and its first answer stay in view in windows 450 px
  // high and taller (IN_VIEW_MIN_HEIGHT of ../layout.ts) by construction. Which sections are open is this tab's own
  // state and closes for each new prompt. The conversation is one click away and back [user control and freedom].
  // The options are outlined cards with their full text and the answer that chooses them (issue #12, S8): an option can
  // run to a paragraph, which a button's fixed height cannot hold [error prevention]; every option looks alike, none
  // filled, because the agent's first option is not a recommended default [consistency and standards]; the fixed
  // choices keep the program's primary action filled. More cycles, answered with a typed number, is no button.
  import { Button, Card, TextFieldOutlined, TextFieldOutlinedMultiline } from "m3-svelte";
  import { answerHint, attachedHeading, CONTEXT_HEADING, END_RUN_LABEL, HELP_ME_DECIDE, NUMERIC_OPTION_NOTE, originLine, PROGRAM_CONTEXT_NOTE, PROPOSED_ANSWERS_LABEL, questionTitle, SHOW_CONVERSATION } from "../../../src/prompts.ts";
  import type { Widget } from "../state.ts";
  import type { DraftKey } from "../draft.ts";
  import { type Ending, endingOf } from "../../../src/input.ts";
  import ConfirmEndDialog from "./ConfirmEndDialog.svelte";
  import { blocksText, piecesText } from "../../../src/pieces.ts";
  import QuestionText from "./QuestionText.svelte";
  import Disclosure from "./Disclosure.svelte";
  import type { Snippet } from "svelte";

  // The typed text is the page's draft of this prompt (../draft.ts, finding 5): App keeps it per (incarnation, run,
  // prompt) and withdraws it with a notice when another tab answers first [error prevention].
  // Offline (the page has stopped reconnecting, decision G-R1-1 of the defects' requirements) the prompt stays usable:
  // the socket refuses the answer with a notice, and the field keeps what was typed [user control and freedom: no
  // typed text is lost; help users recognise and recover: the page's banner and notice say why nothing is sent].
  // `answersOnly`: beside a decision's analysis, which shows the question with its context and terms (S22), the pane keeps
  // only the answers [aesthetic and minimalist design: the question is not shown twice].
  // `identity`: the pending prompt's full key (incarnation, run, prompt; ../draft.ts), to which a confirmation is bound.
  type Props = { widget: Widget | null; identity?: DraftKey | null; text?: string; offline?: boolean; answersOnly?: boolean; onAnswer: (prompt: number, text: string) => void; onShowConversation?: () => void };
  let { widget, identity = null, text = $bindable(""), offline = false, answersOnly = false, onAnswer, onShowConversation }: Props = $props();
  const deliver = (value: string) => {
    if (widget === null) return;
    if (!offline) text = "";
    onAnswer(widget.asked.prompt, value);
  };
  // S25: a submission that ends the run, clicked or typed, is confirmed first by the one predicate of src/input.ts.
  // S38 (W2-R1-1): the confirmation holds the identity of the prompt it was opened for, delivers only to that prompt,
  // and closes without acting as soon as the pending prompt is another one or none [error prevention].
  const identityOf = (): string | null => (widget === null ? null : JSON.stringify([identity?.incarnation ?? null, identity?.run ?? null, widget.asked.prompt]));
  const currentIdentity = $derived(identityOf());
  let confirming = $state<{ value: string; ending: Ending; identity: string } | null>(null);
  $effect(() => {
    if (confirming !== null && currentIdentity !== confirming.identity) confirming = null;
  });
  // W1-R1-1 of work review 1: the pane is one scrolling region, and App reuses it for another tab's prompt, so it
  // returns to its top for each new prompt: the question and its first answer in view (the developer's decision of
  // 9 Oct 2026). Svelte runs the effect after the DOM shows the new prompt.
  let paneElement = $state<HTMLElement | null>(null);
  $effect(() => {
    void currentIdentity;
    if (paneElement !== null) paneElement.scrollTop = 0;
  });
  let returnFocus: HTMLElement | null = null;
  const send = (value: string) => {
    if (widget === null) return;
    const ending = endingOf(widget.asked.kind, widget.asked.mode, value);
    if (ending === null) return deliver(value);
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const opened = identityOf();
    if (opened !== null) confirming = { value, ending, identity: opened };
  };
  const confirm = () => {
    const target = confirming;
    confirming = null;
    if (target !== null && target.identity === identityOf()) deliver(target.value);
  };
  const cancel = () => {
    confirming = null;
    returnFocus?.focus();
  };
  const endsRunLabel = (label: string, sends: string) => widget !== null && endingOf(widget.asked.kind, widget.asked.mode, sends) !== null && (isQuit(label) || sends !== "");
  const isQuit = (label: string) => label === END_RUN_LABEL;
  // "Help me decide" is an offer beside the answer, never the answer itself: tonal wherever it stands (decision support)
  // [consistency and standards: the filled button stays the program's primary action].
  const variantOf = (label: string, i: number): "filled" | "tonal" | "outlined" => (isQuit(label) ? "outlined" : label === HELP_ME_DECIDE ? "tonal" : i === 0 ? "filled" : "tonal");
  // An input method uses Enter to accept a candidate; that Enter is not an answer (finding 6) [error prevention].
  const composing = (e: KeyboardEvent) => e.isComposing || e.keyCode === 229;
  const question = $derived(widget?.question ?? null);
  const hasText = (blocks: Parameters<typeof blocksText>[0]) => blocksText(blocks).join("").trim() !== "";
  // Issue #137: the sections open for the prompt `key`, the pending prompt's identity; another prompt finds none open.
  type Section = "context" | "attached";
  let opened = $state<Readonly<{ key: string | null; open: readonly Section[] }>>({ key: null, open: [] });
  const isOpen = (section: Section): boolean => opened.key === currentIdentity && opened.open.includes(section);
  const setOpen = (section: Section, open: boolean) => {
    const others = (opened.key === currentIdentity ? opened.open : []).filter((s) => s !== section);
    opened = { key: currentIdentity, open: open ? [...others, section] : others };
  };
  // The bodies' ids, unique per prompt, so that two panes of the page never share one.
  const sectionId = (section: Section): string => `question-${(currentIdentity ?? "none").replace(/[^A-Za-z0-9_-]+/g, "-")}-${section}`;
</script>

<!-- Issue #137: a collapsed section of the pane under its heading; its body carries the id sectionId(section). -->
{#snippet sectionOf(section: Section, heading: string, body: Snippet)}
  <div class="section">
    <Disclosure expanded={isOpen(section)} controls={sectionId(section)} onToggle={(open) => setOpen(section, open)}>
      {#snippet title()}<span class="section-title m3-font-title-small">{heading}</span>{/snippet}
      {@render body()}
    </Disclosure>
  </div>
{/snippet}

{#if widget !== null}
  <section class="pane" bind:this={paneElement} class:answers-only={answersOnly} aria-label={question === null ? "Your answer" : questionTitle(question.number)}>
    {#if !answersOnly}
    <div class="head">
      {#if question === null}
        <p class="question-text m3-font-title-medium">{widget.hint}</p>
      {:else}
        <!-- Issue #137: the heading is the question, its number and its text in one typeface; the developer's two spaces
             between them are one space and a margin, since HTML collapses spaces. -->
        <h2 class="m3-font-title-medium"><span class="number">{questionTitle(question.number)}</span> <span class="question-text"><QuestionText class="markdown" pieces={question.question} explanations={question.explanations} /></span></h2>
      {/if}
      {#if onShowConversation !== undefined}
        <Button variant="text" type="button" name="conversation" onclick={onShowConversation}>{SHOW_CONVERSATION}</Button>
      {/if}
    </div>
    {#if question !== null}<p class="origin m3-font-body-small">{originLine(question.origin, question.decision)}</p>{/if}
    {/if}
      {#if question !== null && question.options.length > 0}
        <!-- S14 (issue #59): each option's label in bold on its own line and its description below it, as separate
             elements, so that the options can be compared by their labels alone [recognition rather than recall]. -->
        <div class="options m3-font-body-medium" role="group" aria-label={PROPOSED_ANSWERS_LABEL}>
          {#each question.options as option, i (i)}
            {#if "token" in option.answer}
              {@const token = option.answer.token}
              <Card variant="outlined" onclick={() => send(token)}><span class="card-text"><span class="option-label"><span class="token">{token}.</span> <strong><QuestionText class="markdown" pieces={option.label} explanations={question.explanations} /></strong></span>{#if piecesText(option.description) !== ""}{" "}<span class="option-description"><QuestionText class="markdown" pieces={option.description} explanations={question.explanations} /></span>{/if}</span></Card>
            {:else}
              <div class="numeric"><span class="option-label"><strong><QuestionText class="markdown" pieces={option.label} explanations={question.explanations} /></strong></span>{#if piecesText(option.description) !== ""}{" "}<span class="option-description"><QuestionText class="markdown" pieces={option.description} explanations={question.explanations} /></span>{/if}<span class="m3-font-body-small">{NUMERIC_OPTION_NOTE}</span></div>
            {/if}
          {/each}
        </div>
      {:else if widget.options.length > 0}
        <div class="options m3-font-body-medium" role="group" aria-label={PROPOSED_ANSWERS_LABEL}>
          {#each widget.options as option, i (i)}
            <Card variant="outlined" onclick={() => send(option.sends)}>{option.label}</Card>
          {/each}
        </div>
      {/if}
      {#if question !== null && !answersOnly}<p class="asks m3-font-body-small">{widget.hint}</p>{/if}
      <div class="choices">
        {#each widget.choices as choice, i (i)}
          {#if endsRunLabel(choice.label, choice.sends)}
            <!-- A button that ends the run: the error role, set apart from the ordinary choices (S25). -->
            <span class="ends-run"><Button variant="outlined" type="button" onclick={() => send(choice.sends)}>{choice.label}</Button></span>
          {:else}
            <Button variant={variantOf(choice.label, i)} type="button" onclick={() => send(choice.sends)}>{choice.label}</Button>
          {/if}
        {/each}
      </div>
      {#if widget.asked.free !== "none"}
        <!-- A persistent label and a visible Send beside the keyboard shortcut [recognition rather than recall;
             flexibility and efficiency of use: Enter for the keyboard, the button for touch and discovery]. -->
        {#if widget.asked.free === "line"}
          <TextFieldOutlined label="Your answer" name="answer" bind:value={text} onkeydown={(e: KeyboardEvent) => { if (e.key === "Enter" && !composing(e)) { e.preventDefault(); send(text); } }} />
        {:else}
          <TextFieldOutlinedMultiline label="Your message" name="answer" rows={3} bind:value={text} onkeydown={(e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey && !composing(e)) { e.preventDefault(); send(text); } }} />
        {/if}
        <div class="send-row">
          <p class="hint m3-font-body-small">{answerHint(widget.asked.free === "line" ? "line" : "message")}</p>
          <Button variant="filled" type="button" name="send" disabled={text === ""} onclick={() => send(text)}>Send</Button>
        </div>
      {/if}
    {#if question !== null && !answersOnly}
      {#if hasText(question.context.blocks)}
        {#snippet contextBody()}
          <div class="context m3-font-body-medium" id={sectionId("context")}>
            <QuestionText class="markdown" blocks={question.context.blocks} explanations={question.explanations} />
            {#if question.context.by === "program"}<p class="by m3-font-body-small">{PROGRAM_CONTEXT_NOTE}</p>{/if}
          </div>
        {/snippet}
        {@render sectionOf("context", CONTEXT_HEADING, contextBody)}
      {/if}
      {#if question.attached !== null}
        {@const attached = question.attached}
        {#snippet attachedBody()}
          <div class="details m3-font-body-medium" id={sectionId("attached")}>
            <QuestionText class="markdown" blocks={attached.blocks} explanations={question.explanations} />
          </div>
        {/snippet}
        {@render sectionOf("attached", attachedHeading(attached.kind), attachedBody)}
      {/if}
    {/if}
  </section>
  <ConfirmEndDialog ending={confirming?.ending ?? null} onConfirm={confirm} onCancel={cancel} />
{/if}

<style>
  /* Issue #137: the pane fills the left column and is its one scrolling region; nothing inside it scrolls on its own. */
  .pane { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 0.5rem; padding: 0.75rem; background: var(--m3c-surface-container-low); border-radius: var(--m3-shape-medium); }
  /* Beside an analysis the pane holds only the answers, sized by them, the options side by side as everywhere. */
  .pane.answers-only { flex: 0 0 auto; padding: 0.5rem 0.75rem; }
  .pane.answers-only .options > :global(button) { padding-block: 0.5rem; }
  /* Beside an analysis each card keeps its own height, not its row's tallest: the first answer is what the analysis's
     room is measured to (App's room, the developer's decision of 9 Oct 2026), and a taller first card takes that room. */
  .pane.answers-only .options { align-items: start; }
  /* The button beside the heading where both fit, and on a line of its own after it where they do not. */
  .head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 0.5rem; }
  .head > :global(button) { flex: none; }
  /* M3's title-medium (16/24, weight 500) set here, since the m3-font-* classes are absent from the build. */
  .head h2, .head > .question-text { flex: 1 1 16rem; min-width: 0; margin: 0; font-size: 1rem; line-height: 1.5rem; font-weight: 500; overflow-wrap: anywhere; }
  .number { margin-inline-end: 0.75em; }
  .origin { margin: 0; color: var(--m3c-on-surface-variant); }
  /* Issue #137: side by side where there is room, one per row where there is not; a card grows with its text, and a
     long unbroken token (a path) wraps. At 1280 and 640 px wide two cards share a row; at 390 px one fills it. */
  .options { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 14rem), 1fr)); gap: 0.5rem; align-items: stretch; }
  .options > :global(button) { width: 100%; min-width: 0; overflow-wrap: anywhere; text-align: start; }
  /* S14: a card holds its label on a line of its own above the description, 12 dp above and below. */
  .options > :global(button) { padding-block: 0.75rem; }
  .token { font-weight: 600; }
  /* The text above the card's state layer, so that a term in it is reached by the pointer (S44). */
  .card-text { position: relative; z-index: 1; display: flex; flex-direction: column; }
  /* S14: the label on its own line, in bold (M3's title-small weight), the description in the body style below it. */
  .option-label, .option-description { display: block; }
  .numeric { display: flex; flex-direction: column; }
  .numeric { padding: 0.75rem 1rem; border: 1px dashed var(--m3c-outline-variant); border-radius: var(--m3-shape-medium); }
  .asks { margin: 0; color: var(--m3c-on-surface-variant); }
  .choices { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  /* The run-ending button stands apart from the other choices, in the error role (S25). */
  .ends-run { margin-inline-start: 0.75rem; --m3c-primary: var(--m3c-error); --m3c-outline: var(--m3c-error); }
  /* The field has the full width in every window (finding 7); the hint and Send share the row below it. */
  .send-row { display: flex; gap: 0.5rem; align-items: center; justify-content: space-between; }
  .hint { margin: 0; color: var(--m3c-on-surface-variant); }
  /* Issue #137: the collapsed sections under the answers; flow-root keeps an open body's margins inside its section. */
  .section { display: flow-root; flex-shrink: 0; }
  .section-title { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .context, .details { margin: 0.25rem 0 0.5rem; padding: 0.5rem 0.75rem; border-radius: var(--m3-shape-small); background: var(--m3c-surface-container); color: var(--m3c-on-surface-variant); }
  .context .by { margin: 0.25rem 0 0; font-style: italic; }
  .section :global(.markdown pre) { overflow-x: auto; }
</style>

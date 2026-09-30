<script lang="ts">
  // The question the run waits on (S27, decision Q10): it takes the left column while its prompt is pending, so that
  // the question and its answers are never scrolled out of view by the conversation [visibility of system status;
  // recognition rather than recall]. From top to bottom: the heading and where the question came from; a region that
  // scrolls on its own with the context, what the question is about and the terms; the question itself, fixed and never
  // inside a scrolled region; and a region that scrolls on its own with the options, the field and the buttons. The
  // conversation is one click away and back [user control and freedom].
  // The options are outlined cards with their full text and the answer that chooses them (issue #12, S8): an option can
  // run to a paragraph, which a button's fixed height cannot hold [error prevention]; every option looks alike, none
  // filled, because the agent's first option is not a recommended default [consistency and standards]; the fixed
  // choices keep the program's primary action filled. More cycles, answered with a typed number, is no button.
  import { Button, Card, TextFieldOutlined, TextFieldOutlinedMultiline } from "m3-svelte";
  import { answerHint, END_RUN_LABEL, HELP_ME_DECIDE, NUMERIC_OPTION_NOTE, originLine, PROGRAM_CONTEXT_NOTE, PROPOSED_ANSWERS_LABEL, questionTitle, SHOW_CONVERSATION } from "../../../src/prompts.ts";
  import type { Widget } from "../state.ts";
  import type { DraftKey } from "../draft.ts";
  import { type Ending, endingOf } from "../../../src/input.ts";
  import ConfirmEndDialog from "./ConfirmEndDialog.svelte";
  import { blocksText, piecesText } from "../../../src/pieces.ts";
  import QuestionText from "./QuestionText.svelte";

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
  // S25: a submission that ends the run, clicked or typed, is confirmed first by the one predicate the terminal uses.
  // S38 (W2-R1-1): the confirmation holds the identity of the prompt it was opened for, delivers only to that prompt,
  // and closes without acting as soon as the pending prompt is another one or none [error prevention].
  const identityOf = (): string | null => (widget === null ? null : JSON.stringify([identity?.incarnation ?? null, identity?.run ?? null, widget.asked.prompt]));
  const currentIdentity = $derived(identityOf());
  let confirming = $state<{ value: string; ending: Ending; identity: string } | null>(null);
  $effect(() => {
    if (confirming !== null && currentIdentity !== confirming.identity) confirming = null;
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
</script>

{#if widget !== null}
  <section class="pane" class:answers-only={answersOnly} aria-label={question === null ? "Your answer" : questionTitle(question.number)}>
    {#if !answersOnly}
    <div class="head">
      {#if question !== null}
        <div class="title"><h2 class="m3-font-title-small">{questionTitle(question.number)}</h2> <span class="origin m3-font-body-small">{originLine(question.origin, question.decision)}</span></div>
      {/if}
      {#if onShowConversation !== undefined}
        <Button variant="text" type="button" name="conversation" onclick={onShowConversation}>{SHOW_CONVERSATION}</Button>
      {/if}
    </div>
    {#if question !== null && (hasText(question.context.blocks) || hasText(question.details))}
      <div class="top">
        {#if hasText(question.context.blocks)}
          <div class="context m3-font-body-medium">
            <QuestionText class="markdown" blocks={question.context.blocks} explanations={question.explanations} />
            {#if question.context.by === "program"}<p class="by m3-font-body-small">{PROGRAM_CONTEXT_NOTE}</p>{/if}
          </div>
        {/if}
        {#if hasText(question.details)}
          <QuestionText class="details markdown m3-font-body-medium" blocks={question.details} explanations={question.explanations} />
        {/if}
      </div>
    {/if}
    <p class="question-text m3-font-title-medium">{#if question === null}{widget.hint}{:else}<QuestionText class="markdown" pieces={question.question} explanations={question.explanations} />{/if}</p>
    {/if}
    <div class="bottom">
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
    </div>
  </section>
  <ConfirmEndDialog ending={confirming?.ending ?? null} onConfirm={confirm} onCancel={cancel} />
{/if}

<style>
  /* The pane fills the left column; the two regions share its height and scroll on their own, and the question between
     them never moves (S27). */
  .pane { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 0.5rem; padding: 0.75rem; background: var(--m3c-surface-container-low); border-radius: var(--m3-shape-medium); }
  /* Beside an analysis the pane holds only the answers, sized by them; the options scroll within 15 % of the window's
     height, at least one whole card of two lines (a label and a one-line description, S14) and at most 7rem, so that the
     field, the buttons and the analysis itself stay in view. */
  .pane.answers-only { flex: 0 0 auto; padding: 0.5rem 0.75rem; }
  .pane.answers-only .bottom { flex: 0 0 auto; min-height: 0; overflow: visible; }
  .pane.answers-only .options { max-height: clamp(3.75rem, 15dvh, 7rem); overflow-y: auto; }
  .pane.answers-only .options > :global(button) { padding-block: 0.5rem; }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.5rem; }
  /* The heading and the origin share a line where they fit, so that a short window keeps room for the question. */
  .title h2 { display: inline; margin: 0 0.25rem 0 0; }
  .origin { color: var(--m3c-on-surface-variant); }
  /* The context takes at most three tenths of the pane, so that the question's first option stays in view below it. */
  .top { flex: 0 1 auto; max-height: 30%; min-height: 2.5rem; overflow-y: auto; display: flex; flex-direction: column; gap: 0.5rem; }
  .context { padding: 0.5rem 0.75rem; border-radius: var(--m3-shape-small); background: var(--m3c-surface-container); color: var(--m3c-on-surface-variant); }
  .context .by { margin: 0.25rem 0 0; font-style: italic; }
  .top :global(.markdown pre) { overflow-x: auto; }
  .question-text { margin: 0; flex-shrink: 0; overflow-wrap: anywhere; }
  /* At least a card of three lines (its label on a line of its own, S14, and a description that wraps once) fits, so
     that the first option can be seen whole in a short window (S52, L23 at 640 × 400). */
  .bottom { flex: 1 1 0; min-height: 6rem; overflow-y: auto; display: flex; flex-direction: column; gap: 0.5rem; }
  /* One card per row at every width; a card grows with its text, and a long unbroken token (a path) wraps. */
  .options { display: flex; flex-direction: column; gap: 0.5rem; }
  .options > :global(button) { width: 100%; min-width: 0; overflow-wrap: anywhere; text-align: start; }
  /* S14: a card holds its label on a line of its own above the description; 12 dp above and below instead of the
     card's 16 keep a card of three lines as tall as one of two lines was, so that the first option stays in view. */
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
</style>

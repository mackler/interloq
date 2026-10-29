<script lang="ts">
  // An answered question as it was presented (S26, S28; S12 of the task of issue #36), extracted from Message (issue #22)
  // so that the dashboard's answers show it: its number and origin, its context, its attached material shown inline
  // (a permission's input is code whose whitespace the reader compares, so it is not hidden behind a heading), the
  // question and its options, each label on its own line (S14); the words that refer to an explanation still carry it
  // [recognition rather than recall].
  import QuestionText from "./QuestionText.svelte";
  import { attachedHeading, CONTEXT_BY_PROGRAM, originLine, questionTitle } from "../../../src/prompts.ts";
  import { piecesText } from "../../../src/pieces.ts";
  import type { PresentedQuestion } from "../../../src/question.ts";

  type Props = { question: PresentedQuestion };
  let { question: q }: Props = $props();
</script>

<div class="body question m3-font-body-medium">
  <p><strong>{questionTitle(q.number)}</strong> · <em>{originLine(q.origin, q.decision)}</em></p>
  <QuestionText class="markdown" blocks={q.context.blocks} explanations={q.explanations} />
  {#if q.context.by === "program"}<p><em>({CONTEXT_BY_PROGRAM})</em></p>{/if}
  {#if q.attached !== null}<p class="attached-heading">{attachedHeading(q.attached.kind)}</p><QuestionText class="markdown" blocks={q.attached.blocks} explanations={q.explanations} />{/if}
  <p><strong><QuestionText class="markdown" pieces={q.question} explanations={q.explanations} /></strong></p>
  {#if q.options.length > 0}
    <ul class="options">
      {#each q.options as option, i (i)}
        <li>
          <span class="option-label">{#if "token" in option.answer}{option.answer.token}. {/if}<strong><QuestionText class="markdown" pieces={option.label} explanations={q.explanations} /></strong></span>
          {#if piecesText(option.description) !== ""}{" "}<span class="option-description"><QuestionText class="markdown" pieces={option.description} explanations={q.explanations} /></span>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .question :global(pre) { overflow-x: auto; }
  .question > :global(*) { margin: 0 0 0.5rem; }
  .question > :global(*:last-child) { margin-bottom: 0; }
  .options { padding-inline-start: 1.25rem; }
  .option-label, .option-description { display: block; }
  /* Issue #137: the heading of a question's attached material, named by attachedHeading of src/prompts.ts. */
  .attached-heading { font-weight: 700; margin: 0.5rem 0 0.25rem; }
</style>

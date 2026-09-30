<script lang="ts">
  // One chat message [match between the system and the real world: a messaging app]: the author, a heading, and
  // the body, the agents' Markdown rendered and sanitised, the program's text as it is. The time of the message
  // (issue #1) [visibility of system status]: shown in the header, small and low-emphasis, unless the message is grouped
  // with the one before it (decision Q3) [aesthetic and minimalist design]; then it stays for assistive technology and
  // the title. It never changes, so the panel's polite live region announces it once, with the message.
  // The side of a message is its author's: Interloq and Claude on the left, the user and Codex on the right (issue #2).
  import { render } from "../markdown.ts";
  import QuestionText from "./QuestionText.svelte";
  import type { Author, Message } from "../state.ts";
  import { clockTime, fullTime } from "../time.ts";
  import { CONTEXT_BY_PROGRAM, originLine, questionTitle } from "../../../src/prompts.ts";
  import { piecesText } from "../../../src/pieces.ts";

  type Props = { message: Message };
  let { message }: Props = $props();
  const AUTHOR: Record<Author, string> = { program: "Interloq", user: "You", codex: "Codex", claude: "Claude" };
</script>

<article class="message {message.author}" data-author={message.author}>
  <header class="m3-font-label-medium">{AUTHOR[message.author]}{#if message.heading !== null} · {message.heading}{/if}<time class="time m3-font-label-small" class:visually-hidden={!message.showTime} datetime={message.time} title={fullTime(message.time)}>{clockTime(message.time)}</time></header>
  {#if message.question !== undefined}
    <!-- S26, S28 (S12 of the task of issue #36): an answered question joins the transcript as it was presented, its
         words that refer to an explanation still carrying it; the options' labels on their own lines (S14). -->
    {@const q = message.question}
    <div class="body question m3-font-body-medium">
      <p><strong>{questionTitle(q.number)}</strong> · <em>{originLine(q.origin, q.decision)}</em></p>
      <QuestionText class="markdown" blocks={q.context.blocks} explanations={q.explanations} />
      {#if q.context.by === "program"}<p><em>({CONTEXT_BY_PROGRAM})</em></p>{/if}
      {#if q.details.length > 0}<QuestionText class="markdown" blocks={q.details} explanations={q.explanations} />{/if}
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
  {:else if message.format === "markdown"}
    <div class="body markdown m3-font-body-medium">{@html render(message.body)}</div>
  {:else}
    <div class="body text m3-font-body-medium">{message.body.replace(/^\n+|\n+$/g, "")}</div>
  {/if}
</article>

<style>
  .message { position: relative; max-width: 85%; padding: 0.5rem 0.875rem; border-radius: var(--m3-shape-large); margin: 0.25rem 0; overflow-wrap: anywhere; }
  .program { align-self: flex-start; background: var(--m3c-surface-container-high); color: var(--m3c-on-surface); }
  .user { align-self: flex-end; background: var(--m3c-primary-container); color: var(--m3c-on-primary-container); }
  /* Issue #2: Claude speaks from the left in both panels (beside Interloq in the left one), Codex from the right. */
  .claude { align-self: flex-start; background: var(--m3c-secondary-container); color: var(--m3c-on-secondary-container); }
  .codex { align-self: flex-end; background: var(--m3c-tertiary-container); color: var(--m3c-on-tertiary-container); }
  header { opacity: 0.8; margin-bottom: 0.25rem; }
  .time { opacity: 0.7; margin-left: 0.5rem; white-space: nowrap; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; margin: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .text { white-space: pre-wrap; }
  .markdown :global(pre) { overflow-x: auto; }
  .markdown :global(:first-child) { margin-top: 0; }
  .markdown :global(:last-child) { margin-bottom: 0; }
  .question > :global(*) { margin: 0 0 0.5rem; }
  .question > :global(*:last-child) { margin-bottom: 0; }
  .options { padding-inline-start: 1.25rem; }
  .option-label, .option-description { display: block; }
</style>

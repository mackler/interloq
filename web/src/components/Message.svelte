<script lang="ts">
  // One chat message [match between the system and the real world: a messaging app]: the author, a heading, and
  // the body, the agents' Markdown rendered and sanitised, the program's text as it is. The time of the message
  // (issue #1) [visibility of system status]: shown in the header, small and low-emphasis, unless the message is grouped
  // with the one before it (decision Q3) [aesthetic and minimalist design]; then it stays for assistive technology and
  // the title. It never changes, so the panel's polite live region announces it once, with the message.
  // The side of a message is its author's: Claude on the left, Codex on the right (issue #2). Since issue #22 the
  // "Claude and Codex" panel is the one panel of messages, so these are its two authors.
  import { render } from "../markdown.ts";
  import type { Author, Message } from "../state.ts";
  import { clockTime, fullTime } from "../time.ts";

  type Props = { message: Message };
  let { message }: Props = $props();
  const AUTHOR: Record<Author, string> = { codex: "Codex", claude: "Claude" };
</script>

<article class="message {message.author}" data-author={message.author}>
  <header class="m3-font-label-medium">{AUTHOR[message.author]}{#if message.heading !== null} · {message.heading}{/if}<time class="time m3-font-label-small" class:visually-hidden={!message.showTime} datetime={message.time} title={fullTime(message.time)}>{clockTime(message.time)}</time></header>
  {#if message.format === "markdown"}
    <div class="body markdown m3-font-body-medium">{@html render(message.body)}</div>
  {:else}
    <div class="body text m3-font-body-medium">{message.body.replace(/^\n+|\n+$/g, "")}</div>
  {/if}
</article>

<style>
  .message { position: relative; max-width: 85%; padding: 0.5rem 0.875rem; border-radius: var(--m3-shape-large); margin: 0.25rem 0; overflow-wrap: anywhere; }
  /* Issue #2: Claude speaks from the left, Codex from the right. */
  .claude { align-self: flex-start; background: var(--m3c-secondary-container); color: var(--m3c-on-secondary-container); }
  .codex { align-self: flex-end; background: var(--m3c-tertiary-container); color: var(--m3c-on-tertiary-container); }
  header { opacity: 0.8; margin-bottom: 0.25rem; }
  .time { opacity: 0.7; margin-left: 0.5rem; white-space: nowrap; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; margin: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .text { white-space: pre-wrap; }
  .markdown :global(pre) { overflow-x: auto; }
  .markdown :global(:first-child) { margin-top: 0; }
  .markdown :global(:last-child) { margin-bottom: 0; }
</style>

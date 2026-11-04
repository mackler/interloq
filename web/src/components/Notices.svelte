<script lang="ts">
  // Issue #13: the page's notices that belong to no tab. A condition of the connection is an alert while it lasts, and the
  // next connection's hello withdraws it, so the page never says "connected" beside it [visibility of system status]. A
  // message for the developer stays in a list, in arrival order, until he dismisses it: a reconnection or a restart of
  // the server removes none [user control and freedom; help users recognize, diagnose, and recover from errors].
  import { Button } from "m3-svelte";
  import { DISMISS_NOTICE, NOTICES_LABEL } from "../../../src/prompts.ts";
  import { connectionNotices, connectionText, messages, type NoticeId, type Notices } from "../notices.ts";

  let { notices, onDismiss }: { notices: Notices; onDismiss: (id: NoticeId) => void } = $props();
  const conditions = $derived(connectionNotices(notices).flatMap((n) => (n.kind._tag === "Connection" ? [{ id: n.id, condition: n.kind.condition }] : [])));
  const texts = $derived(messages(notices).flatMap((n) => (n.kind._tag === "Message" ? [{ id: n.id, text: n.kind.text }] : [])));
</script>

{#each conditions as c (c.id)}
  <p class="notice m3-font-body-small" role="alert" data-notice="connection">{connectionText(c.condition)}</p>
{/each}
{#if texts.length > 0}
  <section class="messages" aria-label={NOTICES_LABEL} data-notice="messages">
    <ul aria-live="polite">
      {#each texts as m (m.id)}
        <li>
          <span class="notice-text m3-font-body-small">{m.text}</span>
          <Button variant="text" type="button" name="dismiss-notice" onclick={() => onDismiss(m.id)}>{DISMISS_NOTICE}</Button>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .notice { margin: 0; padding: 0.5rem 0.75rem; color: var(--m3c-on-error-container); background: var(--m3c-error-container); }
  .messages { padding: 0 0.75rem; background: var(--m3c-surface-container-high); }
  .messages ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; }
  .messages li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; column-gap: 0.5rem; }
  .notice-text { white-space: pre-wrap; word-break: break-word; user-select: text; }
</style>

<script lang="ts">
  // The "You and Interloq" panel as a dashboard (issue #22, the developer's decision of 11 Oct 2026): every piece of
  // information has a fixed place and is replaced in place, rather than arriving as another message at the bottom
  // [visibility of system status; aesthetic and minimalist design]. Top to bottom: the header, the run's item; the
  // agents' models in small type; the status line, prominent; the interview's help while it lasts, since it says how to
  // answer; Claude Code's latest message and the last answered question, each on a surface of its own and labeled, so
  // that Claude Code's information and the developer's are separated rather than interleaved [match between the system
  // and the real world]; and the heading of every answer, closed until opened, its open state the run's shared state, so
  // that every earlier answer stays reachable [recognition rather than recall; user control and freedom]. A region
  // without content is absent. `compact` renders the compact status line and the heading of every answer alone, for
  // the column under a question or the decision page.
  import { render } from "../markdown.ts";
  import { allAnswersHeading, DASHBOARD_CLAUDE_LABEL, itemHeadline, LAST_ANSWER_LABEL, YOU_LABEL } from "../../../src/prompts.ts";
  import { type AnsweredEntry, lastAnswer, type RunView } from "../state.ts";
  import AnsweredQuestion from "./AnsweredQuestion.svelte";
  import Disclosure from "./Disclosure.svelte";
  import StatusLine from "./StatusLine.svelte";

  const NAME = "You and Interloq";
  type Props = { run: RunView; answersOpen: boolean; onAnswers: (open: boolean) => void; compact?: boolean };
  let { run, answersOpen, onAnswers, compact = false }: Props = $props();
  const d = $derived(run.dashboard);
  const last = $derived(lastAnswer(d));
  const listId = $derived(`dashboard-answers-${run.id}-${compact ? "compact" : "full"}`);
</script>

{#snippet answered(entry: AnsweredEntry)}
  {#if entry.asked._tag === "Question"}<AnsweredQuestion question={entry.asked.question} />{:else if entry.asked._tag === "Hint"}<p class="hint m3-font-body-medium">{entry.asked.hint}</p>{/if}
  <div class="you m3-font-body-medium"><span class="who m3-font-label-medium">{YOU_LABEL}</span><div class="markdown" data-your-answer>{@html render(entry.answer)}</div></div>
{/snippet}

<section class="dashboard" class:compact aria-label={NAME}>
  {#if !compact}
    <h2 class="header">{run.item === null ? NAME : itemHeadline(run.item.id, run.item.title)}</h2>
    {#if d.models.claude !== null || d.models.codex !== null}
      <p class="models" data-models>{#if d.models.claude !== null}<span>{d.models.claude}</span>{/if}{#if d.models.codex !== null}<span>{d.models.codex}</span>{/if}</p>
    {/if}
  {/if}
  <StatusLine status={d.status} retry={run.retry?.wait ?? null} wait={run.limitWait} {compact} />
  <div class="regions">
    {#if !compact}
      {#if d.interviewHelp !== null}<p class="help m3-font-body-small" data-interview-help>{d.interviewHelp}</p>{/if}
      {#if d.claude !== null}
        <article class="surface claude" data-claude>
          <header class="m3-font-label-medium">{DASHBOARD_CLAUDE_LABEL}{#if d.claude.heading !== null} · {d.claude.heading}{/if}</header>
          <div class="markdown m3-font-body-medium">{@html render(d.claude.body)}</div>
        </article>
      {/if}
      {#if last !== null}
        <article class="surface answer" data-last-answer>
          <header class="m3-font-label-medium">{LAST_ANSWER_LABEL}</header>
          {@render answered(last)}
        </article>
      {/if}
    {/if}
    {#if d.answers.length > 0}
      <div class="all" data-answers-heading>
        <Disclosure expanded={answersOpen} controls={listId} onToggle={onAnswers}>
          {#snippet title()}<span class="m3-font-label-large">{allAnswersHeading(d.answers.length)}</span>{/snippet}
          <ol class="answers" id={listId} data-answers>
            {#each d.answers as entry (entry.key)}<li class="surface answer" data-answer>{@render answered(entry)}</li>{/each}
          </ol>
        </Disclosure>
      </div>
    {/if}
  </div>
</section>

<style>
  .dashboard { display: flex; flex-direction: column; gap: 0.75rem; min-height: 0; flex: 1; padding: 0.75rem 1rem; border-radius: var(--m3-shape-large); background: var(--m3c-surface-container-low); overflow-wrap: anywhere; }
  .dashboard.compact { flex: none; gap: 0.25rem; padding: 0.25rem 0; background: transparent; }
  /* M3's title-large for the header, small type for the models, set here since the m3-font-* classes are absent. */
  .header { margin: 0; font-size: 1.375rem; line-height: 1.75rem; font-weight: 400; }
  .models { margin: 0; display: flex; flex-wrap: wrap; gap: 0 1rem; font-size: 0.75rem; line-height: 1rem; color: var(--m3c-on-surface-variant); }
  .regions { display: flex; flex-direction: column; gap: 0.75rem; min-height: 0; overflow-y: auto; }
  .compact .regions { overflow: visible; }
  .help { margin: 0; white-space: pre-wrap; color: var(--m3c-on-surface-variant); }
  .surface { padding: 0.5rem 0.875rem; border-radius: var(--m3-shape-large); margin: 0; }
  .claude { background: var(--m3c-secondary-container); color: var(--m3c-on-secondary-container); }
  .answer { background: var(--m3c-surface-container-high); color: var(--m3c-on-surface); }
  .surface header { opacity: 0.8; margin-bottom: 0.25rem; }
  .hint { margin: 0 0 0.5rem; white-space: pre-wrap; }
  .you { display: flex; flex-direction: column; gap: 0.125rem; margin-top: 0.5rem; padding: 0.375rem 0.625rem; border-radius: var(--m3-shape-medium); background: var(--m3c-primary-container); color: var(--m3c-on-primary-container); }
  .who { opacity: 0.8; }
  .markdown :global(pre) { overflow-x: auto; }
  .markdown :global(:first-child) { margin-top: 0; }
  .markdown :global(:last-child) { margin-bottom: 0; }
  .answers { list-style: none; margin: 0.25rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; max-height: 24rem; overflow-y: auto; }
</style>

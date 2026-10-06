<script lang="ts">
  // The page (decision Q3 layout) [consistency and standards: one top app bar, M3 layout regions; the page shows
  // only the newest run, in progress or ended, and offers a new task when it has ended].
  // Adaptive layout (finding 7 of docs/gui-review.md, decision Q3 of its task): at M3's expanded width the rail and the
  // two panels stand side by side; below it the rail becomes a one-line disclosure and one panel is shown at a time,
  // chosen by its title in a segmented group [aesthetic and minimalist design: nothing is squeezed to unreadable
  // widths; visibility of system status: the current phase stays in view and a badge counts the hidden panel's new
  // messages; user control: the user chooses the panel, and only a new prompt, which is answered in "You and
  // Interloq", selects it].
  import { Button, ConnectedButtons } from "m3-svelte";
  import { untrack } from "svelte";
  import { CONNECTION_FAILED_NOTICE, notSentNotice, SHOW_ANALYSIS, SHOW_QUESTION, UNSENT_HEADING, unseenBadge } from "../../../src/prompts.ts";
  import { type AnalysisKey, analysisShown, EXPANDED_MIN_WIDTH, initialLayout, type Layout, observe, type Pane, select } from "../layout.ts";
  import type { ClientMessage } from "../../../src/protocol.ts";
  import { type Draft, draftFor, pendingKey, reconcile, restoreUnsent } from "../draft.ts";
  import { connect, type Connection } from "../socket.ts";
  import { callStartedAt, dismissUnsent, executing, initialState, keepUnsent, notice, progressOf, protocolError, reduce, type ViewState, waiting } from "../state.ts";
  import ActivityLine from "./ActivityLine.svelte";
  import ChatPanel from "./ChatPanel.svelte";
  import DecisionView from "./DecisionView.svelte";
  import { isOpen } from "../../../src/uiState.ts";
  import DirectoryDialog from "./DirectoryDialog.svelte";
  import QuestionPane from "./QuestionPane.svelte";
  import StartForm from "./StartForm.svelte";
  import TimelineRail from "./TimelineRail.svelte";
  import TopBar from "./TopBar.svelte";

  let view = $state<ViewState>(initialState);
  let connection: Connection | null = null;
  let browsing = $state(false);
  let chosen = $state<string | null>(null);
  // After a run has ended, the form is shown again once the user asks for a new task.
  let formWanted = $state(false);
  let noticesSeen = $state(0);
  // The unsent text of the pending prompt (finding 5), reconciled with the view after every message, live or replayed.
  let draft = $state<Draft | null>(null);

  const send = (m: ClientMessage) => connection?.send(m);
  $effect(() => {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    connection = connect(url, {
      onMessage: (m) => {
        view = reduce(view, m);
        const reconciled = reconcile(draft, view);
        draft = reconciled.draft;
        if (reconciled.notice !== null) view = notice(view, reconciled.notice);
        if (m.type === "event" && m.event._tag === "Started") formWanted = false;
        if (view.needsReconnect) connection?.reconnect();
      },
      onState: (s) => (view = { ...view, connection: s }),
      onNotice: (t) => (view = notice(view, t)),
      // Defect B of docs/page-question-phase-defects.md: a frame the page cannot read is a notice with its reason.
      onProtocolError: (reason, count) => (view = protocolError(view, reason, count)),
      // An action the failed page cannot send: an answer goes back to its field or is kept under "Not sent", never
      // over newer text, and the notice says which (G-R1-1, P1-R1-2).
      onUnsent: (m) => {
        const restored = restoreUnsent(draft, view, m);
        draft = restored.draft;
        const kept = restored.quoted === null ? view : keepUnsent(view, restored.quoted);
        view = notice(kept, notSentNotice(m.type, "disconnected", restored.quoted ?? undefined));
      },
    });
    return () => connection?.close();
  });

  let width = $state(typeof window === "undefined" ? EXPANDED_MIN_WIDTH : window.innerWidth);
  const compact = $derived(width < EXPANDED_MIN_WIDTH);
  let layout = $state<Layout>(initialLayout);
  $effect(() => {
    const counts = { left: view.run?.left.length ?? 0, right: view.run?.right.length ?? 0 };
    const prompt = pendingKey(view);
    const narrow = compact;
    layout = observe(untrack(() => layout), { counts, prompt }, narrow);
  });
  /** Whether a column is shown: both at expanded width, the selected one below it. */
  const shown = (pane: Pane): boolean => !compact || layout.selected === pane;
  const TITLES: Record<Pane, string> = { left: "You and Interloq", right: "Claude and Codex" };

  const run = $derived(view.run);
  // S27: the pending prompt whose conversation the user chose to see instead of its question (by its full key).
  let conversationForPrompt = $state<string | null>(null);
  const promptKey = $derived(JSON.stringify(pendingKey(view)));
  const asking = $derived(view.run?.pending != null && conversationForPrompt !== promptKey);
  const showForm = $derived(run === null || (run.ended !== null && formWanted));
  const latestNotice = $derived(view.notices.length > noticesSeen ? view.notices[view.notices.length - 1] : null);
  const refused = $derived(showForm ? latestNotice : null);
  const offline = $derived(view.connection === "failed");
  // Decision support: a decision's analysis covers both chat columns until its question is answered; the user may
  // look at the conversation meanwhile and come back [user control and freedom]. The rail, the prompt and the activity
  // line stay in view [visibility of system status]. Below 390 px the analysis is not laid out (decided 28 Sep 2026).
  // The toggle is kept for one decision of one run of one server start (W2-R1-3).
  let conversationFor = $state<AnalysisKey | null>(null);
  const analysis = $derived(run?.analysis ?? null);
  const analysisKey = $derived(analysis === null || run === null ? null : { incarnation: view.incarnation ?? "", run: run.id, decision: analysis.event.decision });
  const deciding = $derived(analysisKey !== null && analysisShown(conversationFor, analysisKey));
  const NARROW_WIDTH = 390;
</script>

<svelte:window bind:innerWidth={width} />
<div class="app">
  <TopBar {run} incarnation={view.incarnation} connection={view.connection} onStop={(incarnation, id) => send({ type: "stop", incarnation, run: id })} />
  <!-- A failed page says so for as long as it lasts, apart from the notices, which a new task marks as seen, and keeps
       the answers it could not send until each is dismissed [visibility of system status; help users recognise,
       diagnose and recover from errors; user control and freedom: nothing typed is lost]. -->
  {#if offline}<p class="notice failed m3-font-body-medium" role="alert">{CONNECTION_FAILED_NOTICE}</p>{/if}
  {#if view.unsent.length > 0}
    <section class="unsent" aria-label={UNSENT_HEADING}>
      <h2 class="m3-font-title-small">{UNSENT_HEADING}</h2>
      <ul>
        {#each view.unsent as text, i (i)}
          <li>
            <span class="unsent-text m3-font-body-medium">{text}</span>
            <Button variant="text" type="button" name="dismiss" onclick={() => (view = dismissUnsent(view, i))}>Dismiss</Button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  {#if showForm}
    <main class="form">
      <StartForm
        cwd={view.cwd}
        running={view.current !== null}
        {refused}
        {chosen}
        {offline}
        onStart={(project, task) => { noticesSeen = view.notices.length; send({ type: "start", project, task }); }}
        onBrowse={(from) => { browsing = true; send({ type: "list", path: from || view.cwd }); }}
      />
    </main>
  {:else if run !== null}
    <!-- One tree for both layouts (W2-R1-3): the columns stay mounted, and CSS alone shows or hides them, so a switch
         of panels or a resize across 840 px keeps each panel's reading position [user control and freedom]. -->
    <main class="run" class:compact class:deciding class:paused={analysis !== null && !deciding}>
      {#if compact}
        <details class="progress">
          <Button summary variant="text">{progressOf(run)}</Button>
          <TimelineRail timeline={run.timeline} busy={run.busy} executing={executing(run)} callStartedAt={callStartedAt(run)} />
        </details>
        <!-- While the analysis is shown both panels are hidden, so the buttons would select nothing; "Show the
             conversation" is the way back (W4-R1-1) [aesthetic and minimalist design]. -->
        {#if !deciding}
          <ConnectedButtons>
            {#each ["left", "right"] as const as pane (pane)}
              <Button variant={layout.selected === pane ? "filled" : "tonal"} type="button" aria-pressed={layout.selected === pane} onclick={() => (layout = select(layout, pane))}>
                {TITLES[pane]}{#if layout.unseen[pane] > 0}<span class="badge">&nbsp;{unseenBadge(layout.unseen[pane])}</span>{/if}
              </Button>
            {/each}
          </ConnectedButtons>
        {/if}
        <!-- The latest notice above the panels, whichever is shown (W2-R1-2) [visibility of system status]. -->
        {#if latestNotice !== null}<p class="notice m3-font-body-small" role="alert">{latestNotice}</p>{/if}
      {:else}
        <TimelineRail timeline={run.timeline} busy={run.busy} executing={executing(run)} callStartedAt={callStartedAt(run)} />
      {/if}
      {#if analysis !== null && deciding}
        <div class="decision-area">
          <DecisionView event={analysis.event} narrow={width < NARROW_WIDTH} open={(entry) => run !== null && isOpen(run.ui, { _tag: "DecisionEntry", decision: analysis.event.decision, entry })} onToggle={(entry, open) => { if (run !== null) send({ type: "ui", incarnation: view.incarnation ?? "", run: run.id, flag: { scope: { _tag: "DecisionEntry", decision: analysis.event.decision, entry }, open } }); }} onShowConversation={() => { conversationFor = analysisKey; conversationForPrompt = promptKey; }} />
        </div>
      {:else if analysis !== null}
        <div class="decision-area back">
          <Button variant="tonal" type="button" name="analysis" onclick={() => { conversationFor = null; conversationForPrompt = null; }}>{SHOW_ANALYSIS}</Button>
        </div>
      {/if}
      <div class="left" class:hidden={!deciding && !shown("left")}>
        <!-- S27 (Q10): a pending prompt's question takes the column; the conversation is one click away and back. -->
        <div class="chat" class:hidden={deciding || asking}>
          <ChatPanel title={TITLES.left} messages={run.left} empty="The run has started." visible={shown("left") && !deciding && !asking} />
        </div>
        {#if run.pending !== null && !asking}
          <div class="back-to-question">
            <Button variant="tonal" type="button" name="question" onclick={() => (conversationForPrompt = null)}>{SHOW_QUESTION}</Button>
          </div>
        {/if}
        <QuestionPane
          widget={asking ? run.pending : null}
          identity={pendingKey(view)}
          answersOnly={deciding}
          onShowConversation={() => (conversationForPrompt = promptKey)}
          {offline}
          bind:text={() => draftFor(draft, pendingKey(view)), (text) => { const key = pendingKey(view); draft = key === null ? null : { key, text }; }}
          onAnswer={(prompt, text) => send({ type: "answer", incarnation: view.incarnation ?? "", run: run.id, prompt, text })} />
        {#if !compact && latestNotice !== null}<p class="notice m3-font-body-small" role="alert">{latestNotice}</p>{/if}
        {#if run.ended !== null}
          <div class="ended">
            <span class="m3-font-body-medium">This task has ended ({run.ended === 0 ? "finished" : run.ended === 130 ? "interrupted" : "halted"}).</span>
            <Button variant="filled" type="button" name="new" onclick={() => { formWanted = true; noticesSeen = view.notices.length; }}>New task</Button>
          </div>
        {/if}
      </div>
      <div class="right" class:hidden={!deciding && !shown("right")}>
        <div class="chat" class:hidden={deciding}>
          <ChatPanel title={TITLES.right} messages={run.right} empty="No review yet." visible={shown("right") && !deciding} />
        </div>
        <ActivityLine text={run.activity} busy={waiting(run)} />
      </div>
    </main>
  {/if}
  <DirectoryDialog open={browsing} listing={view.listing} {offline} onList={(path) => send({ type: "list", path })} onChoose={(path) => { chosen = path; browsing = false; }} onClose={() => (browsing = false)} />
</div>

<style>
  .app { height: 100vh; display: flex; flex-direction: column; background: var(--m3c-surface); color: var(--m3c-on-surface); }
  .form { flex: 1; overflow-y: auto; padding: 0 1rem; }
  .run { flex: 1; min-height: 0; display: grid; grid-template-columns: 14rem 1fr 1fr; gap: 0.75rem; padding: 0.75rem; }
  .left, .right { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .left :global(.panel), .right :global(.panel) { flex: 1; }
  .chat { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  /* The analysis spans both chat columns in the first row; the prompt and the activity line stay below it. */
  .run.deciding { grid-template-rows: minmax(0, 1fr) auto; }
  .run.deciding > :global(.rail) { grid-row: 1 / 3; }
  .decision-area { grid-column: 2 / 4; min-height: 0; min-width: 0; display: flex; flex-direction: column; }
  .run.paused { grid-template-rows: auto minmax(0, 1fr); }
  .run.paused > :global(.rail) { grid-row: 1 / 3; }
  .decision-area.back { flex-direction: row; }
  .run.compact .decision-area { flex: 1 0 auto; }
  .run.compact { display: flex; flex-direction: column; gap: 0.5rem; overflow-y: auto; }
  .run.compact > :global(*) { flex-shrink: 0; }
  .hidden { display: none; }
  .back-to-question { padding: 0.5rem 0.75rem 0; }
  /* The shown column fills the window; its panel scrolls inside it and keeps at least 12.5rem, below which the page scrolls. */
  .run.compact .left, .run.compact .right { flex: 1 0 0; }
  .run.compact .left :global(.panel), .run.compact .right :global(.panel), .run.compact .left :global(.pane:not(.answers-only)) { min-height: 12.5rem; }
  /* W4-R1-1: while the analysis is shown, only the decision area flexes; it never grows to its content and keeps a
     floor of min(12rem, 40dvh), and DecisionView's .scroll scrolls inside it. The columns hold only the prompt and
     the activity line then, sized by their content. The run keeps its outer scroll, so that where the controls and
     the floor do not fit (a short window, or the progress opened) they are reached by scrolling, never clipped.
     Measured (e2e, decideLong): at 390 × 844 the progress, prompt, activity line, gaps and padding take 420 px, and
     with the 192 px floor 612 px fit the run's 742, so it does not scroll; at 640 × 400 they take 402 px, and with
     the 160 px floor 562 px exceed its 294, so it scrolls. No height query is needed. */
  .run.compact.deciding > .decision-area { flex: 1 1 0; min-height: min(12rem, 40dvh); }
  .run.compact.deciding .left, .run.compact.deciding .right { flex: 0 0 auto; }
  .progress { border-radius: var(--m3-shape-medium); background: var(--m3c-surface-container-low); }
  .progress :global(.rail) { max-height: 40vh; }
  .badge { font-weight: 700; }
  .ended { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.75rem; background: var(--m3c-surface-container); }
  .notice { margin: 0; padding: 0.5rem 0.75rem; color: var(--m3c-on-error-container); background: var(--m3c-error-container); }
  .unsent { padding: 0.5rem 0.75rem; background: var(--m3c-surface-container-high); }
  .unsent h2 { margin: 0 0 0.25rem; }
  .unsent ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 0.25rem; }
  .unsent li { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .unsent-text { white-space: pre-wrap; word-break: break-word; user-select: text; }
</style>

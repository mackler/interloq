<script lang="ts">
  // The page (decision Q3 layout) [consistency and standards: one top app bar, M3 layout regions; the page shows
  // only the newest run, in progress or ended, and offers a new task when it has ended].
  // Adaptive layout (finding 7 of docs/gui-review.md, decision Q3 of its task): at M3's expanded width the rail and the
  // two panels stand side by side; below it the rail becomes a one-line disclosure and one panel is shown at a time,
  // chosen by its title in a segmented group [aesthetic and minimalist design: nothing is squeezed to unreadable
  // widths; visibility of system status: the current phase stays in view and a badge counts the hidden panel's new
  // messages; user control: the user chooses the panel, and only a new prompt, which is answered in "You and
  // Interloq", selects it].
  import { Button, ConnectedButtons, Tabs } from "m3-svelte";
  import { untrack } from "svelte";
  import { BACK_TO_LIST, TAB_TEXTS, TABS_LABEL, waitingTabName, CONNECTION_FAILED_NOTICE, endedOutcome, endNotificationTitle, notSentNotice, PAUSE_NOTIFICATION_BODY, pauseNotificationTitle, PROPOSED_ANSWERS_LABEL, SHOW_ANALYSIS, SHOW_QUESTION, UNSENT_HEADING, unseenBadge } from "../../../src/prompts.ts";
  import { type AnalysisKey, type AnalysisMinimum, analysisShown, type Room, roomOf, UNBOUNDED_ROOM, EXPANDED_MIN_WIDTH, initialLayout, type Layout, observe, type Pane, select } from "../layout.ts";
  import type { ClientMessage, ListedItem } from "../../../src/protocol.ts";
  import { RUN_MODES, type RunMode } from "../../../src/runMode.ts";
  import { itemsFrame, startFrame } from "../tabs.ts";
  import { type Draft, draftFor, pendingKey, reconcile, restoreUnsent } from "../draft.ts";
  import { connect, type Connection } from "../socket.ts";
  import { tabTitle } from "../title.ts";
  import { type Closer, currentPermission, playChime, requestDesktopPermission, schemeColors, setFavicon, showDesktop } from "../alerts.ts";
  import { faviconHref } from "../favicon.ts";
  import { type Decision, decide, defaultPreferences, initialNotifyState, type Mark, markOf, type NotifyState, type Observation, type Permission, type Preferences } from "../notify.ts";
  import { readPreferences, writePreferences } from "../storage.ts";
  import { ownName } from "../../../src/hostDir.ts";
  import { callStartedAt, dismissUnsent, executing, initialState, itemsRequested, keepUnsent, notice, progressOf, protocolError, reduce, selectMode, shownRun, type ViewState } from "../state.ts";
  import ActivityLine from "./ActivityLine.svelte";
  import ChatPanel from "./ChatPanel.svelte";
  import DecisionView from "./DecisionView.svelte";
  import { isOpen, type UiScope } from "../../../src/uiState.ts";
  import { railView } from "../rail.ts";
  import ItemList from "./ItemList.svelte";
  import QuestionPane from "./QuestionPane.svelte";
  import TimelineRail from "./TimelineRail.svelte";
  import TopBar from "./TopBar.svelte";

  let view = $state<ViewState>(initialState);
  let connection: Connection | null = null;
  // Issue #120: after a tab's run has ended, its list is shown again once the user asks for it.
  let listWanted = $state<Record<RunMode, boolean>>({ refinement: false, implementation: false });
  // The unsent text of each tab's pending prompt (finding 5), reconciled with its tab's run after every message, live
  // or replayed: an answer belongs to the run of the tab it was typed in (issue #120).
  let drafts = $state<Record<RunMode, Draft | null>>({ refinement: null, implementation: null });

  const send = (m: ClientMessage) => connection?.send(m);
  /** Asks the server for a tab's items; the server, never the page, calls the tracker. */
  const requestItems = (mode: RunMode) => {
    view = itemsRequested(view, mode);
    send(itemsFrame(mode));
  };
  $effect(() => {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    connection = connect(url, {
      onMessage: (m) => {
        view = reduce(view, m);
        for (const mode of RUN_MODES) {
          const reconciled = reconcile(drafts[mode], shownRun(view, mode));
          drafts = { ...drafts, [mode]: reconciled.draft };
          if (reconciled.notice !== null) view = notice(view, reconciled.notice);
        }
        if (m.type === "event" && m.event._tag === "Started") listWanted = { ...listWanted, [m.event.mode]: false };
        if (view.needsReconnect) connection?.reconnect();
      },
      onState: (s) => (view = { ...view, connection: s }),
      onNotice: (t) => (view = notice(view, t)),
      // Defect B of docs/page-question-phase-defects.md: a frame the page cannot read is a notice with its reason.
      onProtocolError: (reason, count) => (view = protocolError(view, reason, count)),
      // An action the failed page cannot send: an answer goes back to its field or is kept under "Not sent", never
      // over newer text, and the notice says which (G-R1-1, P1-R1-2).
      onUnsent: (m) => {
        const mode: RunMode = m.type === "answer" ? (view.runModes[m.run] ?? view.selected) : view.selected;
        const restored = restoreUnsent(drafts[mode], shownRun(view, mode), m);
        drafts = { ...drafts, [mode]: restored.draft };
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
    const counts = { left: run?.left.length ?? 0, right: run?.right.length ?? 0 };
    const prompt = pendingKey(shownTab);
    const narrow = compact;
    layout = observe(untrack(() => layout), { counts, prompt }, narrow);
  });
  /** Whether a column is shown: both at expanded width, the selected one below it. */
  const shown = (pane: Pane): boolean => !compact || layout.selected === pane;
  const TITLES: Record<Pane, string> = { left: "You and Interloq", right: "Claude and Codex" };

  // Issue #120: the tab shown, its run, and the run as the draft and the notifications key it.
  const mode = $derived(view.selected);
  const tab = $derived(view.modes[mode]);
  const run = $derived(tab.run);
  const shownTab = $derived(shownRun(view));
  const draft = $derived(drafts[mode]);
  // Issue #63: a node of the rail opened or closed is a change of the run's shared state, as a decision's entry is.
  const toggleRail = (scope: UiScope, open: boolean) => {
    if (run !== null) send({ type: "ui", incarnation: view.incarnation ?? "", run: run.id, flag: { scope, open } });
  };
  // S27: the pending prompt whose conversation the user chose to see instead of its question (by its full key).
  let conversationForPrompt = $state<string | null>(null);
  const promptKey = $derived(JSON.stringify(pendingKey(shownTab)));
  const asking = $derived(run?.pending != null && conversationForPrompt !== promptKey);
  // Issue #120: a tab shows its run while one is in progress, or its ended run until the user goes back to its list.
  const showList = $derived(run === null || (run.ended !== null && listWanted[mode]));
  // The notices since the user last started a run or went back to a list.
  let noticesSeen = $state(0);
  const latestNotice = $derived(view.notices.length > noticesSeen ? (view.notices.at(-1) ?? null) : null);
  const offline = $derived(view.connection === "failed");
  // A tab that shows its list asks for its items once connected (and again on Refresh); the server answers.
  $effect(() => {
    if (showList && tab.items._tag === "Unasked" && view.connection === "open") untrack(() => requestItems(mode));
  });
  /** The tabs, each name with the waiting mark while its run waits for the user [visibility of system status]. */
  const tabItems = $derived(RUN_MODES.map((m) => ({ name: view.modes[m].run?.pending != null ? waitingTabName(TAB_TEXTS[m].tab) : TAB_TEXTS[m].tab, value: m })));
  // Decision support: a decision's analysis covers both chat columns until its question is answered; the user may
  // look at the conversation meanwhile and come back [user control and freedom]. The rail, the prompt and the activity
  // line stay in view [visibility of system status]. Below 390 px the analysis is not laid out (decided 28 Sep 2026).
  // The toggle is kept for one decision of one run of one server start (W2-R1-3).
  let conversationFor = $state<AnalysisKey | null>(null);
  const analysis = $derived(run?.analysis ?? null);
  const analysisKey = $derived(analysis === null || run === null ? null : { incarnation: view.incarnation ?? "", run: run.id, decision: analysis.event.decision });
  const deciding = $derived(analysisKey !== null && analysisShown(conversationFor, analysisKey));
  const NARROW_WIDTH = 390;
  /**
   * Decision G-R1-2: the least height of the analysis, which the layout grows to. The task of L21, by the developer's
   * decision at the stop of execution phase 1: it is bounded by the room the window has for the analysis beside the
   * question and its first answer, at every width, so the run never scrolls the question out of view to show an answer.
   */
  let analysisMinimum = $state<AnalysisMinimum | null>(null);
  let runElement = $state<HTMLElement | null>(null);
  let room = $state<Room>(UNBOUNDED_ROOM);
  const px = (v: string) => parseFloat(v) || 0;
  /** The room of the decision area: the run's height less what lies above it and down to the first answer (roomOf). */
  const measureRoom = () => {
    const el = runElement;
    const left = el?.querySelector<HTMLElement>(":scope > .left") ?? null;
    const answer = left?.querySelector<HTMLElement>(`[role=group][aria-label="${PROPOSED_ANSWERS_LABEL}"] button`) ?? null;
    if (el === null || !deciding || left === null || answer === null) {
      if (room !== UNBOUNDED_ROOM) room = UNBOUNDED_ROOM;
      return;
    }
    const cs = getComputedStyle(el);
    const [padding, gap] = [px(cs.paddingTop) + px(cs.paddingBottom), px(cs.rowGap)];
    const firstAnswer = answer.getBoundingClientRect().bottom - left.getBoundingClientRect().top;
    const kids = [...el.children] as HTMLElement[];
    const area = kids.findIndex((k) => k.classList.contains("decision-area"));
    // Only the children that take part in the layout: a hidden one has no box and no gap.
    const above = kids.slice(0, Math.max(0, area)).filter((k) => k.getClientRects().length > 0).map((k) => k.getBoundingClientRect().height);
    const next = roomOf(compact ? { _tag: "Stacked", height: el.clientHeight, padding, gap, above, firstAnswer } : { _tag: "Grid", height: el.clientHeight, padding, rowGap: gap, firstAnswer });
    const whole = Math.floor(next) as Room;
    if (Math.abs(whole - room) >= 1 || room === UNBOUNDED_ROOM) room = whole;
  };
  $effect(() => {
    void deciding;
    void compact;
    void run?.pending;
    const el = runElement;
    untrack(measureRoom);
    if (el === null || typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return;
    // The run and its children other than the decision area, whose heights do not depend on the analysis's floor.
    const observer = new ResizeObserver(() => measureRoom());
    const observeChildren = () => {
      observer.disconnect();
      observer.observe(el);
      for (const k of el.children) if (!k.classList.contains("decision-area")) observer.observe(k);
    };
    observeChildren();
    // W2-R1-1 of work review 2: a child that appears or goes while the analysis is shown (a notice, the progress) takes
    // or gives back room above the first answer, so the room is measured again and the new children are observed.
    const children = new MutationObserver(() => {
      observeChildren();
      measureRoom();
    });
    children.observe(el, { childList: true });
    return () => {
      children.disconnect();
      observer.disconnect();
    };
  });
  // Issue #29: the tab's title names the server's project, so that a narrow tab strip tells two servers apart.
  // Issue #16: a pending prompt, or a watched run's end at a hidden tab, puts its marker in front of the title and a
  // badge on the icon, and is raised once as the user chose: a desktop notification, a chime [visibility of system
  // status, for a user who is not looking at the page]. decide (web/src/notify.ts) decides; this effect only fires.
  let notifyState = $state<NotifyState>(initialNotifyState);
  let visible = $state(typeof document === "undefined" || document.visibilityState === "visible");
  let preferences = $state<Preferences>(((r) => (r.ok ? r.value : defaultPreferences))(readPreferences()));
  let permission = $state<Permission>(currentPermission());
  // W1-R1-1: the mark last shown, from which the icon is drawn again when the color scheme changes.
  let shownMark: Mark = { _tag: "Clear" };
  $effect(() => {
    if (typeof window.matchMedia !== "function") return;
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const redraw = () => setFavicon(faviconHref(shownMark, schemeColors()));
    scheme.addEventListener("change", redraw);
    return () => scheme.removeEventListener("change", redraw);
  });
  let closeShown: Closer | null = null;
  let shownFor: string | null = null;
  $effect(() => {
    const onVisibility = () => {
      visible = document.visibilityState === "visible";
      permission = currentPermission();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  });
  const choose = (next: Preferences) => {
    preferences = next;
    writePreferences(next);
  };
  const requestPermission = () => {
    void requestDesktopPermission().then((answer) => (permission = answer));
  };
  /**
   * What the page shows now, as decide observes it (issue #120): the pending prompt of either tab, the shown tab's first;
   * the run of the shown tab, or the other tab's when the shown one has none.
   */
  const observation = (): Observation => {
    const other = RUN_MODES.find((m) => m !== mode) ?? mode;
    const watched = run ?? view.modes[other].run;
    return {
    pending: pendingKey(shownTab) ?? pendingKey(shownRun(view, other)),
    run: watched === null || view.incarnation === null ? null : { incarnation: view.incarnation, run: watched.id },
    ended: watched?.ended ?? null,
    visible,
    promptShown: asking || deciding,
    formShown: showList,
    preferences,
    permission,
    };
  };
  /** The decision's reason as one text, the tag of its notification; null for none. */
  const reasonOf = (d: Decision): string | null => (d._tag === "Idle" ? null : JSON.stringify([d._tag, d.key]));
  $effect(() => {
    const observed = observation();
    const decision = decide(untrack(() => notifyState), observed);
    notifyState = decision.state;
    const mark = markOf(decision);
    shownMark = mark;
    document.title = tabTitle(view.location, mark);
    setFavicon(faviconHref(mark, schemeColors()));
    const reason = reasonOf(decision);
    if (reason !== shownFor) {
      closeShown?.();
      closeShown = null;
      shownFor = null;
    }
    if (decision._tag === "Idle" || decision.raise === null || reason === null) return;
    const name = ownName(view.location ?? "");
    const [title, body] = decision._tag === "Waiting" ? [pauseNotificationTitle(name), PAUSE_NOTIFICATION_BODY] : [endNotificationTitle(name, decision.code), ""];
    if (decision.raise === "desktop" || decision.raise === "desktopAndSound") {
      closeShown = showDesktop(title, body, reason);
      shownFor = reason;
    }
    if (decision.raise === "sound" || decision.raise === "desktopAndSound") playChime();
  });
</script>

<svelte:window bind:innerWidth={width} onresize={measureRoom} />
<div class="app">
  <TopBar {run} location={view.location} incarnation={view.incarnation} connection={view.connection} onStop={(incarnation, id) => send({ type: "stop", incarnation, run: id })} {preferences} {permission} onPreferences={choose} onRequestPermission={requestPermission} />
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
  <!-- Issue #120: the two modes are two destinations of equal rank within one project, each with content of its own, which
       M3 specifies as primary tabs [recognition rather than recall: both modes are always in view; visibility of system
       status: a tab whose run waits for an answer carries the waiting mark]. -->
  <nav class="tabs" aria-label={TABS_LABEL}>
    <Tabs items={tabItems} bind:tab={() => mode, (value) => { view = selectMode(view, value as RunMode); }} />
  </nav>
  {#if tab.refusal !== null}<p class="notice refusal m3-font-body-medium" role="alert">{tab.refusal}</p>{/if}
  {#if showList}
    <main class="list">
      {#if !compact && latestNotice !== null && run === null}<p class="notice m3-font-body-small" role="alert">{latestNotice}</p>{/if}
      <ItemList {mode} items={tab.items} running={tab.current !== null} {offline} onStart={(item: ListedItem) => { noticesSeen = view.notices.length; send(startFrame(mode, item)); }} onRefresh={() => requestItems(mode)} />
    </main>
  {:else if run !== null}
    <!-- One tree for both layouts (W2-R1-3): the columns stay mounted, and CSS alone shows or hides them, so a switch
         of panels or a resize across 840 px keeps each panel's reading position [user control and freedom]. -->
    <main bind:this={runElement} class="run" class:compact class:deciding class:paused={analysis !== null && !deciding} style:--analysis-minimum={analysisMinimum !== null && analysisMinimum > 0 ? `${analysisMinimum}px` : null}>
      {#if compact}
        <details class="progress">
          <Button summary variant="text">{progressOf(run)}</Button>
          <TimelineRail timeline={run.timeline} busy={run.busy} executing={executing(run)} callStartedAt={callStartedAt(run)} rail={railView(run, executing(run), run.busy)} onToggle={toggleRail} />
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
        <TimelineRail timeline={run.timeline} busy={run.busy} executing={executing(run)} callStartedAt={callStartedAt(run)} rail={railView(run, executing(run), run.busy)} onToggle={toggleRail} />
      {/if}
      {#if analysis !== null && deciding}
        <div class="decision-area" style:min-height={analysisMinimum !== null && analysisMinimum > 0 ? `${analysisMinimum}px` : null}>
          <DecisionView {room} onMinimum={(h) => (analysisMinimum = h)} event={analysis.event} narrow={width < NARROW_WIDTH} open={(entry) => run !== null && isOpen(run.ui, { _tag: "DecisionEntry", decision: analysis.event.decision, entry })} onToggle={(entry, open) => { if (run !== null) send({ type: "ui", incarnation: view.incarnation ?? "", run: run.id, flag: { scope: { _tag: "DecisionEntry", decision: analysis.event.decision, entry }, open } }); }} onShowConversation={() => { conversationFor = analysisKey; conversationForPrompt = promptKey; }} />
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
          identity={pendingKey(shownTab)}
          answersOnly={deciding}
          onShowConversation={() => (conversationForPrompt = promptKey)}
          {offline}
          bind:text={() => draftFor(draft, pendingKey(shownTab)), (text) => { const key = pendingKey(shownTab); drafts = { ...drafts, [mode]: key === null ? null : { key, text } }; }}
          onAnswer={(prompt, text) => send({ type: "answer", incarnation: view.incarnation ?? "", run: run.id, prompt, text })} />
        {#if !compact && latestNotice !== null}<p class="notice m3-font-body-small" role="alert">{latestNotice}</p>{/if}
        {#if run.ended !== null}
          <div class="ended">
            <span class="m3-font-body-medium">This task has ended ({endedOutcome(run.ended)}).</span>
            <Button variant="filled" type="button" name="new" onclick={() => { listWanted = { ...listWanted, [mode]: true }; noticesSeen = view.notices.length; requestItems(mode); }}>{BACK_TO_LIST}</Button>
          </div>
        {/if}
      </div>
      <div class="right" class:hidden={!deciding && !shown("right")}>
        <div class="chat" class:hidden={deciding}>
          <ChatPanel title={TITLES.right} messages={run.right} empty="No review yet." visible={shown("right") && !deciding} />
        </div>
        <ActivityLine text={run.activity} retry={run.retry?.wait ?? null} wait={run.limitWait} />
      </div>
    </main>
  {/if}
</div>

<style>
  .app { height: 100vh; display: flex; flex-direction: column; background: var(--m3c-surface); color: var(--m3c-on-surface); }
  .list { flex: 1; overflow-y: auto; }
  .tabs { flex-shrink: 0; }
  .refusal { color: var(--m3c-error); margin: 0.5rem 1rem 0; }
  .run { flex: 1; min-height: 0; display: grid; grid-template-columns: 14rem 1fr 1fr; gap: 0.75rem; padding: 0.75rem; }
  .left, .right { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .left :global(.panel), .right :global(.panel) { flex: 1; }
  .chat { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  /* The analysis spans both chat columns in the first row; the prompt and the activity line stay below it. */
  /* W3-R1-1 of work review 3, decision G-R1-2: the analysis's row keeps the analysis's minimum total (measured by
     DecisionView, set inline as --analysis-minimum) wherever the window can hold it beside the question and its first
     answer. Where it cannot, at any width (the developer's decision in the task of L21), the minimum is bounded by that
     room and the analysis yields its columns, then its recommendation, then its context; only what lies below the
     first answer is reached by scrolling the run. */
  .run.deciding { grid-template-rows: minmax(var(--analysis-minimum, 0px), 1fr) auto; overflow-y: auto; }
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
  /* W4-R1-1, decision G-R1-2: while the analysis is shown, only the decision area flexes. It never grows to its content,
     and its floor is the analysis's minimum total (its heading, the question, two lines each of the context and the
     recommendation, and the columns' strip), set inline from DecisionView's measurement, bounded by the room the window
     has beside the question and its first answer (the task of L21): where the window is shorter, the analysis yields,
     and the answer controls below the first are reached by scrolling the run, never clipped. The columns hold only the
     prompt and the activity line then, sized by their content. */
  .run.compact.deciding > .decision-area { flex: 1 1 0; min-height: 0; }
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

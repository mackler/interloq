<script lang="ts">
  // The page (decision Q3 layout) [consistency and standards: one top app bar, M3 layout regions; the page shows
  // only the newest run, in progress or ended, and offers a new task when it has ended].
  // Adaptive layout (finding 7 of docs/gui-review.md, decision Q3 of its task): at M3's expanded width the rail and the
  // two columns stand side by side; below it the rail becomes a one-line disclosure and one column is shown at a time,
  // chosen by its title in a segmented group [aesthetic and minimalist design: nothing is squeezed to unreadable
  // widths; visibility of system status: the current phase stays in view and a badge counts the right panel's new
  // messages; user control: the user chooses the column, and only a new prompt, which is answered in "You and
  // Interloq", selects it]. Issue #22: the "You and Interloq" column is a dashboard, whose status line is the activity
  // line moved from under "Claude and Codex", which holds its messages alone. While a question takes the column, the
  // dashboard's compact form (its status line and the heading of every answer) stays below it; while the decision page
  // is shown nothing stands below it, at every window size (issue #200, requirements Q1).
  // Issue #191 (requirements Q1): under the Refinement tab, a second row of tabs (M3 secondary tabs, m3-svelte's Tabs with
  // `secondary`) holds the items first and then one tab per refinement run in start order, each named by its item and
  // carrying the waiting mark while its run waits [visibility of system status: every run's mark is in view from anywhere
  // in the tab; user control and freedom: one click between runs, and the page never switches away from the run shown].
  // Each run keeps its own draft and its own notifications, keyed by `presented` (web/src/state.ts).
  // Issue #200: below 840 px the second row is hidden while the decision page is shown, and returns when the developer
  // answers or shows the conversation (his decision of 30 Oct 2026).
  import { Button, ConnectedButtons, Tabs } from "m3-svelte";
  import { untrack } from "svelte";
  import { BACK_TO_LIST, CLOSE_RUN_TAB, runTabsLabel, TAB_TEXTS, TABS_LABEL, waitingTabName, CONNECTION_FAILED_NOTICE, endedOutcome, endNotificationTitle, notSentNotice, PAUSE_NOTIFICATION_BODY, pauseNotificationTitle, SHOW_ANALYSIS, SHOW_QUESTION, UNSENT_HEADING, unseenBadge } from "../../../src/prompts.ts";
  import { type AnalysisKey, analysisShown, EXPANDED_MIN_WIDTH, initialLayout, type Layout, observe, type Pane, select } from "../layout.ts";
  import type { ChainFrameSettings, ClientMessage, ListedItem } from "../../../src/protocol.ts";
  import type { TermsMode } from "../../../src/schema.ts";
  import { RUN_MODES, type RunMode } from "../../../src/runMode.ts";
  import { chainFrame, holdFrame, itemsFrame, preparationFrame, startFrame } from "../tabs.ts";
  import { fullTime } from "../time.ts";
  import { awaitedKey, carried, type Draft, draftFor, pendingKey, reconcile, restoreUnsent } from "../draft.ts";
  import { isTermsRequest } from "../../../src/input.ts";
  import { connect, type Connection } from "../socket.ts";
  import { tabTitle } from "../title.ts";
  import { type Closer, currentPermission, playChime, requestDesktopPermission, schemeColors, setFavicon, showDesktop } from "../alerts.ts";
  import { faviconHref } from "../favicon.ts";
  import { combinedMark, type Decision, decide, defaultPreferences, initialNotifyState, type Mark, markOf, type NotifyState, type Observation, type Permission, type Preferences } from "../notify.ts";
  import { readPreferences, writePreferences } from "../storage.ts";
  import { ownName } from "../../../src/hostDir.ts";
  import { shownMark as preparationMarkOf, abandonedInChain, closeRun, focusList, focusRun, modeWaiting, type Presented, presented, runTabs, startableOf, startRequested, type RunView, chainSent, chainShown, chainUnsent, chooseTerms, shownTerms, callStartedAt, dismissUnsent, executing, initialState, itemsRequested, keepUnsent, refreshSent, notice, progressOf, protocolError, reduce, selectMode, shownRun, type ViewState } from "../state.ts";
  import Dashboard from "./Dashboard.svelte";
  import ChatPanel from "./ChatPanel.svelte";
  import DecisionView from "./DecisionView.svelte";
  import { isOpen, openSectionOf, type UiScope } from "../../../src/uiState.ts";
  import { railView } from "../rail.ts";
  import ItemList from "./ItemList.svelte";
  import ChainControl from "./ChainControl.svelte";
  import PreparationControl from "./PreparationControl.svelte";
  import QuestionPane from "./QuestionPane.svelte";
  import TimelineRail from "./TimelineRail.svelte";
  import TopBar from "./TopBar.svelte";
  import { EMPTY_OUTPUTS, EMPTY_PANEL, hasRunning, type LiveOutputs, outputsAfter } from "../livePanel.ts";

  let view = $state<ViewState>(initialState);
  // Issue #49: the live panels, kept beside the view and never folded by the reducer: only what arrived over this
  // connection, so every hello empties them.
  let outputs = $state<LiveOutputs>(EMPTY_OUTPUTS);
  /**
   * An answer to the shown run's prompt. Issue #142: the request for the question's terms keeps the text typed beside
   * it, carried to the prompt that asks the same question again with its explanations.
   */
  // Issue #185: the developer is working on the prompt; its countdown stops.
  const hold = (target: RunView, prompt: number) => send(holdFrame(view.incarnation ?? "", target.id, prompt));
  const answer = (target: RunView, prompt: number, text: string) => {
    const key = draftKeyOf(target.id);
    const own = drafts[key] ?? null;
    const number = target.pending?.question?.number;
    if (isTermsRequest(text) && own !== null && own._tag === "Held" && own.key.prompt === prompt && number !== undefined) drafts = { ...drafts, [key]: carried(own, number) };
    send({ type: "answer", incarnation: view.incarnation ?? "", run: target.id, prompt, text });
  };
  /** Issue #142: a refinement starts with the choice of terms its tab's control shows. */
  const startItem = (mode: RunMode, item: ListedItem) => {
    noticesSeen = view.notices.length;
    // Issue #191: this page shows the run it started when its Started arrives.
    view = startRequested(view, mode, item.id);
    if (mode === "implementation") return send(startFrame({ mode, item }));
    const terms = shownTerms(view);
    if (terms !== null) send(startFrame({ mode, item, terms }));
  };
  let connection: Connection | null = null;
  // The unsent text of each presented run's pending prompt (finding 5), reconciled with its run after every message, live
  // or replayed: an answer belongs to the run it was typed in (issue #120; issue #191: one per refinement run).
  let drafts = $state<Record<string, Draft | null>>({});
  /** The key of a run's draft and notifications: the implementation tab's one key, or the refinement run's own. */
  const draftKeyOf = (run: number): string => (view.runModes[run] === "refinement" ? `refinement-${run}` : "implementation");

  /**
   * Reconciles every draft with the view (W1-R1-1, P2-R1-1): a presented run's with that run, and a draft of a run no
   * longer presented (a restarted server's, an ended run replaced or closed) with no run, so a non-empty one is
   * discarded with its notice before its key is dropped.
   */
  const reconcileDrafts = () => {
    const next: Record<string, Draft | null> = {};
    const shownKeys = new Set<string>();
    for (const p of presented(view)) {
      shownKeys.add(p.key);
      const reconciled = reconcile(drafts[p.key] ?? null, p.shown);
      next[p.key] = reconciled.draft;
      if (reconciled.notice !== null) view = notice(view, reconciled.notice);
    }
    for (const [key, draft] of Object.entries(drafts)) {
      if (shownKeys.has(key) || draft === null) continue;
      const reconciled = reconcile(draft, { incarnation: view.incarnation, run: null });
      if (reconciled.notice !== null) view = notice(view, reconciled.notice);
    }
    drafts = next;
  };
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
        if (m.type === "hello") outputs = EMPTY_OUTPUTS;
        if (m.type === "output") outputs = outputsAfter(outputs, m);
        view = reduce(view, m);
        reconcileDrafts();
        if (view.needsReconnect) connection?.reconnect();
      },
      onState: (s) => (view = { ...view, connection: s }),
      onNotice: (t) => (view = notice(view, t)),
      // Defect B of docs/page-question-phase-defects.md: a frame the page cannot read is a notice with its reason.
      onProtocolError: (reason, count) => (view = protocolError(view, reason, count)),
      // An action the failed page cannot send: an answer goes back to its field or is kept under "Not sent", never
      // over newer text, and the notice says which (G-R1-1, P1-R1-2).
      onUnsent: (m) => {
        const key = m.type === "answer" ? draftKeyOf(m.run) : (presented(view).find((p) => p.shown.run !== null && p.shown.run.id === shownRun(view).run?.id)?.key ?? "implementation");
        const shown = presented(view).find((p) => p.key === key)?.shown ?? shownRun(view);
        const restored = restoreUnsent(drafts[key] ?? null, shown, m);
        drafts = { ...drafts, [key]: restored.draft };
        const withdrawn = m.type === "chain" ? chainUnsent(view, m.settings) : view;
        const kept = restored.quoted === null ? withdrawn : keepUnsent(withdrawn, restored.quoted);
        view = notice(kept, notSentNotice(m.type, "disconnected", restored.quoted ?? undefined));
      },
    });
    return () => connection?.close();
  });

  let width = $state(typeof window === "undefined" ? EXPANDED_MIN_WIDTH : window.innerWidth);
  const compact = $derived(width < EXPANDED_MIN_WIDTH);
  let layout = $state<Layout>(initialLayout);
  $effect(() => {
    const right = run?.right.length ?? 0;
    const prompt = pendingKey(shownTab);
    const narrow = compact;
    layout = observe(untrack(() => layout), { right, prompt }, narrow);
  });
  /** Whether a column is shown: both at expanded width, the selected one below it. */
  const shown = (pane: Pane): boolean => !compact || layout.selected === pane;
  // Issue #22: the dashboard keeps the panel's name, the accessible name of its region and its selector's label.
  const TITLES: Record<Pane, string> = { dashboard: "You and Interloq", right: "Claude and Codex" };

  // Issue #120: the tab shown, its run, and the run as the draft and the notifications key it.
  const mode = $derived(view.selected);
  const tab = $derived(view.modes[mode]);
  const shownTab = $derived(shownRun(view));
  const run = $derived(shownTab.run);
  const draftKey = $derived(run === null ? mode : draftKeyOf(run.id));
  const draft = $derived(drafts[draftKey] ?? null);
  // Issue #63: a node of the rail opened or closed is a change of the run's shared state, as a decision's entry is.
  const toggleRail = (scope: UiScope, open: boolean) => {
    if (run !== null) send({ type: "ui", incarnation: view.incarnation ?? "", run: run.id, flag: { scope, open } });
  };
  /** Issue #22 (F1): the dashboard's heading of every answer, one per run, opened and closed as the run's shared state. */
  const DASHBOARD_ANSWERS: UiScope = { _tag: "DashboardAnswers" };
  const toggleAnswers = (open: boolean) => toggleRail(DASHBOARD_ANSWERS, open);
  // S27: the pending prompt whose conversation the user chose to see instead of its question (by its full key).
  let conversationForPrompt = $state<string | null>(null);
  const promptKey = $derived(JSON.stringify(pendingKey(shownTab)));
  const asking = $derived(run?.pending != null && conversationForPrompt !== promptKey);
  // Issue #191 and issue #144: a tab shows its items whenever its second row's focus is the list, a run in progress
  // or not; the run goes on, since the page only chooses what to draw.
  const showsList = (m: RunMode): boolean => shownRun(view, m).run === null;
  const showList = $derived(showsList(mode));
  // Issue #147: the chain's control, on the Implementation tab alone.
  const chain = $derived(mode === "implementation" ? chainShown(view, (iso) => fullTime(iso)) : null);
  // Issue #147 (the work review of 21 Oct 2026, W1-R1-1): every chain frame sent or queued is recorded in the view until
  // the server acknowledges it, so the control composes from it whatever remounts it; one handed back is not recorded,
  // since `onUnsent` has already run.
  const setChain = (settings: ChainFrameSettings) => {
    const delivery = connection?.send(chainFrame(settings));
    if (delivery === "sent" || delivery === "queued") view = chainSent(view, settings, delivery === "queued");
  };
  /** Selecting a tab that shows its list asks for its items every time, so a revisited list is current (S15). */
  const selectTab = (value: RunMode) => {
    view = selectMode(view, value);
    if (showsList(value) && view.connection === "open") requestItems(value);
  };
  // The notices since the user last started a run or went back to a list.
  let noticesSeen = $state(0);
  const latestNotice = $derived(view.notices.length > noticesSeen ? (view.notices.at(-1) ?? null) : null);
  const offline = $derived(view.connection === "failed");
  // Issue #131: the preparation's switch, on the Refinement tab alone, and a new listing of its items whenever the item
  // being prepared changes while that list is shown, without the loading state, so every row's mark follows the pass.
  // The automatic listing is counted as outstanding (`refreshSent`, W2-R1-1); a change while one is outstanding is asked
  // for once every outstanding listing has answered, and a hello reissues one lost with the connection.
  const preparation = $derived(mode === "refinement" ? view.preparation : null);
  const setPreparation = (enabled: boolean) => send(preparationFrame(enabled));
  const itemsRefresh = $derived(view.itemsRefresh);
  let refreshSeen = untrack(() => view.itemsRefresh);
  $effect(() => {
    const version = itemsRefresh;
    untrack(() => {
      if (version === refreshSeen) return;
      refreshSeen = version;
      if (view.connection !== "open") return;
      send(itemsFrame("refinement"));
      view = refreshSent(view);
    });
  });
  // A tab that shows its list asks for its items once connected (and again on Refresh); the server answers.
  $effect(() => {
    if (showList && tab.items._tag === "Unasked" && view.connection === "open") untrack(() => requestItems(mode));
  });
  /** The tabs, each name with the waiting mark while its run waits for the user [visibility of system status]. */
  const tabItems = $derived(RUN_MODES.map((m) => ({ name: modeWaiting(view, m) ? waitingTabName(TAB_TEXTS[m].tab) : TAB_TEXTS[m].tab, value: m })));
  // Issue #191 and issue #144: each tab's second row, shown while it holds a run; its value names what the tab shows.
  const secondRow = $derived(view.modes[mode].runs.length > 0 ? [...runTabs(view, mode)] : null);
  const focusValue = $derived.by(() => {
    const focus = view.modes[mode].focus;
    return focus._tag === "Run" ? `run-${focus.run}` : "list";
  });
  /** A tab's items, asked for again as a revisited list is (S15). */
  const toList = (m: RunMode) => {
    noticesSeen = view.notices.length;
    view = focusList(view, m);
    if (view.connection === "open") requestItems(m);
  };
  const selectRunTab = (value: string) => {
    if (value === "list") return toList(mode);
    const id = Number(value.slice("run-".length));
    if (Number.isInteger(id)) view = focusRun(view, mode, id);
  };
  /** Back to the list from an ended run: the tab keeps the run's tab in its second row. */
  const backToList = () => toList(mode);
  /** Closes an ended refinement run's tab in this page and shows the items. */
  const closeRunTab = (id: number) => {
    view = closeRun(view, id);
    toList("refinement");
    reconcileDrafts();
  };
  // Decision support: a decision's analysis covers both chat columns until its question is answered; the user may
  // look at the conversation meanwhile and come back [user control and freedom]. The rail, the prompt and the activity
  // line stay in view [visibility of system status]. Below 390 px the analysis is not laid out (decided 28 Sep 2026).
  // The toggle is kept for one decision of one run of one server start (W2-R1-3).
  let conversationFor = $state<AnalysisKey | null>(null);
  const analysis = $derived(run?.analysis ?? null);
  const analysisKey = $derived(analysis === null || run === null ? null : { incarnation: view.incarnation ?? "", run: run.id, decision: analysis.event.decision });
  const deciding = $derived(analysisKey !== null && analysisShown(conversationFor, analysisKey));
  // Issue #200 (the developer's decision at the stop of execution phase 1): below 840 px the decision page needs the
  // second row's 48 px for its question, first card and columns, so the row is hidden while it is shown.
  const secondRowShown = $derived(secondRow !== null && !(compact && deciding));
  // Issue #200: the shown run's live panel, read once, so the compact panel's presence and the compact dashboard's
  // limit (class `running`) follow one value.
  const runOutput = $derived(run === null ? EMPTY_PANEL : (outputs.get(run.id) ?? EMPTY_PANEL));
  /** The run area (issue #133, W1-R1-1): the decision page measures its room from it, and it scrolls in a low window. */
  let runArea = $state<HTMLElement | null>(null);
  // The decision page appears with the run at its top, so that the question and its choices are in view.
  let topFor: string | null = null;
  $effect(() => {
    const key = deciding && analysisKey !== null ? JSON.stringify(analysisKey) : null;
    if (key !== null && key !== topFor && runArea !== null) runArea.scrollTop = 0;
    topFor = key;
  });
  const NARROW_WIDTH = 390;
  // Issue #29: the tab's title names the server's project, so that a narrow tab strip tells two servers apart.
  // Issue #16: a pending prompt, or a watched run's end at a hidden tab, puts its marker in front of the title and a
  // badge on the icon, and is raised once as the user chose: a desktop notification, a chime [visibility of system
  // status, for a user who is not looking at the page]. decide (web/src/notify.ts) decides; this effect only fires.
  // Issue #120 (S17): one decision per tab's run, so that each prompt and each end is raised once whichever tab is shown.
  let notifyStates = $state<Record<string, NotifyState>>({});
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
  const closers: Record<string, Closer | null> = {};
  const shownFor: Record<string, string | null> = {};
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
   * What the page shows of one presented run, as decide observes it (issue #120, S17; issue #191: each refinement run on
   * its own): its pending prompt, the run and its end; the prompt counts as shown only for the run on screen in the
   * selected tab, and only the selected tab's item list as the form for a new task (work review 2 of issue #191,
   * W2-R1-1: another refinement run on screen is not the form, so a run not on screen that ends at a hidden tab still
   * raises its notification and end mark, which clears when the tab becomes visible).
   */
  const observation = (p: Presented): Observation => {
    const watched = p.shown.run;
    const selected = p.mode === mode;
    const onScreen = selected && watched !== null && run !== null && watched.id === run.id;
    return {
      // Issue #153: a question whose analysis is being prepared raises no alert; asked beside its analysis, it does.
      pending: awaitedKey(p.shown),
      run: watched === null || view.incarnation === null ? null : { incarnation: view.incarnation, run: watched.id },
      ended: watched?.ended ?? null,
      visible,
      promptShown: onScreen && (asking || deciding),
      formShown: selected && showList,
      preferences,
      permission,
    };
  };
  /** The decision's reason as one text, the tag of its notification; null for none. */
  const reasonOf = (d: Decision): string | null => (d._tag === "Idle" ? null : JSON.stringify([d._tag, d.key]));
  /** Fires one tab's decision: closes its notification when its reason is gone, and raises a new reason once. */
  const fire = (m: string, decision: Decision) => {
    const reason = reasonOf(decision);
    if (reason !== shownFor[m]) {
      closers[m]?.();
      closers[m] = null;
      shownFor[m] = null;
    }
    if (decision._tag === "Idle" || decision.raise === null || reason === null) return;
    const name = ownName(view.location ?? "");
    const [title, body] = decision._tag === "Waiting" ? [pauseNotificationTitle(name), PAUSE_NOTIFICATION_BODY] : [endNotificationTitle(name, decision.code), ""];
    if (decision.raise === "desktop" || decision.raise === "desktopAndSound") {
      closers[m] = showDesktop(title, body, reason);
      shownFor[m] = reason;
    }
    if (decision.raise === "sound" || decision.raise === "desktopAndSound") playChime();
  };
  $effect(() => {
    const decisions = presented(view).map((p) => [p.key, decide(untrack(() => notifyStates[p.key] ?? initialNotifyState), observation(p))] as const);
    notifyStates = Object.fromEntries(decisions.map(([k, d]) => [k, d.state]));
    // A run no longer presented has its notification closed.
    for (const k of Object.keys(closers)) {
      if (decisions.some(([key]) => key === k)) continue;
      closers[k]?.();
      delete closers[k];
      delete shownFor[k];
    }
    const mark = combinedMark(decisions.map(([, d]) => markOf(d)));
    shownMark = mark;
    document.title = tabTitle(view.location, mark);
    setFavicon(faviconHref(mark, schemeColors()));
    for (const [m, d] of decisions) fire(m, d);
  });
</script>

<svelte:window bind:innerWidth={width} />
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
    <Tabs items={tabItems} bind:tab={() => mode, (value) => selectTab(value as RunMode)} />
  </nav>
  {#if secondRow !== null && secondRowShown}
    <nav class="run-tabs" aria-label={runTabsLabel(mode)}>
      <Tabs secondary items={secondRow} bind:tab={() => focusValue, (value) => selectRunTab(value)} />
    </nav>
  {/if}
  {#if tab.refusal !== null}<p class="notice refusal m3-font-body-medium" role="alert">{tab.refusal}</p>{/if}
  {#if showList}
    <main class="list">
      <!-- W2-R1-2: the run's branch, which holds the other notices, is unmounted while the list shows, so the latest
           notice is shown here at every width and with an ended run attached [help users recognize, diagnose, and
           recover from errors; visibility of system status]. -->
      {#if latestNotice !== null}<p class="notice m3-font-body-small" role="alert">{latestNotice}</p>{/if}
      {#if chain !== null}<ChainControl shown={chain} onChange={setChain} />{/if}
      {#if preparation !== null}<PreparationControl view={preparation} onChange={setPreparation} />{/if}
      <ItemList {mode} items={tab.items} startable={startableOf(view, mode)} abandoned={view.chain === null ? new Set() : abandonedInChain(view.chain)} markOf={(item: ListedItem) => preparationMarkOf(view, item)} {offline} terms={shownTerms(view)} onTerms={(t: TermsMode) => (view = chooseTerms(view, t))} onStart={(item: ListedItem) => startItem(mode, item)} onRefresh={() => requestItems(mode)} />
    </main>
  {:else if run !== null}
    <!-- One tree for both layouts (W2-R1-3): the columns stay mounted, and CSS alone shows or hides them, so a switch
         of panels or a resize across 840 px keeps each panel's reading position [user control and freedom]. -->
    <main class="run" class:compact class:deciding class:paused={analysis !== null && !deciding} bind:this={runArea}>
      {#if compact}
        <details class="progress">
          <Button summary variant="text">{progressOf(run)}</Button>
          {#if chain !== null}<ChainControl shown={chain} onChange={setChain} />{/if}
          <TimelineRail timeline={run.timeline} busy={run.busy} executing={executing(run)} callStartedAt={callStartedAt(run)} rail={railView(run, executing(run), run.busy)} onToggle={toggleRail} />
        </details>
        <!-- While the analysis is shown both panels are hidden, so the buttons would select nothing; "Show the
             conversation" is the way back (W4-R1-1) [aesthetic and minimalist design]. -->
        {#if !deciding}
          <ConnectedButtons>
            {#each ["dashboard", "right"] as const as pane (pane)}
              <Button variant={layout.selected === pane ? "filled" : "tonal"} type="button" aria-pressed={layout.selected === pane} onclick={() => (layout = select(layout, pane))}>
                {TITLES[pane]}{#if pane === "right" && layout.unseen > 0}<span class="badge">&nbsp;{unseenBadge(layout.unseen)}</span>{/if}
              </Button>
            {/each}
          </ConnectedButtons>
        {/if}
        <!-- The latest notice above the panels, whichever is shown (W2-R1-2) [visibility of system status]. -->
        {#if latestNotice !== null}<p class="notice m3-font-body-small" role="alert">{latestNotice}</p>{/if}
      {:else if chain !== null}
        <!-- Issue #147: the chain's control at the top of the rail's column, which holds no question, so the question
             pane and the decision page keep their room. The column takes the rail's place in the grid. -->
        <div class="rail rail-column">
          <ChainControl shown={chain} onChange={setChain} />
          <TimelineRail timeline={run.timeline} busy={run.busy} executing={executing(run)} callStartedAt={callStartedAt(run)} rail={railView(run, executing(run), run.busy)} onToggle={toggleRail} />
        </div>
      {:else}
        <TimelineRail timeline={run.timeline} busy={run.busy} executing={executing(run)} callStartedAt={callStartedAt(run)} rail={railView(run, executing(run), run.busy)} onToggle={toggleRail} />
      {/if}
      {#if analysis !== null && deciding}
        <div class="decision-area">
          {#snippet answers()}
            <QuestionPane
              widget={asking ? run.pending : null}
              identity={pendingKey(shownTab)}
              answersOnly
              {offline}
              expired={run.expired}
              onHold={(prompt) => hold(run, prompt)}
              bind:text={() => draftFor(draft, pendingKey(shownTab)), (text) => { const key = pendingKey(shownTab); drafts = { ...drafts, [draftKey]: key === null ? null : { _tag: "Held", key, text } }; }}
              onAnswer={(prompt, text) => answer(run, prompt, text)} />
          {/snippet}
          <!-- Issue #133: the answers are the decision page's own, under its heading; its open heading is the run's shared state. -->
          <DecisionView {answers} scroller={runArea} openSection={openSectionOf(run.ui, analysis.event.decision)} onSection={(section, open) => { if (run !== null) send({ type: "ui", incarnation: view.incarnation ?? "", run: run.id, flag: { scope: { _tag: "DecisionSection", decision: analysis.event.decision, section }, open } }); }} event={analysis.event} narrow={width < NARROW_WIDTH} open={(entry) => run !== null && isOpen(run.ui, { _tag: "DecisionEntry", decision: analysis.event.decision, entry })} onToggle={(entry, open) => { if (run !== null) send({ type: "ui", incarnation: view.incarnation ?? "", run: run.id, flag: { scope: { _tag: "DecisionEntry", decision: analysis.event.decision, entry }, open } }); }} onShowConversation={() => { conversationFor = analysisKey; conversationForPrompt = promptKey; }} />
        </div>
      {:else if analysis !== null}
        <div class="decision-area back">
          <Button variant="tonal" type="button" name="analysis" onclick={() => { conversationFor = null; conversationForPrompt = null; }}>{SHOW_ANALYSIS}</Button>
        </div>
      {/if}
      <div class="left" class:hidden={!deciding && !shown("dashboard")}>
        <!-- S27 (Q10): a pending prompt's question takes the column; the conversation is one click away and back. -->
        <div class="chat" class:hidden={deciding || asking}>
          <Dashboard {run} answersOpen={isOpen(run.ui, DASHBOARD_ANSWERS)} onAnswers={toggleAnswers} output={runOutput} />
        </div>
        {#if run.pending !== null && !asking}
          <div class="back-to-question">
            <Button variant="tonal" type="button" name="question" onclick={() => (conversationForPrompt = null)}>{SHOW_QUESTION}</Button>
          </div>
        {/if}
        {#if !deciding}
          <QuestionPane
            widget={asking ? run.pending : null}
            identity={pendingKey(shownTab)}
            onShowConversation={() => (conversationForPrompt = promptKey)}
            {offline}
            expired={run.expired}
            onHold={(prompt) => hold(run, prompt)}
            bind:text={() => draftFor(draft, pendingKey(shownTab)), (text) => { const key = pendingKey(shownTab); drafts = { ...drafts, [draftKey]: key === null ? null : { _tag: "Held", key, text } }; }}
            onAnswer={(prompt, text) => answer(run, prompt, text)} />
        {/if}
        <!-- Issue #22 (F1): the status line and every earlier answer stay reachable while the question takes the column;
             below the question, so that it and its first answer keep their place at the top. Issue #200 (requirements
             Q1): not below the decision page, which keeps the window's room; they return on leaving it. -->
        {#if asking && !deciding}
          <div class="dashboard-compact" class:running={hasRunning(runOutput)}><Dashboard {run} compact answersOpen={isOpen(run.ui, DASHBOARD_ANSWERS)} onAnswers={toggleAnswers} output={runOutput} /></div>
        {/if}
        {#if !compact && latestNotice !== null}<p class="notice m3-font-body-small" role="alert">{latestNotice}</p>{/if}
        {#if run.ended !== null}
          <div class="ended">
            <span class="m3-font-body-medium">This task has ended ({endedOutcome(run.ended)}).</span>
            <span class="ended-actions">
              {#if mode === "refinement"}<Button variant="text" type="button" name="close" onclick={() => closeRunTab(run.id)}>{CLOSE_RUN_TAB}</Button>{/if}
              <Button variant="filled" type="button" name="new" onclick={backToList}>{BACK_TO_LIST}</Button>
            </span>
          </div>
        {/if}
      </div>
      <div class="right" class:hidden={!deciding && !shown("right")}>
        <div class="chat" class:hidden={deciding}>
          <ChatPanel title={TITLES.right} messages={run.right} empty="No review yet." visible={shown("right") && !deciding} />
        </div>
      </div>
    </main>
  {/if}
</div>

<style>
  .app { height: 100vh; display: flex; flex-direction: column; background: var(--m3c-surface); color: var(--m3c-on-surface); }
  .list { flex: 1; overflow-y: auto; }
  .tabs, .run-tabs { flex-shrink: 0; }
  .refusal { color: var(--m3c-error); margin: 0.5rem 1rem 0; }
  .run { flex: 1; min-height: 0; display: grid; grid-template-columns: 14rem 1fr 1fr; gap: 0.75rem; padding: 0.75rem; }
  .left, .right { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .left :global(.panel), .right :global(.panel) { flex: 1; }
  .chat { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  /* The analysis spans both chat columns in the first row; the notice and the ended line stay below it (issue #200). */
  /* Issue #133: the decision page holds the question, its answers, the columns and the headings, in that order; the
     question and its answers are at the page's top, in view when it appears. Every control stays, and where the window
     cannot hold them and the columns the run scrolls (the developer's decision of 12 Oct 2026, "Every control stays,
     windows scroll"): the decision row is at least its content and fills the window otherwise, and the row below it
     (the notice and the ended line; no dashboard since issue #200) is its content, however low the window. The rail contributes no
     height of its own (contain: size), so that its content never stretches the rows. */
  .run.deciding { grid-template-rows: minmax(min-content, 1fr) min-content; row-gap: 0; overflow-y: auto; }
  /* Issue #200: the row below the decision page is usually empty, and an empty row's gap took 12 px of the room the
     columns need at 1280 × 800 under issue #191's second row of tabs; the gap is the row's own padding, present only
     when it holds something, and is counted by DecisionView, which measures the row's box. */
  .run.deciding > .left:has(> :not(.hidden)), .run.deciding > .right:has(> :not(.hidden)) { padding-top: 0.75rem; }
  .run.deciding > :global(.rail) { grid-row: 1 / 3; contain: size; }
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
  /* W4-R1-1; issue #133: while the analysis is shown, only the decision area flexes, at least its content and filling
     the window otherwise, and the run scrolls where it cannot hold it (the developer's decision of 12 Oct 2026); the
     columns below it hold the notice and the ended line, sized by their content (issue #200). */
  .run.compact.deciding { overflow-y: auto; }
  .run.compact.deciding > .decision-area { flex: 1 0 auto; }
  .run.compact.deciding .left, .run.compact.deciding .right { flex: 0 0 auto; }
  /* Issue #22 (W1-R1-1 of work review 1): under a question the compact dashboard yields to the question pane and
     scrolls inside itself, the list of every answer losing its own limit and scroll so that one region scrolls; the open
     list then never pushes the question and its first answer out of view (IN_VIEW_MIN_HEIGHT). The question is what is
     new; the earlier answers are secondary while it waits. In the compact layout the column is sized to the window and
     the run scrolls as a whole, so there the dashboard does not shrink, which would hide it, and is bounded by the window
     instead. Issue #200: two limits. While a process runs (`running`, hasRunning) the live panel stands in it and it may
     take a quarter of the column (25vh in the compact layout), the question then possibly falling below the 450-pixel
     promise until the command ends, which the developer accepted (requirements Q2); 40 % had left the pane 283 px at
     1280 × 600 under a question heading and a first answer a paragraph long (296 px with the pane's padding). While none
     runs it takes at most a fifth (20vh): issue #191's second row of tabs (48 px) shortened the column to about 416 px at
     1280 × 600, and a fifth (about 83 px) still holds the closed compact form (66 px there) while returning the question
     its room (L34). */
  .dashboard-compact { flex: 0 1 auto; min-height: 0; overflow-y: auto; }
  .run.compact .dashboard-compact { flex: none; }
  .dashboard-compact.running { max-height: 25%; }
  .run.compact .dashboard-compact.running { max-height: 25vh; }
  .dashboard-compact:not(.running) { max-height: 20%; }
  .run.compact .dashboard-compact:not(.running) { max-height: 20vh; }
  .dashboard-compact :global(.dashboard.compact) { min-height: 0; }
  .dashboard-compact :global(.answers) { max-height: none; overflow: visible; }
  .progress { border-radius: var(--m3-shape-medium); background: var(--m3c-surface-container-low); }
  .rail-column { display: flex; flex-direction: column; gap: 0.5rem; min-height: 0; }
  .rail-column > :global(nav.rail) { flex: 1 1 auto; min-height: 0; }
  .progress :global(.rail) { max-height: 40vh; }
  .badge { font-weight: 700; }
  .ended-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; justify-content: flex-end; }
  .ended { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.75rem; background: var(--m3c-surface-container); }
  .notice { margin: 0; padding: 0.5rem 0.75rem; color: var(--m3c-on-error-container); background: var(--m3c-error-container); }
  .unsent { padding: 0.5rem 0.75rem; background: var(--m3c-surface-container-high); }
  .unsent h2 { margin: 0 0 0.25rem; }
  .unsent ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 0.25rem; }
  .unsent li { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .unsent-text { white-space: pre-wrap; word-break: break-word; user-select: text; }
</style>

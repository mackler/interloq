import type { Locator, Page } from "@playwright/test";
import { dashboard, expect, listOf, listTabOf, runTabOf, runTabsOf, startFromTab, tabOf, test, toHaveEnded, toTheList } from "./fixtures.ts";
import { TERMS_CHOICE_LABEL, TERMS_CHOICE_TEXTS, TERMS_ON_REQUEST_NOTE, CHAIN_SOURCE_LABEL, CHAIN_SOURCE_TEXTS, CHAIN_SWITCH_LABEL, QUEUE_EMPTY, QUEUE_HEADING, queueRemoveName, attachedHeading, CONTEXT_HEADING, QUESTION_HISTORY_HEADING, RECOMMENDATION_HEADING, YOUR_CHOICE, PANEL_SPLIT_LABEL, RAIL_WIDTH_LABEL, CHAIN_INVALID_RUNS, clarificationProgress, progressLine, RAIL_CONDITION_LABEL, railToggleName, stageHeading, stepLabel, stepOfPhase, CONTINUE_WITHOUT_DECIDING, END_CLARIFICATION, HELP_ME_DECIDE, SHOW_CONVERSATION, SHOW_QUESTION, LIMIT_PAUSED_MARK, TAB_TEXTS } from "../src/prompts.ts";
import { markedTabName } from "../web/src/notify.ts";
import { LIVE_LONG_LINE, LIVE_LONG_NAME, LIVE_RED_TEXT, LONG_ANSWERS, LONG_ITEM_TITLE, LONG_STEP_LABEL, NARRATION_LONG_COMMAND } from "./longAnswers.ts";
import { LAYOUT_PORTS, type LayoutScenario, layoutUrl, modeOf } from "./ports.ts";
import { floorPx, IN_VIEW_MIN_HEIGHT } from "../web/src/layout.ts";

// Finding 7 of docs/gui-review.md, decision Q3: the layout adapts. At M3's expanded width (840 px and wider) the rail
// and both columns are side by side; below it, one column at a time, chosen by its title, and a prompt selects "You and
// Interloq". Issue #22: that column is the dashboard, which has no message list, so only "Claude and Codex" keeps a
// reading position, a chip of new messages and a badge on its button. The "tabs" server asks two decisions in a row.
const URL = layoutUrl("tabs");
const LEFT = "You and Interloq";
const RIGHT = "Claude and Codex";
const panel = (page: Page, name: string) => page.getByRole("region", { name });
/** The question the run waits on, which takes the left column while it is pending (S27); its order is issue #137's. */
const pane = (page: Page) => page.locator("section.pane");
const asking = (page: Page, text: string) => pane(page).locator(".question-text", { hasText: text });
const continueWithoutDeciding = (page: Page) => pane(page).getByRole("button", { name: CONTINUE_WITHOUT_DECIDING, exact: true });
/** Issue #137: a section of the question pane, a disclosure named by its heading. */
const sectionToggle = (page: Page, heading: string) => pane(page).getByRole("button", { name: heading, exact: true });
/** The body a section's toggle controls, rendered only while it is open. */
const sectionBody = async (page: Page, heading: string) => page.locator(`#${await sectionToggle(page, heading).getAttribute("aria-controls")}`);
/** Issue #137: the section starts closed and expands on a click; returns its body. */
const expandSection = async (page: Page, heading: string) => {
  const toggle = sectionToggle(page, heading);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const body = await sectionBody(page, heading);
  await expect(body).toBeVisible();
  return body;
};
const confirmEnd = (page: Page) => page.locator("dialog[open] button[name=confirm-end]").click();
const box = async (locator: Locator) => {
  const b = await locator.boundingBox();
  if (b === null) throw new Error("the element is not visible");
  return b;
};
/** Opens the page and starts a run from the first item of the scenario's mode's list (issue #120: there is no form). */
const startTask = (page: Page, url = URL) => {
  const scenario = (Object.keys(LAYOUT_PORTS) as LayoutScenario[]).find((k) => layoutUrl(k) === url) ?? "tabs";
  return startFromTab(page, url, modeOf(scenario));
};
const FIRST = "Which database should the service use?";
const SECOND = "Which cache should the service use?";

/** The assertions of a compact window: no horizontal overflow, a usable panel and answer field, the panel switch. */
const compactChecks = async (page: Page, context: import("@playwright/test").BrowserContext, minHeight: number) => {
  await startTask(page);
  await expect(asking(page, FIRST)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page overflows horizontally").toBe(true);
  // S27 and issue #20: the question the run waits on takes the column; the transcript is out of the way.
  const left = await box(pane(page));
  expect(left.width, "the panel's width").toBeGreaterThanOrEqual(300);
  expect(left.height, "the panel's height").toBeGreaterThanOrEqual(minHeight);
  expect((await box(page.locator("[name=answer]"))).width, "the answer field's width").toBeGreaterThanOrEqual(280);
  await expect(panel(page, RIGHT)).toBeHidden();

  // The other panel by its title; a prompt brings the dashboard's column, "You and Interloq", back.
  await page.getByRole("button", { name: new RegExp(RIGHT) }).click();
  await expect(panel(page, RIGHT)).toBeVisible();
  await expect(pane(page)).toBeHidden();
  const other = await context.newPage();
  await other.goto(URL);
  await continueWithoutDeciding(other).click();
  await expect(asking(page, SECOND)).toBeVisible();
  await expect(panel(page, RIGHT)).toBeHidden();

  // Messages that arrive in the hidden panel are counted on its button.
  await continueWithoutDeciding(other).click();
  await expect(page.getByRole("button", { name: new RegExp(`${RIGHT}.*[1-9][0-9]* new`) })).toBeVisible();
  await toHaveEnded(page, "Completed");
  await other.close();
};

// W2-R1-3 and P3-R1-1 (work review 2 and planning 3): the right panel keeps its reading position across a switch and a
// resize, and when it was hidden it follows its end when shown again, unless the user had scrolled it up. Issue #22: the
// dashboard has no list, so these are the right panel's alone.
const LONG_URL = layoutUrl("long");
const list = (page: Page, name: string) => panel(page, name).locator(".list");
const fromEnd = (l: Locator) => l.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
const toTop = (l: Locator) =>
  l.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
const showPanel = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
/** The long run at its idle pause, with the conversation shown instead of the question (S27). */
const longRunAtItsPrompt = async (page: Page) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await startTask(page, LONG_URL);
  await expect(continueWithoutDeciding(page)).toBeVisible({ timeout: 180_000 });
  await pane(page).getByRole("button", { name: SHOW_CONVERSATION }).click();
};
/** Back to the question from the conversation, and the answer that continues the run. */
const answerContinue = async (page: Page) => {
  await page.getByRole("button", { name: SHOW_QUESTION }).click();
  await continueWithoutDeciding(page).click();
};

// Issue #12: an interview's numbered answers that run to a paragraph each are cards that hold their full text, in a
// narrow and in a wide window; a card is a native button, chosen by keyboard, and the transcript keeps the full line.
const LONG_CHOICES_URL = layoutUrl("longChoices");
// Decision support (decision Q5): one column per option at every allowed width, side by side when they fit, scrolling
// sideways when they do not; below 390 px a message instead. Issue #133 (the developer's instruction of 11 Oct 2026,
// decision G-R1-1 of its requirements): the page shows the question as its heading, the choices under it, the columns,
// then the collapsed headings; by the developer's decision of 12 Oct 2026 ("Every control stays, windows scroll") every
// control stays under the question and the run scrolls where the window cannot hold them and the columns, which keep a
// floor of 15rem.
const DECIDE_URL = layoutUrl("decide");
const analysisOf = (page: Page) => page.getByRole("region", { name: new RegExp(`^${YOUR_CHOICE} `) });
const cards = (page: Page) => page.getByRole("group", { name: "Proposed answers" }).getByRole("button");
const sectionButtons = (analysis: Locator) => analysis.locator(".sections button.toggle");
const sectionButton = (analysis: Locator, heading: string) => sectionButtons(analysis).filter({ hasText: heading });
const bodyOf = async (page: Page, button: Locator) => page.locator(`#${await button.getAttribute("aria-controls")}`);
const openAnalysisAt = async (page: Page, url: string, width: number, height: number) => {
  await page.setViewportSize({ width, height });
  await startTask(page, url);
  await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
  const analysis = analysisOf(page);
  await expect(analysis).toBeVisible();
  return analysis;
};
const openAnalysis = (page: Page, width = 1280, height = 800) => openAnalysisAt(page, DECIDE_URL, width, height);
const openLongAnalysis = (page: Page, width: number, height: number) => openAnalysisAt(page, layoutUrl("decideLong"), width, height);
/** Two animation frames, after which a layout that measures on resize has settled. */
const settled = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
/** The element's whole box lies in the window. */
const inWindow = async (page: Page, locator: Locator, what: string) => {
  const b = await box(locator);
  const height = page.viewportSize()?.height ?? 0;
  expect(b.y, `${what}'s top is above the window`).toBeGreaterThanOrEqual(-1);
  expect(b.y + b.height, `${what} is below the window`).toBeLessThanOrEqual(height + 1);
};
const runNotScrolled = async (page: Page) => expect(await page.locator("main.run").evaluate((el) => el.scrollTop), "the run scrolled").toBe(0);
/** The run area holds all its content: nothing to scroll (the developer's decision of 12 Oct 2026 keeps this at 1280 × 800). */
const runFits = async (page: Page) => {
  const m = await page.locator("main.run").evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(m.scroll, `the run scrolls: ${JSON.stringify(m)}`).toBeLessThanOrEqual(m.client + 1);
};
const toRunTop = (page: Page) => page.locator("main.run").evaluate((el) => el.scrollTo({ top: 0 }));
/** The columns' floor in pixels, from the page's root font size (W1-R1-1: `floorPx` of web/src/layout.ts). */
const floorOf = async (page: Page) => floorPx(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize)));
const heightOf = async (l: Locator) => (await box(l)).height;
/**
 * The developer's decision of 12 Oct 2026 ("Every control stays, windows scroll"): nothing on the decision page is
 * clipped. The element is scrolled into view, and its box then lies in the window and inside the visible box of every
 * ancestor that clips.
 */
const unclipped = async (page: Page, locator: Locator, what: string) => {
  await locator.scrollIntoViewIfNeeded();
  await settled(page);
  await inWindow(page, locator, what);
  const clipped = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    for (let a = el.parentElement; a !== null; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const ar = a.getBoundingClientRect();
      const top = ar.top + a.clientTop, left = ar.left + a.clientLeft;
      if (r.top < top - 1 || r.bottom > top + a.clientHeight + 1 || r.left < left - 1 || r.right > left + a.clientWidth + 1) return `${a.tagName}.${a.className}`;
    }
    return null;
  });
  expect(clipped, `${what} is clipped by an ancestor`).toBeNull();
};
/** Every control and region of the decision page under its question: the answers' controls, the columns' region and the headings. */
const everyPart = (analysis: Locator) => analysis.locator(".answers button:visible, .answers textarea:visible, .answers input:not([type=hidden]):visible, .sideways, .sections button.toggle");
/**
 * The decision page's order (issue #133) as the developer's decision of 12 Oct 2026 keeps it: the heading is the
 * question, both choice cards are in the window side by side with nothing scrolled, no "Help me decide" is offered,
 * every heading is closed, the columns keep their floor, and nothing is clipped: every part is reached by scrolling the
 * run. At 1280 × 800 (`roomy`) the run does not scroll, the columns are the tallest region and every heading is in view;
 * at 640 px and wider the headings share one row (`oneRow`).
 */
const theOrder = async (page: Page, analysis: Locator, options: Readonly<{ question: string; oneRow: boolean; roomy: boolean }>) => {
  await settled(page);
  const heading = (await analysis.locator("h2").textContent())?.replace(/\s+/g, " ").trim() ?? "";
  expect(heading.startsWith(`${YOUR_CHOICE} `), heading).toBe(true);
  expect(heading).toContain(options.question);
  await runNotScrolled(page);
  const [first, second] = [cards(page).nth(0), cards(page).nth(1)];
  await inWindow(page, analysis.locator("h2"), "the question");
  await inWindow(page, first, "the first card");
  await inWindow(page, second, "the second card");
  const [a, b] = [await box(first), await box(second)];
  expect(Math.abs(a.y - b.y), "the two cards are not in one row").toBeLessThanOrEqual(1);
  expect(b.x, "the second card is not beside the first").toBeGreaterThanOrEqual(a.x + a.width - 1);
  await expect(page.getByRole("button", { name: HELP_ME_DECIDE })).toHaveCount(0);
  const buttons = sectionButtons(analysis);
  expect(await buttons.count()).toBeGreaterThan(0);
  for (const button of await buttons.all()) await expect(button).toHaveAttribute("aria-expanded", "false");
  expect(await heightOf(analysis.locator(".sideways")), "the columns are lower than their floor").toBeGreaterThanOrEqual((await floorOf(page)) - 1);
  if (options.oneRow) {
    const tops = await Promise.all((await buttons.all()).map(async (button) => (await box(button)).y));
    for (const y of tops) expect(Math.abs(y - tops[0]), "the headings are not in one row").toBeLessThanOrEqual(1);
  }
  if (options.roomy) {
    await runFits(page);
    const heights = await analysis.evaluate((el) => Object.fromEntries([".head", ".answers", ".sideways", ".sections"].map((s) => [s, el.querySelector(s)?.getBoundingClientRect().height ?? 0])));
    for (const other of [".head", ".answers", ".sections"]) expect(heights[".sideways"], `the columns are not taller than ${other}: ${JSON.stringify(heights)}`).toBeGreaterThan(heights[other]);
    for (const button of await buttons.all()) await expect(button).toBeInViewport();
  }
  const parts = everyPart(analysis);
  for (let i = 0; i < (await parts.count()); i++) await unclipped(page, parts.nth(i), `part ${i} (${await parts.nth(i).evaluate((el) => el.className || el.tagName)})`);
  await toRunTop(page);
};
/**
 * An opened heading (issue #133, W1-R1-1): its text scrolls inside itself when longer than its body, the columns keep
 * their floor. Where the window has room (`roomy`, 1280 × 800) the run does not scroll, the text, the question, the cards
 * and every heading stay in view, and the text takes at most half the height it shares with the columns (allotWithFloor);
 * elsewhere the text has at least the smaller of its content and half the floor, and is reached by scrolling the run.
 */
const openedText = async (page: Page, analysis: Locator, heading: string, roomy: boolean) => {
  const button = sectionButton(analysis, heading);
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await settled(page);
  const body = await bodyOf(page, button);
  const floor = await floorOf(page);
  const m = await body.evaluate((el) => ({ body: el.getBoundingClientRect().height, sideways: el.parentElement?.querySelector(".sideways")?.getBoundingClientRect().height ?? null, scroll: el.scrollHeight, client: el.clientHeight, overflowY: getComputedStyle(el).overflowY }));
  if (m.scroll > m.client + 1) expect(m.overflowY, "the text does not scroll inside itself").toBe("auto");
  if (m.sideways !== null) expect(m.sideways, `the columns are lower than their floor: ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(floor - 1);
  if (roomy) {
    await runFits(page);
    expect(m.body, `the text takes more than half: ${JSON.stringify(m)}`).toBeLessThanOrEqual(Math.floor((m.body + (m.sideways ?? 0)) / 2) + 1);
    await expect(body).toBeInViewport({ ratio: 1 });
    await inWindow(page, analysis.locator("h2"), "the question");
    for (const card of await cards(page).all()) await inWindow(page, card, "a card");
    for (const other of await sectionButtons(analysis).all()) await expect(other).toBeInViewport({ ratio: 1 });
  } else {
    expect(m.body, `the text is lower than its floor: ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(Math.min(m.scroll, Math.ceil(floor / 2)) - 1);
    await unclipped(page, body, `the text of ${heading}`);
  }
  return { body, overflows: m.scroll > m.client + 1 };
};
/** One heading at a time: each heading opened in turn closes the one opened before it. */
const opensInTurn = async (page: Page, analysis: Locator, headings: readonly string[], roomy: boolean) => {
  let before: Locator | null = null;
  for (const heading of headings) {
    await openedText(page, analysis, heading, roomy);
    if (before !== null) await expect(before).toHaveAttribute("aria-expanded", "false");
    before = sectionButton(analysis, heading);
  }
  await toRunTop(page);
};
/**
 * The developer's decision of 9 Oct 2026 (issue #120): on the question page the question and its first answer stay in
 * view without the run scrolling in windows 450 pixels high and taller; below that, the run area may scroll. So a window
 * lower than 450 px asserts what still holds there: the page does not overflow sideways, the question is in view, and
 * the first answer is reached by scrolling. The limit is `IN_VIEW_MIN_HEIGHT` of web/src/layout.ts.
 */
const belowTheLimit = async (page: Page, question: Locator) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page overflows horizontally").toBe(true);
  await expect(question).toBeInViewport();
  const first = page.getByRole("group", { name: "Proposed answers" }).getByRole("button").first();
  await first.scrollIntoViewIfNeeded();
  await expect(first).toBeInViewport();
};
const answerDismisses = async (page: Page, analysis: Locator) => {
  await cards(page).filter({ hasText: "SQLite" }).first().click();
  await expect(analysis).toBeHidden();
};

// S29 (Q10, issue #20): a question with a long context, many terms and long options keeps the question and its first
// option in view together at every supported size; each region scrolls on its own to its end with the question still in
// view, and the answer controls can be reached.
const LONG_QUESTION_URL = layoutUrl("longQuestion");
// S49 (W4-R1-1): a permission request whose command runs to 40 lines keeps its question and first option in view together,
// in the question pane and beside a decision's analysis; the command is read by scrolling the details.
const PERMISSION_URL = layoutUrl("permissionLong");
/** A face the renderer used for an element's text, as the Chrome DevTools Protocol reports it (issue #73). */
type UsedFont = Readonly<{ familyName: string; postScriptName: string; glyphCount: number }>;
/** The faces actually used for the text of the first element matching `selector`: not the declared family, which falls through silently. */
const usedFont = async (page: Page, selector: string): Promise<readonly UsedFont[]> => {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (nodeId === 0) throw new Error(`no element matches ${selector}`);
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    return fonts;
  } finally {
    await cdp.detach();
  }
};
// (L22) S51 (W3-R1-2 of work review 5): code in rendered Markdown keeps its whitespace visually. A code element's text
// keeps every space, but the browser's default white-space collapses runs and drops the spaces at the edges, so
// "a b", "a  b" and "a<tab>b" would look alike and " a " like "a". Measured in the question pane, beside an analysis and
// in the transcript's answered exchange.
const WHITESPACE_URL = layoutUrl("whitespace");
const WHITESPACE_VALUES = ["a b", "a  b", "a\tb", " a ", "a"] as const;
const widths = async (scope: Locator) =>
  scope.evaluate((root, values) => {
    const codes = [...root.querySelectorAll("code")];
    return values.map((v) => {
      const code = codes.find((c) => c.textContent === v);
      return code === undefined ? -1 : code.getBoundingClientRect().width;
    });
  }, [...WHITESPACE_VALUES]);
const distinctWidths = async (what: string, scope: Locator) => {
  const [single, double, tab, edged, bare] = await widths(scope);
  for (const [name, w] of [["a b", single], ["a  b", double], ["a\\tb", tab], [" a ", edged], ["a", bare]] as const) expect(w, `${what}: the code element of "${name}"`).toBeGreaterThan(0);
  expect(double, `${what}: "a  b" wider than "a b"`).toBeGreaterThan(single);
  expect(tab, `${what}: "a\\tb" wider than "a  b"`).toBeGreaterThan(double);
  expect(edged, `${what}: " a " wider than "a"`).toBeGreaterThan(bare);
};
// (L23) S52 (W5-R1-1): the exhaustion pause after a fault of 2,500 characters. The question names the agent and the call
// only; the attempts and the whole fault, <endpoint> included (shown literally, P6-R1-1), are in its attached material,
// a collapsed section under the choices since issue #137.
const TRANSPORT_LONG_URL = layoutUrl("transportLong");

// Issue #204: the rail's rows inside its column and unclipped (L31), at any width the developer chose.
const railProblems = (nav: Locator): Promise<string[]> =>
  nav.evaluate((rail) => {
    const out: string[] = [];
    const left = (el: Element | null) => (el === null ? NaN : el.getBoundingClientRect().left);
    const visible = (el: Element) => el.getBoundingClientRect().width > 0;
    const style = getComputedStyle(rail);
    const inner = rail.getBoundingClientRect().right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
    if (rail.scrollWidth > rail.clientWidth) out.push(`the rail overflows sideways: ${rail.scrollWidth} > ${rail.clientWidth}`);
    for (const entry of rail.querySelectorAll(".entry")) {
      const phaseLabel = entry.querySelector(":scope > button [data-label], :scope > [data-label]");
      const phaseMark = entry.querySelector(":scope > button > .mark, :scope > .mark");
      for (const stage of entry.querySelectorAll(".stage")) {
        const stageLabel = stage.querySelector(":scope > button [data-stage], :scope > [data-stage]");
        const stageMark = stage.querySelector(":scope > button > .mark, :scope > .mark");
        const name = stageLabel?.textContent?.trim() ?? "?";
        if (!(left(stageLabel) > left(phaseLabel))) out.push(`${name}: its label starts at ${left(stageLabel)}, not right of its phase's at ${left(phaseLabel)}`);
        if (!(left(stageMark) > left(phaseMark))) out.push(`${name}: its mark starts at ${left(stageMark)}, not right of its phase's at ${left(phaseMark)}`);
        for (const step of stage.querySelectorAll(".plan-step")) {
          const stepLabel = step.querySelector("[data-plan-step-label]");
          const stepMark = step.querySelector(":scope > .mark");
          const stepName = stepLabel?.textContent?.trim() ?? "?";
          if (!(left(stepLabel) > left(stageLabel))) out.push(`${stepName}: its label starts at ${left(stepLabel)}, not right of its stage's at ${left(stageLabel)}`);
          if (!(left(stepMark) > left(stageMark))) out.push(`${stepName}: its mark starts at ${left(stepMark)}, not right of its stage's at ${left(stageMark)}`);
        }
      }
    }
    for (const el of rail.querySelectorAll("[data-label], [data-stage], [data-step-label], [data-plan-step], [data-plan-step-label], button.rail-toggle")) {
      if (!visible(el)) continue;
      const name = el.textContent?.trim().slice(0, 40) ?? "?";
      if (el.getBoundingClientRect().right > inner + 0.5) out.push(`${name}: its right edge ${el.getBoundingClientRect().right} is past the rail's content at ${inner}`);
      if (el.scrollWidth > el.clientWidth + 0.5 && getComputedStyle(el).display !== "inline") out.push(`${name}: clipped, ${el.scrollWidth} > ${el.clientWidth}`);
    }
    return out;
  });
/** The chain's control lies within the rail's column and does not overflow it (issue #204), and so does every part of it
 *  with a box, each outlined field's container, input and outline included (issue #203). */
const chainInside = async (page: Page) => {
  const m = await page.locator("div.rail-column").evaluate((column) => {
    const chain = column.querySelector(".chain");
    if (chain === null) return null;
    const [c, k] = [column.getBoundingClientRect(), chain.getBoundingClientRect()];
    const outside: string[] = [];
    for (const el of chain.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0) continue;
      const name = `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} "${el.textContent?.trim().slice(0, 40) ?? ""}"`;
      if (r.left < c.left - 0.5) outside.push(`${name}: its left edge ${r.left} is left of the column's ${c.left}`);
      if (r.right > c.right + 0.5) outside.push(`${name}: its right edge ${r.right} is ${r.right - c.right} px past the column's ${c.right}`);
    }
    return { left: k.left - c.left, right: c.right - k.right, scroll: chain.scrollWidth, client: chain.clientWidth, outside };
  });
  expect(m, "the chain's control is in the rail's column").not.toBe(null);
  if (m === null) return;
  expect(m.left, `the chain's control starts left of its column: ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(-0.5);
  expect(m.right, `the chain's control ends right of its column: ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(-0.5);
  expect(m.scroll, `the chain's control overflows: ${JSON.stringify(m)}`).toBeLessThanOrEqual(m.client + 0.5);
  expect(m.outside, `parts of the chain's control lie outside the rail's column:\n${m.outside.join("\n")}`).toEqual([]);
};
const railSeparator = (page: Page) => page.locator('[data-column-resize="rail"]');
const panelsSeparator = (page: Page) => page.locator('[data-column-resize="panels"]');
const valueOf = async (separator: Locator) => Number(await separator.getAttribute("aria-valuenow"));
const rootPx = (page: Page) => page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
/** Drags a separator sideways by `dx` pixels with the mouse, as L36 drags the live panel's handle. */
const dragBy = async (page: Page, separator: Locator, dx: number) => {
  const h = await box(separator);
  const [x, y] = [h.x + h.width / 2, h.y + Math.min(h.height / 2, 40)];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
};
const noSidewaysScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page overflows horizontally").toBe(true);
/** The widest rail and the narrowest left panel, so the question's panel is at its narrowest (issue #204). */
const widestBounds = async (page: Page) => {
  await railSeparator(page).focus();
  await page.keyboard.press("End");
  await expect(railSeparator(page)).toHaveAttribute("aria-valuenow", (await railSeparator(page).getAttribute("aria-valuemax")) ?? "");
  if ((await panelsSeparator(page).count()) > 0) {
    await panelsSeparator(page).focus();
    await page.keyboard.press("Home");
    await expect(panelsSeparator(page)).toHaveAttribute("aria-valuenow", (await panelsSeparator(page).getAttribute("aria-valuemin")) ?? "");
  }
  await settled(page);
};

test.describe("the tests of the tabs server, in order", () => {
  test.describe.configure({ mode: "default" });

  test("(L1) a phone-sized window, 390 × 844: one usable panel at a time, no horizontal overflow", async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await compactChecks(page, context, 400);
  });

  test("(L2) a desktop window at 200 % zoom (a 640 × 400 CSS viewport): the same, with a smaller height", async ({ page, context }) => {
    await page.setViewportSize({ width: 640, height: 400 });
    await compactChecks(page, context, 200);
  });

  test("(L3) a desktop window, 1280 × 800: the rail and both panels side by side", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await startTask(page);
    await expect(asking(page, FIRST)).toBeVisible();
    const rail = await box(page.getByRole("navigation", { name: "Progress of the run" }));
    const left = await box(pane(page));
    const right = await box(panel(page, RIGHT));
    expect(rail.x + rail.width).toBeLessThanOrEqual(left.x);
    expect(left.x + left.width).toBeLessThanOrEqual(right.x);
    await expect(page.getByRole("button", { name: new RegExp(RIGHT) })).toHaveCount(0);
    await continueWithoutDeciding(page).click();
    await expect(asking(page, SECOND)).toBeVisible();
    await continueWithoutDeciding(page).click();
    await toHaveEnded(page, "Completed");
  });

  // W2-R1-2: a notice is visible whichever panel is shown; here the server's own end (finding 15).
  test("(L7) with the right panel shown, the page still says that the server has ended", async ({ page }) => {
    let route: import("@playwright/test").WebSocketRoute | null = null;
    await page.routeWebSocket(/\/ws$/, (ws) => {
      route = ws;
      ws.connectToServer();
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await startTask(page);
    await expect(asking(page, FIRST)).toBeVisible();
    await showPanel(page, RIGHT);
    await expect(panel(page, RIGHT)).toBeVisible();
    route!.send(JSON.stringify({ type: "closing" }));
    await expect(page.getByText("The server has ended. The page reconnects when it is started again.")).toBeVisible();
    await expect(panel(page, RIGHT)).toBeVisible();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  // W2-R1-1: prompt 1 of a new run is a new prompt, although its number is that of the old run's prompt. The page is
  // disconnected while run 1 ends and run 2 starts, so the replay brings run 2's prompt 1 with no step without a prompt.
  test("(L8) a new run's first prompt selects the dashboard's column although the old run waited on a prompt of the same number", async ({ page, context }) => {
    let hold = false;
    let current: import("@playwright/test").WebSocketRoute | null = null;
    await page.routeWebSocket(/\/ws$/, (ws) => {
      if (hold) {
        ws.close();
        return;
      }
      current = ws;
      ws.connectToServer();
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await startTask(page);
    await expect(asking(page, FIRST)).toBeVisible();
    await showPanel(page, RIGHT);
    hold = true;
    await current!.close();
    const other = await context.newPage();
    await other.goto(URL);
    await other.locator("button[name=stop]").click();
    await confirmEnd(other);
    const second = await startFromTab(other, URL, "implementation");
    await expect(asking(other, FIRST)).toBeVisible();
    hold = false;
    await expect(page.getByText("connected", { exact: true })).toBeVisible();
    await expect(page.getByText(`Refined item ${second}`).first()).toBeVisible();
    await expect(pane(page)).toBeVisible();
    await expect(page.getByRole("button", { name: new RegExp(`^${LEFT}`) })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[name=answer]")).toBeVisible();
    await other.close();
  });

  /** Removes every entry of the queue editor's queue, one at a time, by its Remove button. */
  async function emptyQueue(editor: Locator): Promise<void> {
    const queued = editor.locator("li[data-queued]");
    for (let left = await queued.count(); left > 0; left = await queued.count()) {
      const label = (await queued.first().locator(".headline").textContent())?.trim() ?? "";
      await queued.first().getByRole("button", { name: queueRemoveName(label), exact: true }).click();
      await expect(queued).toHaveCount(left - 1, { timeout: 10_000 });
    }
  }

  // Issue #196: the queue editor in the Implementation tab's list view: its rows hold their text and buttons, none drawn
  // over the next, the long title whole and wrapped, and the page never scrolls sideways.
  for (const [width, height] of [[1280, 800], [640, 400], [390, 844]] as const) {
    test(`(L42) the queue editor at ${width} × ${height}: rows hold their text and buttons, the long title whole`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto(URL);
      await expect(page.getByText("connected", { exact: true })).toBeVisible();
      await toTheList(page, "implementation");
      const control = page.getByRole("region", { name: CHAIN_SWITCH_LABEL });
      await control.getByRole("radiogroup", { name: CHAIN_SOURCE_LABEL }).getByText(CHAIN_SOURCE_TEXTS.queue, { exact: true }).click();
      const editor = page.getByRole("region", { name: QUEUE_HEADING });
      await expect(editor).toBeVisible();
      const queued = editor.locator("li[data-queued]");
      // The server is shared by the describe's tests, whose runs leave items implementing and whose queues stay in its
      // chain.json: the queue is emptied first, and the items queued are those the list offers now.
      await emptyQueue(editor);
      await expect(listOf(page).locator('button[name=queue-add][data-item="41"]')).toBeVisible();
      const others = await listOf(page).locator("button[name=queue-add]:enabled").evaluateAll((buttons) =>
        buttons.map((b) => b.getAttribute("data-item")).filter((item): item is string => item !== null && item !== "41").slice(0, 2));
      for (const [i, item] of ["41", ...others].entries()) {
        await listOf(page).locator(`button[name=queue-add][data-item="${item}"]`).click();
        await expect(queued).toHaveCount(i + 1, { timeout: 10_000 });
      }
      await expect(queued).toHaveCount(3, { timeout: 10_000 });
      const problems = await editor.evaluate((section, title) => {
        const out: string[] = [];
        const TOLERANCE = 0.5;
        const s = section.getBoundingClientRect();
        const rows = [...section.querySelectorAll("li[data-queued]")];
        rows.forEach((row, i) => {
          const r = row.getBoundingClientRect();
          const name = row.textContent?.trim().slice(0, 30) ?? "?";
          const next = rows[i + 1];
          if (next !== undefined && r.bottom > next.getBoundingClientRect().top + TOLERANCE) out.push(`${name}: its bottom ${r.bottom} is below the next row's top ${next.getBoundingClientRect().top}`);
          for (const el of row.querySelectorAll("p, span, button")) {
            const b = el.getBoundingClientRect();
            if (b.width === 0 && b.height === 0) continue;
            if (b.top < r.top - TOLERANCE || b.bottom > r.bottom + TOLERANCE || b.left < r.left - TOLERANCE || b.right > r.right + TOLERANCE) out.push(`${name}: ${el.tagName} (${el.textContent?.trim().slice(0, 20)}) at ${b.left}–${b.right} × ${b.top}–${b.bottom} lies outside its row at ${r.left}–${r.right} × ${r.top}–${r.bottom}`);
          }
          for (const button of row.querySelectorAll("button[aria-label]")) {
            const b = button.getBoundingClientRect();
            if (b.left < s.left - TOLERANCE || b.right > s.right + TOLERANCE) out.push(`${name}: ${button.getAttribute("aria-label")} lies outside the editor`);
          }
        });
        const long = rows.find((row) => row.textContent?.includes(title));
        const headline = long?.querySelector(".headline");
        if (headline === undefined || headline === null) return [...out, "no row holds the long title"];
        const lineHeight = parseFloat(getComputedStyle(headline).lineHeight);
        if (!(headline.getBoundingClientRect().height > 1.5 * lineHeight)) out.push(`the long title did not wrap: ${headline.getBoundingClientRect().height} px`);
        if (headline.scrollWidth > headline.clientWidth + TOLERANCE || headline.scrollHeight > headline.clientHeight + TOLERANCE) out.push("the long title is clipped");
        return out;
      }, LONG_ITEM_TITLE);
      expect(problems).toEqual([]);
      await noSidewaysScroll(page);
      // The server is shared by the file's other tests: the queue is left empty and its source goes back to the backlog,
      // which hides the editor.
      await emptyQueue(editor);
      await expect(queued).toHaveCount(0);
      await control.getByRole("radiogroup", { name: CHAIN_SOURCE_LABEL }).getByText(CHAIN_SOURCE_TEXTS.backlog, { exact: true }).click();
      await expect(editor).toHaveCount(0);
    });
  }

  // Issue #163 (decision Q1): the line under the choice of terms, while On request is selected, stands under the
  // buttons and above the first item, inside the list, and the page never scrolls sideways.
  for (const [width, height] of [[1280, 800], [640, 400], [390, 844]] as const) {
    test(`(L43) the terms-on-request note at ${width} × ${height}: under the choice, inside the list, nothing overflowing`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto(URL);
      await expect(page.getByText("connected", { exact: true })).toBeVisible();
      await toTheList(page, "refinement");
      const choice = page.getByRole("radiogroup", { name: TERMS_CHOICE_LABEL });
      // The server's shared configuration names unchecked (e2e/server.ts), so the note shows only after this click.
      await choice.getByText(TERMS_CHOICE_TEXTS.onRequest, { exact: true }).click();
      const note = page.getByText(TERMS_ON_REQUEST_NOTE, { exact: true });
      await expect(note).toBeVisible();
      const TOLERANCE = 0.5;
      const box = async (l: Locator) => {
        const b = await l.boundingBox();
        if (b === null) throw new Error("no bounding box");
        return b;
      };
      const n = await box(note);
      const c = await box(choice);
      const list = await box(listOf(page));
      const row = await box(listOf(page).locator("ul > li").first());
      expect(n.y).toBeGreaterThanOrEqual(c.y + c.height - TOLERANCE);
      expect(n.x).toBeGreaterThanOrEqual(list.x - TOLERANCE);
      expect(n.x + n.width).toBeLessThanOrEqual(list.x + list.width + TOLERANCE);
      expect(n.y + n.height).toBeLessThanOrEqual(row.y + TOLERANCE);
      await noSidewaysScroll(page);
      await choice.getByText(TERMS_CHOICE_TEXTS.checked, { exact: true }).click();
      await expect(note).toHaveCount(0);
    });
  }

  // Issue #125: a title that wraps grows its row; no row's text is drawn over the next row, and the whole title shows.
  for (const [width, height] of [[1280, 800], [640, 400], [390, 844]] as const) {
    test(`(L33) a tab's list at ${width} × ${height}: a wrapping title grows its row, no row drawn over the next, the title whole`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto(URL);
      await expect(page.getByText("connected", { exact: true })).toBeVisible();
      await toTheList(page, modeOf("tabs"));
      await expect(listOf(page).locator("ul > li", { hasText: LONG_ITEM_TITLE })).toBeVisible();
      const problems = await listOf(page).evaluate((section, title) => {
        const out: string[] = [];
        const TOLERANCE = 0.5;
        const rows = [...section.querySelectorAll("ul > li")];
        rows.forEach((row, i) => {
          const r = row.getBoundingClientRect();
          const name = row.textContent?.trim().slice(0, 30) ?? "?";
          const next = rows[i + 1];
          if (next !== undefined && r.bottom > next.getBoundingClientRect().top + TOLERANCE) out.push(`${name}: its bottom ${r.bottom} is below the next row's top ${next.getBoundingClientRect().top}`);
          for (const el of row.querySelectorAll("p, a, span, [data-headline], [data-supporting]")) {
            const b = el.getBoundingClientRect();
            if (b.width === 0 && b.height === 0) continue;
            if (b.top < r.top - TOLERANCE || b.bottom > r.bottom + TOLERANCE || b.left < r.left - TOLERANCE || b.right > r.right + TOLERANCE) out.push(`${name}: a text (${el.textContent?.trim().slice(0, 30)}) at ${b.top}–${b.bottom} lies outside its row at ${r.top}–${r.bottom}`);
          }
        });
        const long = rows.find((row) => row.textContent?.includes(title));
        if (long === undefined) return [...out, "no row holds the long title"];
        const headline = long.querySelector("[data-headline]") ?? long.querySelector(".headline");
        const supporting = long.querySelector("[data-supporting]") ?? long.querySelector(".supporting");
        if (headline === null || supporting === null) return [...out, "the long row has no headline or no supporting text"];
        if (!(headline.textContent ?? "").includes(title)) out.push("the headline does not hold the whole title");
        const lineHeight = parseFloat(getComputedStyle(headline).lineHeight);
        if (!(headline.getBoundingClientRect().height > 1.5 * lineHeight)) out.push(`the headline did not wrap: ${headline.getBoundingClientRect().height} px at a line height of ${lineHeight} px`);
        for (const el of [headline, supporting]) if (el.scrollHeight > el.clientHeight + TOLERANCE || el.scrollWidth > el.clientWidth + TOLERANCE) out.push(`${el === headline ? "the headline" : "the supporting text"} is clipped: ${el.scrollWidth} × ${el.scrollHeight} in ${el.clientWidth} × ${el.clientHeight}`);
        if (section.scrollWidth > section.clientWidth + TOLERANCE) out.push(`the list overflows sideways: ${section.scrollWidth} > ${section.clientWidth}`);
        return out;
      }, LONG_ITEM_TITLE);
      expect(problems).toEqual([]);
    });
  }
});

test.describe("the tests of the long server, in order", () => {
  test.describe.configure({ mode: "default" });

  test("(L4) the right panel's reading position survives a switch of columns and a resize across 840 px", async ({ page }) => {
    await longRunAtItsPrompt(page);
    await showPanel(page, RIGHT);
    await toTop(list(page, RIGHT));
    await showPanel(page, LEFT);
    await showPanel(page, RIGHT);
    expect(await list(page, RIGHT).evaluate((el) => el.scrollTop), "after a switch").toBe(0);
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await list(page, RIGHT).evaluate((el) => el.scrollTop), "after a resize").toBe(0);
  });

  test("(L5) a hidden panel opens at its end, and follows the messages that arrived while it was hidden", async ({ page }) => {
    await longRunAtItsPrompt(page);
    await showPanel(page, RIGHT);
    await expect.poll(() => fromEnd(list(page, RIGHT)), { message: "hidden from the start" }).toBeLessThan(32);
    await showPanel(page, LEFT);
    await answerContinue(page);
    await expect(page.getByRole("button", { name: new RegExp(`^${RIGHT}.*new`) })).toBeVisible();
    await showPanel(page, RIGHT);
    await expect.poll(() => fromEnd(list(page, RIGHT)), { message: "following after the reveal" }).toBeLessThan(32);
  });

  test("(L6) a panel scrolled up keeps its position while hidden, and its chip counts what arrived", async ({ page }) => {
    await longRunAtItsPrompt(page);
    await showPanel(page, RIGHT);
    await expect.poll(() => fromEnd(list(page, RIGHT))).toBeLessThan(32);
    await toTop(list(page, RIGHT));
    await showPanel(page, LEFT);
    await answerContinue(page);
    await expect(page.getByRole("button", { name: new RegExp(`^${RIGHT}.*new`) })).toBeVisible();
    await showPanel(page, RIGHT);
    expect(await list(page, RIGHT).evaluate((el) => el.scrollTop)).toBe(0);
    await expect(panel(page, RIGHT).getByRole("button", { name: /new message/ })).toBeVisible();
  });
});

test.describe("the tests of the longChoices server, in order", () => {
  test.describe.configure({ mode: "default" });

  for (const [width, height] of [
    [390, 844],
    [1280, 800],
  ] as const) {
    test(`(L9) paragraph-length answers at ${width} × ${height}: each is a card that holds its text, chosen by keyboard`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await startTask(page, LONG_CHOICES_URL);
      await expect(page.getByRole("button", { name: END_CLARIFICATION })).toBeVisible();
      // Issue #21: a narrow window's progress line names the step and its count.
      if (width < 840) await expect(page.locator("details.progress summary")).toHaveText(progressLine(stepOfPhase("Gather Requirements", stepLabel("clarification")), clarificationProgress(0, 1)));
      const group = page.getByRole("group", { name: "Proposed answers" });
      await expect(group.getByRole("button")).toHaveCount(3);
      const cards = group.getByRole("button");
      const prompt = await box(pane(page));
      for (let i = 0; i < 3; i++) {
        const card = cards.nth(i);
        // S8, S18: each card shows the answer that chooses it and the agreed answer, the default marked.
        const [label, ...rest] = LONG_ANSWERS[i].replace(/^\d+\. /, "").split(": ");
        const description = rest.join(": ");
        // S14 (issue #59): the label on its own line, the description below it, as separate elements.
        await expect(card).toHaveText(`${i + 1}. ${label}${description === "" && i > 0 ? "" : ` ${description}${i === 0 ? " (the default)" : ""}`}`.replace(/ {2}\(the default\)/, " (the default)"));
        await expect(card.locator(".option-label strong")).toHaveText(label);
        const fits = await card.evaluate((el) => ({ height: el.scrollHeight <= el.clientHeight, width: el.scrollWidth <= el.clientWidth }));
        expect(fits, `answer ${i + 1} fits its card`).toEqual({ height: true, width: true });
        const b = await box(card);
        expect(b.x, `answer ${i + 1} starts inside the pane`).toBeGreaterThanOrEqual(prompt.x);
        expect(b.x + b.width, `answer ${i + 1} ends inside the pane`).toBeLessThanOrEqual(prompt.x + prompt.width + 0.5);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page overflows horizontally").toBe(true);
      // Issue #137 (11 Oct 2026, superseding S27): the pane scrolls as one region, so the message field, Send and Finish
      // clarification are reached by scrolling it; the question at its top may leave the window meanwhile.
      for (const name of ["[name=answer]", "button[name=send]", `button:has-text('${END_CLARIFICATION}')`]) {
        await page.locator(name).scrollIntoViewIfNeeded();
        await expect(page.locator(name)).toBeInViewport();
      }
      await cards.nth(1).focus();
      await page.keyboard.press("Enter");
      // Issue #184: the answer goes to Claude Code in the background and the agreed list is then done. Issue #138:
      // Claude Code's summary is written to requirements.md with no prompt, and the refinement run ends after its
      // requirements review. The reply "Anything else?" acknowledges the answer and asks nothing (requirements, "What
      // Claude Code is told"), so it is no longer a prompt; issue #22: it was Claude Code's latest message on the
      // dashboard, and the proposed summary has replaced it there.
      await toHaveEnded(page, "Completed");
      await expect(dashboard(page).locator("[data-claude]")).toContainText("Relative time.");
      await expect(dashboard(page).locator("[data-last-answer] [data-your-answer]")).toContainText("Relative time");
      await expect(pane(page).getByText("Anything else?")).toHaveCount(0);
    });
  }

  // Issue #137 (the developer's instruction of 11 Oct 2026, superseding S27): the heading is the question; every option
  // is in view without a scrolled box, side by side where there is room; the context and the reason are collapsed and
  // each expands. 640 × 400 is below the 450 px limit (IN_VIEW_MIN_HEIGHT), so there the first card may be reached by
  // scrolling, as belowTheLimit checks.
  for (const [width, height, sideBySide] of [[1280, 800, true], [640, 400, true], [390, 844, false]] as const) {
    test(`(L32) the question first at ${width} × ${height}: the heading is the question, the options in view, the rest collapsed`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await startTask(page, LONG_CHOICES_URL);
      const heading = pane(page).locator("h2");
      await expect(heading).toHaveText(/^Question 1\s+How should a message show its time\?$/);
      // W1-R1-2 of work review 1, and requirements.md's open point: the origin line stays below the heading in M3's
      // body-small style (12/16), smaller than the heading's title-medium.
      const typeOf = (l: Locator) => l.evaluate((e) => { const s = getComputedStyle(e); return { size: s.fontSize, line: s.lineHeight }; });
      const [origin, title] = [await typeOf(pane(page).locator(".origin")), await typeOf(heading)];
      expect(origin.size).toBe("12px");
      expect(parseFloat(origin.size)).toBeLessThan(parseFloat(title.size));
      expect(origin.line).toBe("16px");
      const group = pane(page).getByRole("group", { name: "Proposed answers" });
      const cards = group.getByRole("button");
      await expect(cards).toHaveCount(3);
      const unbounded = await group.evaluate((el) => {
        const boxes: string[] = [];
        const paneEl = el.closest("section.pane");
        for (let e: Element | null = el; e !== null && e !== paneEl; e = e.parentElement) if (getComputedStyle(e).maxHeight !== "none") boxes.push(e.className);
        return { fits: el.scrollHeight <= el.clientHeight + 1, boxes };
      });
      expect(unbounded.fits, "the options' group scrolls").toBe(true);
      expect(unbounded.boxes, "a box between the options and the pane caps its height").toEqual([]);
      if (height >= IN_VIEW_MIN_HEIGHT) {
        await expect(heading).toBeInViewport();
        await expect(cards.first()).toBeInViewport();
      } else await belowTheLimit(page, heading);
      for (let k = 0; k < 3; k++) {
        await cards.nth(k).scrollIntoViewIfNeeded();
        await expect(cards.nth(k), `card ${k + 1} wholly in the window`).toBeInViewport({ ratio: 1 });
      }
      const tops = await cards.evaluateAll((cs) => cs.map((c) => Math.round(c.getBoundingClientRect().top)));
      if (sideBySide) expect(tops[0], "the first two cards share a row").toBe(tops[1]);
      else expect(new Set(tops).size, "one card per row").toBe(3);
      await expect(await expandSection(page, CONTEXT_HEADING)).toContainText("c");
      await expect(await expandSection(page, attachedHeading("reason"))).toContainText("r");
      await page.locator("button[name=stop]").click();
      await confirmEnd(page);
    });
  }
});

test.describe("the tests of the decide server, in order", () => {
  test.describe.configure({ mode: "default" });

  // Issue #133 (the developer's instruction of 11 Oct 2026): the question, its choices side by side, the columns, then
  // the closed headings, at the three sizes the task names; the developer's decision of 12 Oct 2026: every part is
  // reached by scrolling the run, which does not scroll at 1280 × 800 alone. L10 once asserted the columns alone side by side.
  for (const [width, height] of [[1280, 800], [640, 400], [390, 844]] as const) {
    test(`(L10) the decision page at ${width} × ${height}: the question, both choices in view side by side, the columns at their floor or more, the headings closed, nothing clipped`, async ({ page }) => {
      const analysis = await openAnalysis(page, width, height);
      const roomy = width === 1280;
      await theOrder(page, analysis, { question: FIRST, oneRow: width >= 640, roomy });
      await opensInTurn(page, analysis, [CONTEXT_HEADING, RECOMMENDATION_HEADING], roomy);
      if (width === 1280) {
        const [a, b] = [await box(analysis.locator(".column").nth(0)), await box(analysis.locator(".column").nth(1))];
        expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1);
        expect(b.x).toBeGreaterThanOrEqual(a.x + a.width);
        expect(a.width).toBeGreaterThanOrEqual(320);
        await expect(analysis.getByText("Scroll sideways to see every option.")).toBeHidden();
      }
      await answerDismisses(page, analysis);
    });
  }

  // Issue #204 (review P1-R1-1): beside the conversation the button back to the analysis stays in the first row, above
  // both panels, and the panels' separator stands in the conversation's row; the grid keeps two rows.
  test("(L38a) the paused layout at 1280 × 800: the button above the panels, the panels' separator beside the conversation", async ({ page }) => {
    const analysis = await openAnalysis(page);
    await page.locator(".decision button[name=conversation]").click();
    await expect(analysis).toBeHidden();
    const back = page.locator("button[name=analysis]");
    await expect(back).toBeVisible();
    const b = await box(back);
    for (const sel of [".run > .left", ".run > .right"]) expect((await box(page.locator(sel))).y, `${sel} starts above the button's bottom`).toBeGreaterThanOrEqual(b.y + b.height - 1);
    expect((await box(panelsSeparator(page))).y).toBeGreaterThanOrEqual(b.y + b.height - 1);
    const rows = await page.locator("main.run").evaluate((el) => getComputedStyle(el).gridTemplateRows.trim().split(/\s+/).length);
    expect(rows).toBe(2);
    await back.click();
    await expect(analysis).toBeVisible();
    await answerDismisses(page, analysis);
  });

  // Issue #204: the decision page's promise at the widest rail: the columns at their floor or more and the tallest
  // region, the run not scrolled.
  test("(L40) the decision page at 1280 × 800 with the widest rail", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await startTask(page, DECIDE_URL);
    await widestBounds(page);
    await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
    const analysis = analysisOf(page);
    await expect(analysis).toBeVisible();
    await expect(panelsSeparator(page)).toHaveCount(0);
    await theOrder(page, analysis, { question: FIRST, oneRow: true, roomy: true });
    await expect(railSeparator(page)).toHaveAttribute("aria-valuenow", (await railSeparator(page).getAttribute("aria-valuemax")) ?? "");
    await answerDismisses(page, analysis);
  });

  // Issue #133 and W1-R1-1, replacing issue #79's allotment of the context (L24, L24a) and the yielding of the task of
  // L21 (L27): the opened context or recommendation scrolls inside itself and the columns keep their floor. Where the
  // window has room the text takes at most half and the run does not scroll; at 1280 × 400 the columns get the floor
  // and the run scrolls (the developer's decision of 12 Oct 2026).
  for (const [id, width, height, heading] of [["L24", 1280, 800, CONTEXT_HEADING], ["L24a", 1280, 1100, CONTEXT_HEADING], ["L27", 1280, 400, RECOMMENDATION_HEADING]] as const) {
    test(`(${id}) the opened ${heading} at ${width} × ${height} beside the columns`, async ({ page }) => {
      const analysis = await openAnalysis(page, width, height);
      await openedText(page, analysis, heading, height >= 800);
      await answerDismisses(page, analysis);
    });
  }

  // The task: an equivalence symbol is a link to the entry it names, which the reader reaches and which says what it is.
  test("(L10a) an equivalence symbol at 1280 × 800 moves the focus to the entry it names, in view", async ({ page }) => {
    const analysis = await openAnalysis(page);
    await analysis.getByRole("button", { name: /^Show the reasoning of Advantage 1:/ }).click();
    const link = analysis.locator(".argument a.equivalence").first();
    await expect(link).toBeVisible();
    const target = page.locator(`[id="${(await link.getAttribute("href"))!.slice(1)}"]`);
    await link.click();
    await expect(target).toBeFocused();
    await expect(target).toBeInViewport();
    await answerDismisses(page, analysis);
  });

  test("(L11) the analysis at 390 × 844: one column in view, the other reached by scrolling sideways, no page overflow", async ({ page }) => {
    const analysis = await openAnalysis(page, 390, 844);
    await expect(analysis.getByText("Scroll sideways to see every option.")).toBeVisible();
    const first = await box(analysis.locator(".column").nth(0));
    expect(first.width).toBeGreaterThanOrEqual(320);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page overflows horizontally").toBe(true);
    const second = analysis.locator(".column").nth(1);
    await second.scrollIntoViewIfNeeded();
    const shown = await box(second);
    expect(shown.x).toBeGreaterThanOrEqual(0);
    expect(shown.x + shown.width).toBeLessThanOrEqual(390 + 1);
    await answerDismisses(page, analysis);
  });

  // Issue #133 and the developer's decision of 12 Oct 2026: below 390 px the heading and the choices are in view at the
  // top; the notice and the headings are reached by scrolling, and nothing is clipped.
  test("(L12) the analysis at 360 × 640: a message asks for a wider window; the question and the choices in view, the rest reached by scrolling", async ({ page }) => {
    const analysis = await openAnalysis(page, 360, 640);
    await expect(analysis.getByRole("alert")).toHaveText(/at least 390 pixels wide/);
    await expect(analysis.locator(".column")).toHaveCount(0);
    await settled(page);
    await runNotScrolled(page);
    await inWindow(page, analysis.locator("h2"), "the question");
    for (const card of await cards(page).all()) await inWindow(page, card, "a card");
    await unclipped(page, analysis.getByRole("alert"), "the notice");
    const parts = everyPart(analysis);
    for (let i = 0; i < (await parts.count()); i++) await unclipped(page, parts.nth(i), `part ${i}`);
    await answerDismisses(page, analysis);
  });

  // Issue #133 and W1-R1-1: below 390 px an opened text takes up to the larger of the room and the floor
  // (allotWithFloor's "Alone"), is reached by scrolling, and scrolls inside itself.
  test("(L12a) a long context at 360 × 800: the opened Technical Context is reached by scrolling and scrolls inside itself; the question and the choices are in view at the top", async ({ page }) => {
    const analysis = await openAnalysis(page, 360, 800);
    const { overflows } = await openedText(page, analysis, CONTEXT_HEADING, false);
    expect(overflows, "the context does not scroll inside itself").toBe(true);
    await toRunTop(page);
    await settled(page);
    await inWindow(page, analysis.locator("h2"), "the question");
    for (const card of await cards(page).all()) await inWindow(page, card, "a card");
    await answerDismisses(page, analysis);
  });
});

test.describe("the tests of the decideLong server, in order", () => {
  test.describe.configure({ mode: "default" });

  // Issue #133: a question with a history shows its History heading; each heading opens in turn, one at a time.
  for (const [width, height] of [[1280, 800], [640, 400], [390, 844]] as const) {
    test(`(L15) the long decision page at ${width} × ${height}: the order, and Technical Context, History and Recommendation opened in turn`, async ({ page }) => {
      const analysis = await openLongAnalysis(page, width, height);
      const roomy = width === 1280;
      await expect(sectionButtons(analysis)).toHaveText([CONTEXT_HEADING, QUESTION_HISTORY_HEADING, RECOMMENDATION_HEADING]);
      await theOrder(page, analysis, { question: FIRST, oneRow: width >= 640, roomy });
      await opensInTurn(page, analysis, [CONTEXT_HEADING, QUESTION_HISTORY_HEADING, RECOMMENDATION_HEADING], roomy);
      await answerDismisses(page, analysis);
    });
  }

  // The task: the opened text in two or three columns at 1280 and 640 px wide, and one below the compact breakpoint.
  for (const [width, height, expected] of [[1280, 800, [2, 3]], [640, 400, [2, 3]], [390, 844, [1, 1]]] as const) {
    test(`(L15a) the opened Technical Context at ${width} × ${height} is set in ${expected[0] === expected[1] ? "one column" : "two or three columns"}`, async ({ page }) => {
      const analysis = await openLongAnalysis(page, width, height);
      const button = sectionButton(analysis, CONTEXT_HEADING);
      await button.click();
      await settled(page);
      const lefts = await (await bodyOf(page, button)).evaluate((el) => new Set([...el.querySelectorAll(".text-columns p")].map((p) => Math.round(p.getBoundingClientRect().left))).size);
      expect(lefts).toBeGreaterThanOrEqual(expected[0]);
      expect(lefts).toBeLessThanOrEqual(expected[1]);
      await answerDismisses(page, analysis);
    });
  }

  // Issue #133 and W1-R1-1, replacing issue #81's recommendation region (L13, L14), the yielding of the task of L21
  // (L27a) and S39's context region (L20): the opened text scrolls to its end inside itself and the columns keep their
  // floor; at 1280 × 800 it takes at most half and the run does not scroll, elsewhere the run scrolls to it (the
  // developer's decision of 12 Oct 2026).
  for (const [id, width, height, heading] of [["L13", 1280, 800, RECOMMENDATION_HEADING], ["L14", 390, 844, RECOMMENDATION_HEADING], ["L27a", 1280, 400, CONTEXT_HEADING], ["L20", 390, 844, CONTEXT_HEADING], ["L20", 640, 400, CONTEXT_HEADING]] as const) {
    test(`(${id}) the opened ${heading} of the long analysis at ${width} × ${height}: the columns keep their floor, its end reached inside it`, async ({ page }) => {
      const analysis = await openLongAnalysis(page, width, height);
      const { body, overflows } = await openedText(page, analysis, heading, width === 1280 && height >= 800);
      expect(overflows, "the long text does not scroll inside itself").toBe(true);
      await body.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
      const last = heading === RECOMMENDATION_HEADING ? body.getByText("The last paragraph of the recommendation.") : body.locator("p").last();
      const [end, region] = [await box(last), await box(body)];
      expect(end.y + end.height).toBeLessThanOrEqual(region.y + region.height + 1);
      await answerDismisses(page, analysis);
    });
  }

  // W4-R1-1 kept; issue #133 and the developer's decision of 12 Oct 2026: with the progress opened in a short compact
  // window the run scrolls, and the question, both choices and every part below them are reached, none clipped.
  test("(L16) a long analysis at 390 × 600 with the progress opened: the question, both choices and every part reached by scrolling, none clipped", async ({ page }) => {
    const analysis = await openLongAnalysis(page, 390, 600);
    await page.locator("details.progress > summary, details.progress summary").first().click();
    await expect(page.locator("details.progress")).toHaveAttribute("open", "");
    await settled(page);
    await unclipped(page, analysis.locator("h2"), "the question");
    for (const card of await cards(page).all()) await unclipped(page, card, "a card");
    const parts = everyPart(analysis);
    for (let i = 0; i < (await parts.count()); i++) await unclipped(page, parts.nth(i), `part ${i}`);
    await answerDismisses(page, analysis);
  });

  // Issue #81 (the developer's instruction of 1 Oct 2026): each column scrolls on its own inside the region that scrolls
  // sideways; issue #133: opening entries, here or in another tab, moves neither the answers nor the row of headings.
  test("(L26) each column scrolls on its own; the answers and the headings keep their places whatever is open", async ({ context, page }) => {
    const analysis = await openLongAnalysis(page, 1280, 800);
    const places = () => Promise.all([analysis.locator(".answers"), analysis.locator(".sections")].map(async (l) => { const b = await box(l); return [Math.round(b.y), Math.round(b.height)]; }));
    const closed = await places();
    await analysis.getByRole("button", { name: /^Show the reasoning of Advantage 1:/ }).click();
    expect(await places(), "opening an entry moved the answers or the headings").toEqual(closed);
    const columns = analysis.locator(".column");
    const [long, short] = [columns.nth(0), columns.nth(1)];
    await expect.poll(() => long.evaluate((el) => el.scrollHeight > el.clientHeight + 1), { message: "the long column does not scroll on its own" }).toBe(true);
    const [l, w] = [await box(long), await box(analysis.locator(".sideways"))];
    expect(l.y).toBeGreaterThanOrEqual(w.y - 1);
    expect(l.y + l.height).toBeLessThanOrEqual(w.y + w.height + 1);
    const before = { top: await short.evaluate((el) => el.scrollTop), box: await box(short) };
    await long.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect.poll(() => long.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await short.evaluate((el) => el.scrollTop), "the other column scrolled").toBe(before.top);
    expect(await box(short)).toEqual(before.box);
    // W2-R1-2: the sticky option heading has the column's opaque surface color, so the scrolled arguments stay behind it.
    const colors = await long.evaluate((el) => ({ heading: getComputedStyle(el.querySelector("h3")!).backgroundColor, column: getComputedStyle(el).backgroundColor }));
    expect(colors.heading, "the sticky heading is transparent").not.toBe("rgba(0, 0, 0, 0)");
    expect(colors.heading, "the sticky heading's color differs from the column's").toBe(colors.column);
    const other = await context.newPage();
    await other.setViewportSize({ width: 1280, height: 800 });
    await other.goto(layoutUrl("decideLong"));
    await expect(analysisOf(other)).toBeVisible();
    await page.reload();
    await expect(analysis.getByRole("button", { name: /^Hide the reasoning of Advantage 1:/ })).toBeVisible();
    await expect.poll(places, { message: "an entry open from another tab moved the answers or the headings" }).toEqual(closed);
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(places, { message: "a resize with an entry open moved the answers or the headings" }).toEqual(closed);
    await other.close();
    await answerDismisses(page, analysis);
  });
});

// Decision G-R1-2 (issue #133): an agreed question's analysis carries its reason under "Why You're Being Asked This",
// and no heading of a permission's request.
test.describe("the tests of the decideBlank server, in order", () => {
  test.describe.configure({ mode: "default" });
  test("(L10b) an agreed question's analysis at 1280 × 800 shows its reason's heading and not a request's", async ({ page }) => {
    const analysis = await openAnalysisAt(page, layoutUrl("decideBlank"), 1280, 800);
    await expect(sectionButton(analysis, attachedHeading("reason"))).toHaveCount(1);
    await expect(sectionButton(analysis, attachedHeading("request"))).toHaveCount(0);
    await expect(page.getByRole("button", { name: HELP_ME_DECIDE })).toHaveCount(0);
  });
});

test.describe("the tests of the planSteps server, in order", () => {
  test.describe.configure({ mode: "default" });

  // Issue #6: a step's long text scrolls inside its tooltip, which stays in the viewport, in a desktop window and, with the
  // progress opened, in a phone-sized one.
  for (const [width, height] of [[1280, 800], [390, 844]] as const) {
    test(`(L17) a long step text at ${width} × ${height}: the tooltip stays in the viewport and scrolls inside itself`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await startTask(page, layoutUrl("planSteps"));
      if (width < 840) {
        await page.locator("details.progress > summary, details.progress summary").first().click();
        await expect(page.locator("details.progress")).toHaveAttribute("open", "");
      }
      // Issue #63: the stage that holds the step is collapsed until it is opened.
      await page.getByRole("navigation", { name: "Progress of the run" }).getByRole("button", { name: railToggleName(stageHeading(2, "the page"), RAIL_CONDITION_LABEL.notStarted, null, null), exact: true }).click();
      const button = page.locator("[data-plan-step] button", { hasText: "The long step" });
      await expect(button).toBeVisible();
      await button.focus();
      const tip = page.getByRole("tooltip");
      await expect(tip).toBeVisible();
      const b = await box(tip);
      expect(b.x, "the tooltip's left edge").toBeGreaterThanOrEqual(0);
      expect(b.y, "the tooltip's top edge").toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, "the tooltip's right edge").toBeLessThanOrEqual(width);
      expect(b.y + b.height, "the tooltip's bottom edge").toBeLessThanOrEqual(height);
      const scroll = await tip.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: el.scrollTop };
      });
      expect(scroll.scrollHeight, "the text is longer than the tooltip").toBeGreaterThan(scroll.clientHeight);
      expect(scroll.scrollTop, "the tooltip scrolls").toBeGreaterThan(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page overflows horizontally").toBe(true);
    });
  }

  // W1-R1-1: with the mouse alone, a long step text can be read: the tooltip stays open while the pointer moves into it.
  test("(L18) a long step text at 1280 × 800: hovered, the tooltip stays open while the pointer moves into it and scrolls with the wheel", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await startTask(page, layoutUrl("planSteps"));
    // Issue #63: the stage that holds the step is collapsed until it is opened.
    await page.getByRole("navigation", { name: "Progress of the run" }).getByRole("button", { name: railToggleName(stageHeading(2, "the page"), RAIL_CONDITION_LABEL.notStarted, null, null), exact: true }).click();
    const button = page.locator("[data-plan-step] button", { hasText: "The long step" });
    await expect(button).toBeVisible();
    // The pointer may rest where the confirmation of an earlier run's stop was clicked (S25), over another step.
    await page.mouse.move(0, 0);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await button.hover();
    const tip = page.getByRole("tooltip", { name: /^Line 1 of the step's text/ });
    await expect(tip).toBeVisible();
    const b = await box(tip);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 });
    await page.mouse.wheel(0, 200);
    await expect(tip).toBeVisible();
    await expect.poll(() => tip.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });

  // Issue #109: a step's tooltip is drawn opaque whatever the state of its step. CSS opacity below 1 on any ancestor dims
  // the whole subtree as one group, so the tooltip's effective opacity is the product over it and its ancestors.
  test("(L30) at 1280 × 800: the tooltip of a done step and of the current step are drawn at full opacity", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await startTask(page, layoutUrl("planSteps"));
    const nav = page.getByRole("navigation", { name: "Progress of the run" });
    const entry = (label: string) => nav.locator("[data-state]", { has: page.locator("[data-label]", { hasText: new RegExp(`^${label}$`) }) });
    const cases = [
      ["done", entry("Implementation 1"), "Structured user questions (Q1)"],
      ["current", entry("Implementation 2"), "The store"],
    ] as const;
    for (const [state, within, label] of cases) {
      const step = within.locator(`[data-plan-step=${state}]`, { hasText: label });
      await expect(step).toBeVisible();
      await step.locator("button").focus();
      const tip = page.getByRole("tooltip");
      await expect(tip).toBeVisible();
      const effective = await tip.evaluate((el) => {
        let product = 1;
        for (let e: Element | null = el; e !== null; e = e.parentElement) product *= Number(getComputedStyle(e).opacity);
        return product;
      });
      expect(effective, `the effective opacity of a ${state} step's tooltip`).toBe(1);
      await page.keyboard.press("Escape");
      await expect(tip).toHaveCount(0);
    }
  });
  // Issue #116: a stage's steps are drawn one level deeper than the stage, and every row of the rail, a long step label
  // wrapped included, stays inside the rail's column, at every width (the rail is in the progress panel below 840 px).
  for (const [width, height] of [[1280, 800], [640, 400], [390, 844]] as const) {
    test(`(L31) the rail at ${width} × ${height}: a step deeper than its stage, a stage than its phase, every row inside the column, a long label unclipped`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await startTask(page, layoutUrl("planSteps"));
      if (width < 840) {
        await page.locator("details.progress > summary, details.progress summary").first().click();
        await expect(page.locator("details.progress")).toHaveAttribute("open", "");
      }
      const nav = page.getByRole("navigation", { name: "Progress of the run" });
      await nav.getByRole("button", { name: railToggleName(stageHeading(2, "the page"), RAIL_CONDITION_LABEL.notStarted, null, null), exact: true }).click();
      await expect(nav.locator("[data-plan-step]", { hasText: "The long step" })).toBeVisible();
      await expect(nav.locator("[data-plan-step]", { hasText: LONG_STEP_LABEL }).first()).toBeVisible();
      const problems = await railProblems(nav);
      expect(problems).toEqual([]);
    });
  }

  // Issue #204: the rail's column widened and narrowed by mouse and keyboard, the boundary between the panels moved, the
  // widths remembered across a reload and shown clamped, never rewritten, when the window narrows and widens again.
  test("(L38) the column widths at 1280 × 800: both separators dragged and moved by keys, the rail's rows and the chain inside the column, the widths remembered", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await startTask(page, layoutUrl("planSteps"));
    const nav = page.getByRole("navigation", { name: "Progress of the run" });
    await nav.getByRole("button", { name: railToggleName(stageHeading(2, "the page"), RAIL_CONDITION_LABEL.notStarted, null, null), exact: true }).click();
    const rail = railSeparator(page);
    const split = panelsSeparator(page);
    const column = page.locator("div.rail-column");
    const root = await rootPx(page);
    await expect(rail).toHaveAttribute("role", "separator");
    await expect(rail).toHaveAttribute("aria-label", RAIL_WIDTH_LABEL);
    await expect(split).toHaveAttribute("aria-label", PANEL_SPLIT_LABEL);
    await expect(rail).toHaveAttribute("aria-valuenow", "14");
    const width0 = (await box(column)).width;
    expect(Math.abs(width0 - 14 * root)).toBeLessThanOrEqual(1);
    await chainInside(page);

    // The mouse: dragged 6rem to the right.
    await dragBy(page, rail, 6 * root);
    await expect(rail).toHaveAttribute("aria-valuenow", "20");
    expect(Math.abs((await box(column)).width - (width0 + 6 * root))).toBeLessThanOrEqual(1);

    // The keyboard.
    await rail.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(rail).toHaveAttribute("aria-valuenow", "22");
    await page.keyboard.press("End");
    expect(await rail.getAttribute("aria-valuemax")).toBe("28");
    await expect(rail).toHaveAttribute("aria-valuenow", "28");
    await page.keyboard.press("ArrowLeft");
    await expect(rail).toHaveAttribute("aria-valuenow", "27");
    await page.keyboard.press("End");
    await expect(rail).toHaveAttribute("aria-valuenow", "28");
    await settled(page);

    // At the widest rail: the rows and the chain inside the column, both panels at least 20rem, nothing sideways.
    expect(await railProblems(nav)).toEqual([]);
    await chainInside(page);
    for (const sel of [".run > .left", ".run > .right"]) expect((await box(page.locator(sel))).width, `${sel} is narrower than 20rem`).toBeGreaterThanOrEqual(20 * root - 1);
    await noSidewaysScroll(page);

    // The split.
    await split.focus();
    await page.keyboard.press("Home");
    const low = Number(await split.getAttribute("aria-valuemin"));
    await expect(split).toHaveAttribute("aria-valuenow", String(low));
    expect((await box(page.locator(".run > .left"))).width).toBeGreaterThanOrEqual(20 * root - 1);
    const panels = (await box(page.locator(".run > .left"))).width + (await box(page.locator(".run > .right"))).width;
    await dragBy(page, split, 0.1 * panels);
    const high = Number(await split.getAttribute("aria-valuemax"));
    await expect(split).toHaveAttribute("aria-valuenow", String(Math.min(low + 10, high)));
    const left = await valueOf(split);

    // Remembered across a reload.
    await page.reload();
    await expect(rail).toHaveAttribute("aria-valuenow", "28");
    await expect(split).toHaveAttribute("aria-valuenow", String(left));

    // Narrower: shown clamped; below 840 px no separator; wide again: the stored widths, never rewritten.
    await page.setViewportSize({ width: 1000, height: 800 });
    await settled(page);
    const narrowMax = Number(await rail.getAttribute("aria-valuemax"));
    expect(narrowMax).toBeLessThan(28);
    await expect(rail).toHaveAttribute("aria-valuenow", String(narrowMax));
    if ((await valueOf(split)) !== 50) for (const sel of [".run > .left", ".run > .right"]) expect((await box(page.locator(sel))).width).toBeGreaterThanOrEqual(20 * root - 1);
    expect(await railProblems(nav)).toEqual([]);
    await noSidewaysScroll(page);
    await page.setViewportSize({ width: 800, height: 800 });
    await expect(page.locator("[data-column-resize]")).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(rail).toHaveAttribute("aria-valuenow", "28");
    await expect(split).toHaveAttribute("aria-valuenow", String(left));
  });

  // Issue #203: m3-svelte's outlined fields held a 15rem minimum inside the 14rem rail and drew over the dashboard. At
  // every width where the rail is a column, during a run, every part of the chain's control lies inside the column, the
  // runs field with a limit of 10 and in its error state included.
  for (const width of [1280, 1000, 840] as const) {
    test(`(L41) the chain's control at ${width} × 800: every part inside the rail's column`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const item = await startTask(page, layoutUrl("planSteps"));
      await expect(railSeparator(page)).toHaveAttribute("aria-valuenow", "14");
      await expect(page.locator("div.rail-column .chain")).toBeVisible();
      const runs = page.locator('div.rail-column input[name="chain-runs"]');
      await runs.fill("10");
      await runs.press("Enter");
      await settled(page);
      await chainInside(page);
      await runs.fill("x");
      await runs.press("Enter");
      await expect(page.locator("div.rail-column .chain").getByText(CHAIN_INVALID_RUNS)).toBeVisible();
      await settled(page);
      await chainInside(page);
      // Issue #196: the choice of source and the queue's empty text lie inside the column too; the backlog restored after.
      const sources = page.locator("div.rail-column .chain").getByRole("radiogroup", { name: CHAIN_SOURCE_LABEL });
      await sources.getByText(CHAIN_SOURCE_TEXTS.queue, { exact: true }).click();
      await expect(page.locator("div.rail-column .chain").getByText(QUEUE_EMPTY)).toBeVisible();
      // m3-svelte's click ripple, a circle clipped by its own SVG's overflow, is gone before the parts are measured.
      await expect(page.locator("div.rail-column .chain .active-ripple")).toHaveCount(0);
      await settled(page);
      await chainInside(page);
      // W1-R1-2: a populated queue, its entry the long title, lies inside the column too. It is added from the
      // Implementation tab's list while the run goes on (issue #144), never through toTheList, which stops the run.
      await listTabOf(page, "implementation").click();
      const add = listOf(page).locator('button[name=queue-add][data-item="41"]');
      await expect(add).toBeVisible();
      await add.click();
      const editor = page.getByRole("region", { name: QUEUE_HEADING });
      await expect(editor.locator("li[data-queued]")).toHaveCount(1);
      await runTabOf(page, item, "implementation").click();
      const entry = page.locator("div.rail-column .chain li[data-queued]");
      await expect(entry).toHaveCount(1);
      await expect(entry).toContainText(LONG_ITEM_TITLE);
      await expect(page.locator("div.rail-column .chain").getByText(QUEUE_EMPTY)).toHaveCount(0);
      await expect(page.locator("div.rail-column .chain .active-ripple")).toHaveCount(0);
      await settled(page);
      await chainInside(page);
      // The server's chain.json is shared by the describe's later tests: the entry removed and the backlog restored.
      await listTabOf(page, "implementation").click();
      await editor.getByRole("button", { name: queueRemoveName(`#41 ${LONG_ITEM_TITLE}`) }).click();
      await expect(editor.getByText(QUEUE_EMPTY)).toBeVisible();
      await page.getByRole("region", { name: CHAIN_SWITCH_LABEL }).getByRole("radiogroup", { name: CHAIN_SOURCE_LABEL }).getByText(CHAIN_SOURCE_TEXTS.backlog, { exact: true }).click();
      await expect(editor).toHaveCount(0);
      await noSidewaysScroll(page);
    });
  }
});

test.describe("the tests of the longQuestion server, in order", () => {
  test.describe.configure({ mode: "default" });

  // The developer's decision of 9 Oct 2026: the in-view assertions hold at 450 px high and taller (IN_VIEW_MIN_HEIGHT);
  // 640 × 400 keeps what still holds below that limit.
  for (const [width, height] of [[390, 844], [640, 450], [1280, 800]] as const) {
    // Issue #137 (11 Oct 2026, superseding S27): the pane scrolls as one region, the context collapsed under the choices.
    test(`(L19) a long question at ${width} × ${height}: the question and its first option in view, the pane one scrolling region`, async ({ page }) => {
      expect(height).toBeGreaterThanOrEqual(IN_VIEW_MIN_HEIGHT);
      await page.setViewportSize({ width, height });
      await startTask(page, LONG_QUESTION_URL);
      const question = pane(page).locator(".question-text");
      await expect(question).toBeInViewport();
      const first = pane(page).getByRole("group", { name: "Proposed answers" }).getByRole("button").first();
      await expect(first).toBeInViewport({ ratio: 0.1 });
      // The dashboard is not what the user reads while the question waits (issue #20).
      await expect(panel(page, LEFT)).toBeHidden();
      await expect(pane(page).locator(".top, .bottom")).toHaveCount(0);
      expect(await pane(page).evaluate((el) => getComputedStyle(el).overflowY), "the pane is the scrolling region").toBe("auto");
      await expect(sectionToggle(page, CONTEXT_HEADING)).toHaveAttribute("aria-expanded", "false");
      await expect(await expandSection(page, CONTEXT_HEADING)).toContainText("Databases");
      for (const name of ["[name=answer]", "button[name=send]"]) {
        await page.locator(name).scrollIntoViewIfNeeded();
        await expect(page.locator(name)).toBeInViewport();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page overflows horizontally").toBe(true);
      // The pointer is left where Start was clicked; a term may lie under it now and its tooltip cover the answer.
      await page.mouse.move(0, 0);
      await continueWithoutDeciding(page).click();
      await toHaveEnded(page, "Completed");
    });
  }
  // Issue #204 (review P1-R1-2): the question page's promise with the question's panel at its narrowest, the rail widest.
  for (const [width, height] of [[1280, 800], [1280, 450]] as const) {
    test(`(L39) a long question at ${width} × ${height} with the widest rail and the narrowest question panel: the question and its first option in view`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await startTask(page, LONG_QUESTION_URL);
      await widestBounds(page);
      await expect(pane(page).locator(".question-text")).toBeInViewport();
      await expect(pane(page).getByRole("group", { name: "Proposed answers" }).getByRole("button").first()).toBeInViewport({ ratio: 0.1 });
      await runNotScrolled(page);
      await page.mouse.move(0, 0);
      await continueWithoutDeciding(page).click();
      await toHaveEnded(page, "Completed");
    });
  }
  test("(L19) a long question at 640 × 400, below the 450 px limit: no sideways overflow, the question in view, the first option reached by scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 400 });
    await startTask(page, LONG_QUESTION_URL);
    await belowTheLimit(page, pane(page).locator(".question-text"));
    await page.mouse.move(0, 0);
    await continueWithoutDeciding(page).click();
    await toHaveEnded(page, "Completed");
  });
});

test.describe("the tests of the longContextShortAnswers server, in order", () => {
  test.describe.configure({ mode: "default" });

  // Issue #79 (P2-R1-1): in a tall window the question pane's context takes the room its answers leave, instead of 30 %
  // of the pane: with short answers, the whole context is shown, and no room stays empty below the answers.
  // Issue #137 (11 Oct 2026, superseding S27): the context is a section that expands; opened, it is whole, with no scroll
  // of its own, and the pane's content fits the window.
  test("(L25) a long context with short answers at 1280 × 1700: the pane's content fits, and the context is whole", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1700 });
    await startTask(page, layoutUrl("longContextShortAnswers"));
    await expect(pane(page).locator(".question-text")).toBeInViewport();
    const context = await expandSection(page, CONTEXT_HEADING);
    const own = await context.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    expect(own.client, "the context scrolls on its own").toBeGreaterThanOrEqual(own.scroll - 1);
    const whole = await pane(page).evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    expect(whole.scroll, "the pane's content does not fit").toBeLessThanOrEqual(whole.client + 1);
    await continueWithoutDeciding(page).click();
    await toHaveEnded(page, "Completed");
  });
});

test.describe("the tests of the permissionLong server, in order", () => {
  test.describe.configure({ mode: "default" });
  // Issue #137 (11 Oct 2026, superseding S27): the command is in the collapsed section "What Claude Code Would Do"
  // under the choices; the question and the first option are checked together before it is opened.
  for (const [width, height] of [[1280, 800], [640, 400], [390, 844]] as const) {
    test(`(L21) a permission request with a 40-line command at ${width} × ${height}: the question and the first option in view`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await startTask(page, PERMISSION_URL);
      const question = pane(page).locator(".question-text");
      await expect(question).toContainText("Do you want to allow it?");
      await expect(question).not.toContainText("echo");
      const firstOption = () => page.getByRole("group", { name: "Proposed answers" }).getByRole("button").first();
      const together = async (what: string, asked: Locator) => {
        await firstOption().scrollIntoViewIfNeeded();
        for (const [name, part] of [["the question", asked], ["the first option", firstOption()]] as const) {
          const b = await box(part);
          expect(b.y, `${what}: ${name}'s top`).toBeGreaterThanOrEqual(-1);
          expect(b.y + b.height, `${what}: ${name} is below the window`).toBeLessThanOrEqual(height + 1);
        }
      };
      if (height >= IN_VIEW_MIN_HEIGHT) await together("in the question pane", question);
      else await belowTheLimit(page, question);
      // The whole command is in its section, reached by scrolling the pane once the section is opened.
      const request = await expandSection(page, attachedHeading("request"));
      await expect(request).toContainText("line 40 of a long command");
      const command = request.locator("pre").filter({ hasText: "line 40 of a long command" });
      await command.evaluate((el) => el.scrollIntoView({ block: "end" }));
      await expect(command).toBeInViewport();
      await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
      const analysis = analysisOf(page);
      await expect(analysis).toBeVisible();
      // Issue #133: beside its analysis the question is the heading and its choices are under it, in view by construction.
      await together("beside the analysis", analysis.locator("h2"));
      // Decision G-R1-2: a permission's request is under its own heading, and no agreed question's reason is.
      await expect(sectionButton(analysis, attachedHeading("request"))).toHaveCount(1);
      await expect(sectionButton(analysis, attachedHeading("reason"))).toHaveCount(0);
      await firstOption().click();
      await toHaveEnded(page, "Completed");
    });
  }
  // Issue #73: the page names Liberation, installed in Regular, Bold, Italic and Bold Italic in the developer's browser,
  // the CI runner and the development container. A declared family that is not installed falls through silently, so the
  // test reads the faces the renderer used (Chrome DevTools Protocol), not the declared font-family. Code keeps the size
  // it had under the bare monospace family, 13/16 of its parent's, so that naming a family moves none of the commands the
  // layout tests measure.
  test("(L28) the page renders in Liberation: body text, bold text and code, at the sizes it had", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await startTask(page, PERMISSION_URL);
    await expect(pane(page).locator(".question-text")).toContainText("Do you want to allow it?");
    // Issue #137: the command is in the collapsed section of the request, opened before its code is read.
    await expandSection(page, attachedHeading("request"));
    const families = (fonts: readonly UsedFont[]) => [...new Set(fonts.map((f) => f.familyName))];
    expect(families(await usedFont(page, "section.pane .question-text")), "the question's text").toEqual(["Liberation Sans"]);
    expect((await usedFont(page, "section.pane .option-label strong")).map((f) => f.postScriptName), "a bold option label").toEqual(["LiberationSans-Bold"]);
    expect(families(await usedFont(page, "section.pane .details li > code")), "inline code").toEqual(["Liberation Mono"]);
    expect(families(await usedFont(page, "section.pane .details pre > code")), "a code block").toEqual(["Liberation Mono"]);
    const sizes = await pane(page).locator(".details").evaluate((top) =>
      [...top.querySelectorAll("li > code, li > pre")].map((el) => ({ tag: el.tagName, own: parseFloat(getComputedStyle(el).fontSize), parent: parseFloat(getComputedStyle(el.parentElement!).fontSize) })),
    );
    expect(sizes.length, "the details hold code").toBeGreaterThan(0);
    for (const s of sizes) expect(Math.abs(s.own - (s.parent * 13) / 16), `${s.tag} is ${s.own} px under a parent of ${s.parent} px`).toBeLessThanOrEqual(0.5);
    await page.getByRole("group", { name: "Proposed answers" }).getByRole("button").first().click();
    await toHaveEnded(page, "Completed");
  });
  // Issue #133 (the developer's instruction of 11 Oct 2026, requirements item 1), superseding the decision of the task of
  // L21 that kept the heading on one line: the heading is "Your Choice:" and the question, and it wraps, never cut.
  for (const [width, height] of [[640, 400], [390, 844], [1280, 800]] as const) {
    test(`(L29) the analysis's heading is the question, whole, at ${width} × ${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await startTask(page, PERMISSION_URL);
      await expect(pane(page).locator(".question-text")).toContainText("Do you want to allow it?");
      await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
      const analysis = analysisOf(page);
      await expect(analysis).toBeVisible();
      const m = await analysis.locator("h2").evaluate((el) => ({ text: el.textContent?.replace(/\s+/g, " ").trim() ?? "", cut: el.scrollWidth > el.clientWidth + 1, overflow: getComputedStyle(el).textOverflow }));
      expect(m.text.startsWith(`${YOUR_CHOICE} `), m.text).toBe(true);
      expect(m.text).toContain("Do you want to allow it?");
      expect(m.cut, "the heading is cut").toBe(false);
      expect(m.overflow).not.toBe("ellipsis");
      await inWindow(page, analysis.locator("h2"), "the heading");
      await cards(page).first().click();
      await toHaveEnded(page, "Completed");
    });
  }
  // Issue #133 (decision G-R1-1): beside its analysis the question and its choices are at the top of the page, so they
  // are in view in a window 400 px high too, where the decision of 9 Oct 2026 (IN_VIEW_MIN_HEIGHT) once let the run
  // scroll to the first answer; the analysis stays within its own box, and by the developer's decision of 12 Oct 2026
  // every part below the choices is reached by scrolling the run, none clipped.
  for (const height of [450, 400] as const) test(`(L21a) a permission request at 640 × ${height} beside the analysis: the question and the first answer in view, the rest reached by scrolling`, async ({ page }) => {
    await page.setViewportSize({ width: 640, height });
    await startTask(page, PERMISSION_URL);
    await expect(pane(page).locator(".question-text")).toContainText("Do you want to allow it?");
    await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
    const analysis = analysisOf(page);
    await expect(analysis).toBeVisible();
    await settled(page);
    await inWindow(page, analysis.locator("h2"), "the question");
    await inWindow(page, cards(page).first(), "the first answer");
    await runNotScrolled(page);
    const m = await analysis.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    expect(m.scroll, "the analysis's content overflows its own box").toBeLessThanOrEqual(m.client + 1);
    const parts = everyPart(analysis);
    for (let i = 0; i < (await parts.count()); i++) await unclipped(page, parts.nth(i), `part ${i}`);
    await cards(page).first().click();
    await toHaveEnded(page, "Completed");
  });
  // Finding W2-R1-1 of work review 2: a notice that appears while the analysis is shown takes room above the decision
  // area, and the room is measured again, so the question and the first answer stay in view without a resize. The
  // server sends a refusal only to the tab whose action it refuses, so no action of another tab gives this tab a
  // notice; the test delivers the server's own `refused` frame to the page through Playwright's WebSocket routing.
  // The developer's decision of 9 Oct 2026 moved this check from 640 × 400 to 640 × 450, the lowest window in which the
  // question and its first answer stay in view without the run scrolling (IN_VIEW_MIN_HEIGHT). The notice of W2-R1-1 is
  // the page's own, which a refusal of no mode produces; a refusal of the run's mode is drawn in its tab above the run
  // (issue #120), and the second case checks the room once that line takes height.
  for (const mode of [null, modeOf("permissionLong")] as const) test(`(L21b) ${mode === null ? "a notice" : "a refusal of the run's tab"} that appears beside the analysis at 640 × 450: the question and the first answer stay in view`, async ({ page }) => {
    let toPage: ((frame: string) => void) | null = null;
    await page.routeWebSocket(/\/\/127\.0\.0\.1:\d+/, (ws) => {
      ws.connectToServer();
      toPage = (frame) => ws.send(frame);
    });
    await page.setViewportSize({ width: 640, height: IN_VIEW_MIN_HEIGHT });
    await startTask(page, PERMISSION_URL);
    await expect(pane(page).locator(".question-text")).toContainText("Do you want to allow it?");
    await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
    const analysis = analysisOf(page);
    await expect(analysis).toBeVisible();
    // Issue #133: the question and its first answer are at the top of the decision page, so a notice above it leaves them in view.
    const questionAndFirstAnswerAtTheTop = async () => {
      await settled(page);
      await inWindow(page, analysis.locator("h2"), "the question");
      await inWindow(page, cards(page).first(), "the first answer");
      await runNotScrolled(page);
    };
    await questionAndFirstAnswerAtTheTop();
    const reason = "a run is in progress; stop it or wait for its end";
    expect(toPage, "the page's WebSocket was not routed").not.toBeNull();
    toPage!(JSON.stringify({ type: "refused", mode, reason }));
    await expect(page.getByRole("alert").filter({ hasText: reason })).toBeVisible();
    // The room is measured again when the line appears (an observer of the run's children or of its size), and the
    // analysis is laid out again after it; the layout settles within a few frames, so the check is retried until then.
    await expect(async () => questionAndFirstAnswerAtTheTop()).toPass({ timeout: 5_000 });
    await page.getByRole("group", { name: "Proposed answers" }).getByRole("button").first().click();
    await toHaveEnded(page, "Completed");
  });
});

test.describe("the tests of the whitespace server, in order", () => {
  test.describe.configure({ mode: "default" });

  test("(L22) code in rendered Markdown keeps its whitespace: in the pane, beside an analysis and in the dashboard", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await startTask(page, WHITESPACE_URL);
    await expect(pane(page).locator(".question-text")).toContainText("Do you want to allow it?");
    // Issue #137: the input is in the collapsed section of the request, opened before it is measured.
    await distinctWidths("in the question pane", await expandSection(page, attachedHeading("request")));
    await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
    const analysis = analysisOf(page);
    await expect(analysis).toBeVisible();
    // Issue #133: beside the analysis the input is under its own heading, opened before it is measured.
    const request = sectionButton(analysis, attachedHeading("request"));
    await request.click();
    await distinctWidths("beside the analysis", await bodyOf(page, request));
    await page.getByRole("group", { name: "Proposed answers" }).getByRole("button").first().click();
    await toHaveEnded(page, "Completed");
    // Issue #22: the answered question is the dashboard's last answer, its input shown inline (AnsweredQuestion).
    await distinctWidths("in the dashboard", dashboard(page).locator("[data-last-answer]"));
  });
});

test.describe("the tests of the transportLong server, in order", () => {
  test.describe.configure({ mode: "default" });

  // Issue #137 (11 Oct 2026, superseding S27): the fault is in the collapsed section "Why the Agent Could Not Be
  // Reached" under the choices; the question and the first option are checked together before it is opened.
  for (const [width, height] of [[1280, 800], [640, 400], [390, 844]] as const) {
    test(`(L23) the exhaustion pause after a long fault at ${width} × ${height}: the question and the first option in view`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await startTask(page, TRANSPORT_LONG_URL);
      const question = pane(page).locator(".question-text");
      await expect(question).toContainText("Do you want Interloq to retry again, or to stop the run?");
      await expect(question).not.toContainText("endpoint");
      const firstOption = () => page.getByRole("group", { name: "Proposed answers" }).getByRole("button").first();
      const together = async (what: string) => {
        await firstOption().scrollIntoViewIfNeeded();
        for (const [name, part] of [["the question", question], ["the first option", firstOption()]] as const) {
          const b = await box(part);
          expect(b.y, `${what}: ${name}'s top`).toBeGreaterThanOrEqual(-1);
          expect(b.y + b.height, `${what}: ${name} is below the window`).toBeLessThanOrEqual(height + 1);
        }
      };
      if (height >= IN_VIEW_MIN_HEIGHT) await together("at the pause");
      else await belowTheLimit(page, question);
      const fault = await expandSection(page, attachedHeading("fault"));
      await expect(fault.locator("code")).toContainText("<endpoint> refused the connection");
      const end = fault.getByText(/END OF FAULT/);
      await end.scrollIntoViewIfNeeded();
      await expect(end).toBeInViewport();
      await firstOption().click();
      await toHaveEnded(page, "Completed");
    });
  }
});

// Issue #22 (W1-R1-1 of work review 1): under a question the compact dashboard's heading of every answer, opened after
// four long answers, never collapses the question pane: the question and its first answer stay in view without the run
// area scrolling (IN_VIEW_MIN_HEIGHT), and the earlier answers are reached by scrolling the compact dashboard itself.
const LONG_HISTORY_URL = layoutUrl("longHistory");
test.describe("the tests of the longHistory server, in order", () => {
  test.describe.configure({ mode: "default" });

  test("(L34) the open list of every answer under a question at 1280 × 600 and 640 × 450: the question keeps its room", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await startTask(page, LONG_HISTORY_URL);
    const firstCard = pane(page).getByRole("group", { name: "Proposed answers" }).getByRole("button").first();
    for (let i = 1; i <= 4; i++) {
      await expect(asking(page, `How should message ${i} show its time?`)).toBeVisible();
      await firstCard.click();
    }
    await expect(asking(page, "How should message 5 show its time?")).toBeVisible();
    const compact = page.locator(".dashboard-compact");
    const toggle = compact.locator("[data-answers-heading] button").first();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(compact.locator("[data-answer]")).toHaveCount(4);
    // The compact status line stays in the column under the question.
    await expect(compact.locator("[data-status]")).toBeVisible();
    for (const [width, height] of [[1280, 600], [640, 450]] as const) {
      await page.setViewportSize({ width, height });
      await page.locator("main.run").evaluate((el) => { el.scrollTop = 0; });
      const heading = pane(page).locator("h2");
      await expect(heading, `the question at ${width} × ${height}`).toBeInViewport({ ratio: 1 });
      // As the question page's other tests check it: the first answer is in view, wholly where the window can hold the
      // question and a card a paragraph long beside the earlier answers (1280 × 600), in part below that (640 × 450).
      await expect(firstCard, `the first answer at ${width} × ${height}`).toBeInViewport(width >= 840 ? { ratio: 1 } : {});
      const paneHeight = (await box(pane(page))).height;
      const needed = (await box(heading)).height + (await box(firstCard)).height;
      expect(paneHeight, `the question pane's height at ${width} × ${height}`).toBeGreaterThanOrEqual(needed);
      const last = compact.locator("[data-answer]").last();
      await last.scrollIntoViewIfNeeded();
      await expect(last, `the last earlier answer at ${width} × ${height}`).toBeInViewport();
      expect(await compact.locator("[data-dashboard-above]").evaluate((el) => el.scrollTop), `the compact dashboard scrolled at ${width} × ${height}`).toBeGreaterThan(0);
      // Beside the rail (840 px and wider) the dashboard is under the question in one column, so reading the earlier
      // answers leaves the question in view; in the compact layout at 450 px the dashboard is below the window, under the
      // pane's 12.5rem, and the run scrolls as a whole to reach it.
      if (width >= 840) await expect(heading, `the question after scrolling the answers at ${width} × ${height}`).toBeInViewport({ ratio: 1 });
    }
  });
});

// Issue #202: the Refinement tab's second row of tabs scrolls sideways inside itself when its tabs are wider than the
// window, every tab keeping its whole name, the selected tab in view with its indicator, and the page never scrolling
// sideways. The runs started at the first size stay in progress at the second, which only adds tabs.
test.describe("the tests of the refinementTabs server, in order", () => {
  test.describe.configure({ mode: "default" });

  for (const [width, height] of [[640, 400], [390, 844]] as const) {
    test(`(L35) four refinement runs at ${width} × ${height}: the second row scrolls, the page does not`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto(layoutUrl("refinementTabs"));
      await expect(page.getByText("connected", { exact: true })).toBeVisible();
      await tabOf(page, "refinement").click();
      const row = runTabsOf(page).locator(".row");
      const toList = async () => {
        if (await runTabsOf(page).isVisible()) {
          await listTabOf(page).scrollIntoViewIfNeeded();
          await listTabOf(page).click();
        }
        await expect(listOf(page)).toBeVisible();
      };
      let last = "";
      for (;;) {
        await toList();
        const start = listOf(page).locator("button[name=start]:not([disabled])").first();
        await expect(start).toBeVisible();
        last = (await start.getAttribute("data-item")) ?? "";
        await start.click();
        await expect(runTabOf(page, last)).toBeVisible();
        await expect(pane(page)).toBeVisible();
        if ((await runTabsOf(page).locator("label").count()) >= 5) break;
      }
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const inRow = async (tab: Locator, what: string) => {
        const rowBox = await box(row);
        await expect.poll(async () => {
          const tabBox = await box(tab);
          return tabBox.x >= rowBox.x - 1 && tabBox.x + tabBox.width <= rowBox.x + rowBox.width + 1;
        }, `${what} within the row at ${width} × ${height}`).toBe(true);
      };
      expect(await overflow(), `the page's sideways overflow at ${width} × ${height}`).toBeLessThanOrEqual(0);
      expect(await row.evaluate((el) => el.scrollWidth - el.clientWidth), `the row scrolls at ${width} × ${height}`).toBeGreaterThan(1);
      expect((await box(row)).height, `the row's height at ${width} × ${height}`).toBeCloseTo(48, 0);
      await inRow(runTabOf(page, last), "the selected tab");
      await expect(runTabOf(page, last).locator(".indicator")).toBeVisible();
      await listTabOf(page).scrollIntoViewIfNeeded();
      await listTabOf(page).click();
      await expect(listOf(page)).toBeVisible();
      await inRow(listTabOf(page), "the list's tab");
      await runTabOf(page, last).scrollIntoViewIfNeeded();
      await runTabOf(page, last).click();
      await expect(pane(page)).toBeVisible();
      await inRow(runTabOf(page, last), "the selected tab chosen again");
      await expect(runTabOf(page, last).locator(".indicator")).toBeVisible();
      expect(await overflow(), `the page's sideways overflow after choosing a tab at ${width} × ${height}`).toBeLessThanOrEqual(0);
      // The top row (Refinement, Implementation) does not overflow either.
      expect(await page.locator("nav.tabs > div").first().evaluate((el) => el.scrollWidth - el.clientWidth), `the top row at ${width} × ${height}`).toBeLessThanOrEqual(1);
    });
  }
});

// Issue #221: the live panel's bottom edge is its column's bottom whatever is above it; its handle moves it by mouse and
// keyboard, the content above scrolling; it keeps 1,000 lines, following new output at its end and staying put while
// scrolled up, the oldest line evicted under it; its colors are shown and no line is cut. One test per size.
const LIVE = (page: Page) => page.locator(".left .chat [data-live-output]");
const LIVE_SECTION = (page: Page) => page.locator('.left .chat section[aria-label="You and Interloq"]');
const bottomOf = async (l: Locator) => {
  const b = await box(l);
  return b.y + b.height;
};
/** The section's content bottom: its box less its bottom padding. */
const contentBottom = async (l: Locator) => (await bottomOf(l)) - (await l.evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingBottom) || 0));
/** The first line in view of the screen, screen-relative: its id and its top below the screen's top. */
const firstInView = (screen: Locator) =>
  screen.evaluate((s) => {
    const top = s.getBoundingClientRect().top;
    const first = [...s.querySelectorAll<HTMLElement>("[data-live-line]")].find((el) => el.getBoundingClientRect().bottom > top);
    return { id: Number(first?.dataset.lineId ?? -1), offset: (first?.getBoundingClientRect().top ?? 0) - top };
  });
const lastTick = (screen: Locator) => screen.evaluate((s) => Number(/tick (\d+)/u.exec([...s.querySelectorAll("[data-live-line]")].at(-1)?.textContent ?? "")?.[1] ?? 0));
const atEnd = (screen: Locator) => screen.evaluate((s) => s.scrollHeight - s.scrollTop - s.clientHeight <= 4);

test.describe("the tests of the liveOutput server, in order", () => {
  test.describe.configure({ mode: "default" });

  // One test per size (W1-R1-3), so that one size can be run alone; each starts its own run, the run of the test
  // before it stopped, so that its panel holds the scenario's 1,000 lines from its start.
  const SIZES = [[1280, 800], [640, 400], [390, 844]] as const;
  for (const [width, height] of SIZES) {
    const lastSize = width === SIZES[SIZES.length - 1]?.[0];
    test(`(L36) ${width}×${height}: the live panel anchored, resized, scrolled and colored`, async ({ page }) => {
      // Under the suite's load a tab may receive the scenario's burst compacted, or lose it to a hello, which empties
      // the panel (issue #163's run: 926 and 883 lines after 60 s, and no panel at all). The scenario's ticks carry
      // every marker read below, so the test waits for the ticks alone to fill the panel: 1,000 ticks of 300 ms.
      test.setTimeout(600_000);
      const size = `${width} × ${height}`;
      await page.setViewportSize({ width, height });
      await startTask(page, layoutUrl("liveOutput"));
      const live = LIVE(page);
      await expect(live.locator("[data-live-processes]")).toContainText(LIVE_LONG_NAME, { timeout: 180_000 });
      const screen = live.locator("[data-live-screen]");
      const handle = live.locator("[data-live-resize]");
      const section = LIVE_SECTION(page);
      const above = section.locator("[data-dashboard-above]");
      await expect(screen.locator("[data-live-line]")).toHaveCount(1000, { timeout: 330_000 });
      await live.scrollIntoViewIfNeeded();

      // The colors and the long line.
      const red = screen.locator(".text > span", { hasText: LIVE_RED_TEXT }).first();
      await expect(red).toBeAttached();
      expect(await red.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(224, 85, 97)");
      const long = screen.locator("[data-live-line]", { hasText: "w".repeat(50) }).first();
      await expect(long).toBeAttached();
      expect(await long.evaluate((el) => (/w+/u.exec(el.textContent ?? "")?.[0] ?? "").length)).toBe(LIVE_LONG_LINE);

      // Following: at its end, the screen stays at its end as ticks arrive.
      await screen.evaluate((s) => { s.scrollTop = s.scrollHeight; });
      const tick = await lastTick(screen);
      await expect.poll(() => lastTick(screen)).toBeGreaterThan(tick);
      expect(await atEnd(screen), `the screen follows the end at ${size}`).toBe(true);

      // Staying put across eviction: scrolled halfway, the first line in view keeps its id and its place.
      await screen.evaluate((s) => { s.scrollTop = (s.scrollHeight - s.clientHeight) / 2; });
      const before = await firstInView(screen);
      const from = await lastTick(screen);
      await expect.poll(() => lastTick(screen)).toBeGreaterThanOrEqual(from + 2);
      const after = await firstInView(screen);
      expect(after.id, `the first line in view kept at ${size}`).toBe(before.id);
      expect(Math.abs(after.offset - before.offset), `the first line's place kept at ${size}`).toBeLessThanOrEqual(2);

      // The anchor evicted: at the top, the oldest line goes and the screen stays at its top, showing a later line.
      await screen.evaluate((s) => { s.scrollTop = 0; });
      const oldest = await firstInView(screen);
      const at = await lastTick(screen);
      await expect.poll(() => lastTick(screen)).toBeGreaterThan(at);
      expect(await screen.evaluate((s) => s.scrollTop), `the screen stays at its top at ${size}`).toBe(0);
      expect((await firstInView(screen)).id, `a later line at the top at ${size}`).toBeGreaterThan(oldest.id);
      await screen.evaluate((s) => { s.scrollTop = s.scrollHeight; });

      const rootPx = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
      const placed = async (what: string) => {
        expect(Math.abs((await bottomOf(live)) - (await contentBottom(section))), `${what}: the panel's bottom at the section's at ${size}`).toBeLessThanOrEqual(1);
        expect((await box(live)).y, `${what}: the panel's top below the section's at ${size}`).toBeGreaterThan((await box(section)).y);
        // The section never scrolls: the content above scrolls inside itself and the panel gives way (P5-R1-1).
        const scrolled = await section.evaluate((el) => ({ top: el.scrollTop, over: el.scrollHeight - el.clientHeight }));
        expect(scrolled.top, `${what}: the section not scrolled at ${size}`).toBe(0);
        expect(scrolled.over, `${what}: the section not overflowing at ${size}`).toBeLessThanOrEqual(1);
        expect((await box(above)).height, `${what}: the content above keeps 2rem at ${size}`).toBeGreaterThanOrEqual(2 * rootPx - 1);
        const panelBottom = await bottomOf(live);
        const screenTall = (await box(screen)).height;
        for (const to of ["max", "top"] as const) {
          await above.evaluate((el, t) => { el.scrollTop = t === "max" ? el.scrollHeight : 0; }, to);
          expect(Math.abs((await bottomOf(live)) - panelBottom), `${what}: the panel unmoved by the content above scrolled to its ${to} at ${size}`).toBeLessThanOrEqual(1);
          expect(Math.abs((await box(screen)).height - screenTall), `${what}: the screen unchanged by the content above scrolled at ${size}`).toBeLessThanOrEqual(1);
        }
      };
      await placed("placed");
      if (width >= 840) expect(Math.abs((await bottomOf(section)) - (await bottomOf(page.locator(".left"))))).toBeLessThanOrEqual(1);
      else expect((await box(section)).height).toBeLessThanOrEqual(await page.locator("main.run").evaluate((el) => el.clientHeight));
      expect(await live.locator("[data-live-processes]").evaluate((el) => el.scrollHeight > el.clientHeight), `the running list scrolls at ${size}`).toBe(true);
      const listHeight = await live.locator("[data-live-processes]").evaluate((el) => el.clientHeight);
      const oneLine = Math.ceil(1.125 * rootPx) + 1;
      if (width === 640) expect(listHeight, `the running list one line high at ${size}`).toBeLessThanOrEqual(oneLine);
      else expect(listHeight, `the running list more than one line high at ${size}`).toBeGreaterThan(oneLine);

      // The keyboard: five lines taller at most, the bottom unmoved.
      const bottom = await bottomOf(live);
      const start = Number(await handle.getAttribute("aria-valuenow"));
      const max = Number(await handle.getAttribute("aria-valuemax"));
      const screenHeight = (await box(screen)).height;
      await handle.focus();
      for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowUp");
      await expect(handle).toHaveAttribute("aria-valuenow", String(Math.min(start + 5, max)));
      if (start < max) expect((await box(screen)).height).toBeGreaterThan(screenHeight);
      expect(Math.abs((await bottomOf(live)) - bottom)).toBeLessThanOrEqual(1);

      // The mouse: dragged up by three lines.
      await page.keyboard.press("Home");
      const low = Number(await handle.getAttribute("aria-valuenow"));
      const line = await page.evaluate(() => 1.125 * (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16));
      const h = await box(handle);
      await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
      await page.mouse.down();
      await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2 - 3 * line, { steps: 6 });
      await page.mouse.up();
      await expect(handle).toHaveAttribute("aria-valuenow", String(Math.min(low + 3, max)));
      expect(Math.abs((await bottomOf(live)) - bottom)).toBeLessThanOrEqual(1);

      // The content above grows: the panel keeps its chosen height and its place, and the content above scrolls
      // (W3-R2-1).
      const valueBefore = await handle.getAttribute("aria-valuenow");
      const chosen = (await box(screen)).height;
      // Its chosen lines fit whole at every size (maxPanelLines).
      expect(Math.abs(chosen - (Number(valueBefore) * line + 16)), `the screen as tall as its lines at ${size}`).toBeLessThanOrEqual(1);
      await above.evaluate((el) => {
        const filler = document.createElement("div");
        filler.dataset.testFiller = "";
        filler.style.height = "2000px";
        filler.style.flex = "none";
        el.append(filler);
      });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
      expect(Math.abs((await box(screen)).height - chosen), `the screen's height kept as the content above grows at ${size}`).toBeLessThanOrEqual(1);
      await expect(handle).toHaveAttribute("aria-valuenow", valueBefore ?? "");
      await placed("the content above grown");
      expect(await above.evaluate((el) => el.scrollHeight > el.clientHeight), `the grown content above scrolls at ${size}`).toBe(true);
      await above.evaluate((el) => el.querySelector("[data-test-filler]")?.remove());

      // End: the panel takes what the room allows, and the content above scrolls.
      await handle.focus();
      await page.keyboard.press("End");
      await expect(handle).toHaveAttribute("aria-valuenow", String(max));
      expect(Math.abs((await box(screen)).height - (max * line + 16)), `the screen as tall as its most lines at ${size}`).toBeLessThanOrEqual(1);
      expect(await above.evaluate((el) => el.scrollHeight > el.clientHeight), `the content above scrolls at ${size}`).toBe(true);
      await placed("at the most lines");
      await expect(screen.locator("[data-live-line]")).toHaveCount(1000);

      // Cramped columns, at 640 × 400 alone: the panel gives way in its fixed order and stays anchored.
      if (width === 640) {
        const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
        // The section's content height set to h, whatever its box-sizing.
        const cramp = async (h: number) => {
          await section.evaluate((el, content) => {
            const st = getComputedStyle(el);
            const padding = st.boxSizing === "border-box" ? (Number.parseFloat(st.paddingTop) || 0) + (Number.parseFloat(st.paddingBottom) || 0) : 0;
            el.style.maxHeight = `${content + padding}px`;
          }, h);
          await frames();
        };
        await cramp(120);
        await placed("cramped");
        const crampedNow = Number(await handle.getAttribute("aria-valuenow"));
        expect(crampedNow, "fewer than three lines in a cramped column").toBeLessThan(3);
        expect(Number(await handle.getAttribute("aria-valuemin"))).toBeLessThanOrEqual(crampedNow);
        expect(Math.abs((await box(screen)).height - (crampedNow * line + 16)), "the cramped screen as tall as its lines").toBeLessThanOrEqual(1);

        await cramp(90);
        await placed("below one line");
        await expect(handle).toHaveAttribute("aria-valuenow", "1");
        const tiny = (await box(screen)).height;
        expect(tiny, "the screen's box above nothing").toBeGreaterThan(0);
        expect(tiny, "the screen below one line").toBeLessThan(line + 16 - 1);
        expect((await box(live)).height, "the panel within its budget").toBeLessThanOrEqual(90 - 12 - 2 * rootPx + 1);
        expect(await screen.evaluate((el) => el.scrollHeight > el.clientHeight), "the shrunk screen still scrolls").toBe(true);
        const tinyBottom = await bottomOf(live);
        await screen.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        expect(Math.abs((await bottomOf(live)) - tinyBottom)).toBeLessThanOrEqual(1);

        await section.evaluate((el) => { el.style.maxHeight = ""; });
        await frames();
        await expect(handle).toHaveAttribute("aria-valuenow", String(max));
      }

      // The height is remembered across a reload.
      if (lastSize) {
        await page.reload();
        await expect(handle).toHaveAttribute("aria-valuenow", String(max), { timeout: 60_000 });
      }
    });
  }
});

// Issue #221: the compact panel under a question, anchored at the compact dashboard's bottom while a process runs,
// four earlier answers filling the region above it, which scrolls; no handle; its running list one line high.
test.describe("the tests of the liveOutputQuestion server, in order", () => {
  test.describe.configure({ mode: "default" });

  test("(L37) the compact panel anchored under a question at 1280 × 800, 640 × 400 and 390 × 844", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await startTask(page, layoutUrl("liveOutputQuestion"));
    const firstCard = pane(page).getByRole("group", { name: "Proposed answers" }).getByRole("button").first();
    for (let i = 1; i <= 4; i++) {
      await expect(asking(page, `How should message ${i} show its time?`)).toBeVisible({ timeout: 60_000 });
      await firstCard.click();
    }
    const compact = page.locator(".dashboard-compact");
    const live = compact.locator("[data-live-output]");
    await expect(live).toBeVisible({ timeout: 60_000 });
    await expect(pane(page)).toBeVisible();
    const toggle = compact.locator("[data-answers-heading] button").first();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(compact.locator("[data-answer]")).toHaveCount(4);
    const above = compact.locator("[data-dashboard-above]");
    const screen = live.locator("[data-live-screen]");
    const list = live.locator("[data-live-processes]");
    const line = await page.evaluate(() => 1.125 * (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16));

    for (const [width, height] of [[1280, 800], [640, 400], [390, 844]] as const) {
      const size = `${width} × ${height}`;
      await page.setViewportSize({ width, height });
      await compact.scrollIntoViewIfNeeded();
      await expect.poll(() => above.evaluate((el) => el.scrollHeight > el.clientHeight), { message: `the region above overflows at ${size}` }).toBe(true);
      const bottom = await bottomOf(live);
      expect(Math.abs(bottom - (await bottomOf(compact))), `the panel's bottom at the compact dashboard's at ${size}`).toBeLessThanOrEqual(1);
      if (width >= 840) expect(Math.abs(bottom - (await bottomOf(page.locator(".left"))))).toBeLessThanOrEqual(1);
      expect((await box(live)).y, `the panel's top within the compact dashboard at ${size}`).toBeGreaterThanOrEqual((await box(compact)).y);
      expect((await box(screen)).height, `the screen's height at ${size}`).toBeGreaterThanOrEqual(2 * line);
      await above.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      expect(await above.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      expect(Math.abs((await bottomOf(live)) - bottom), `the panel unmoved by the region above at ${size}`).toBeLessThanOrEqual(1);
      expect(await list.evaluate((el) => el.clientHeight)).toBeLessThanOrEqual(Math.ceil(line) + 1);
      expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight), `the running list scrolls at ${size}`).toBe(true);
      await expect(live.locator("[data-live-resize]")).toHaveCount(0);
      const tick = await lastTick(screen);
      await expect.poll(() => lastTick(screen)).toBeGreaterThan(tick);
      expect(await atEnd(screen), `the screen follows the end at ${size}`).toBe(true);
    }
  });
});

// Issue #139: the primary tabs hold a paused and a running run's mark, the glyph, the name and the pause's time on one
// row of the 48 px bar, at every width, with nothing outside its tab and no sideways scroll.
test.describe("the tests of the tabStatesLayout server, in order", () => {
  test.describe.configure({ mode: "default" });

  for (const [width, height] of [[1280, 800], [640, 400], [390, 844]] as const) {
    test(`(L44) the primary tabs hold a paused and a running run's mark on one row at ${width} × ${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await startFromTab(page, layoutUrl("tabStatesLayout"), "implementation");
      await tabOf(page, "refinement").click();
      const implementation = tabOf(page, "implementation");
      const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      await expect(implementation).toHaveText(new RegExp(`^\\s*${escaped(LIMIT_PAUSED_MARK)} ${escaped(TAB_TEXTS.implementation.tab)} until `));
      const checkRow = async (what: string) => {
        expect((await box(page.locator("nav.tabs"))).height, `the bar's height, ${what}`).toBeCloseTo(48, 0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `sideways overflow, ${what}`).toBeLessThanOrEqual(0);
        for (const label of await page.locator("nav.tabs label").all()) {
          const outer = await box(label);
          const spans = await label.locator(":scope > span:not(.indicator)").all();
          const centers: number[] = [];
          for (const span of spans) {
            const inner = await box(span);
            expect(inner.x >= outer.x - 1 && inner.x + inner.width <= outer.x + outer.width + 1, `a span within its tab horizontally, ${what}`).toBe(true);
            expect(inner.y >= outer.y - 1 && inner.y + inner.height <= outer.y + outer.height + 1, `a span within its tab vertically, ${what}`).toBe(true);
            centers.push(inner.y + inner.height / 2);
          }
          if (centers.length > 0) expect(Math.max(...centers) - Math.min(...centers), `one row, ${what}`).toBeLessThan(2);
        }
      };
      await checkRow(`paused at ${width} × ${height}`);
      await implementation.click();
      await page.locator("button[name=end-wait]").first().click();
      await tabOf(page, "refinement").click();
      await expect(implementation).toHaveText(markedTabName(TAB_TEXTS.implementation.tab, { _tag: "Running" }));
      await checkRow(`running at ${width} × ${height}`);
      await implementation.click();
      await page.locator("button[name=stop]").click();
      await confirmEnd(page);
      await toHaveEnded(page, "Interrupted");
    });
  }
});

// Issue #98 (requirements Q1): each choice's card carries its own picture, visible at once, inside the card at every
// width; two pictures that share an id each draw their own shape; nothing the agent wrote runs; the decision page's
// cards keep the pictures and its columns show none.
test.describe("the tests of the figureChoices server, in order", () => {
  test.describe.configure({ mode: "default" });
  const FIGURE_URL = layoutUrl("figureChoices");
  /** Each card's picture: one svg inside the card, with a height, and its use drawn at its own picture's size. */
  const picturesOnCards = async (page: Page) => {
    const all = cards(page);
    await expect(all).toHaveCount(2);
    for (const [i, expected] of [[0, 40 / 400], [1, 320 / 400]] as const) {
      const card = all.nth(i);
      const svgs = card.locator("[data-option-figure] svg");
      await expect(svgs).toHaveCount(1);
      const [c, s, u] = [await box(card), await box(svgs.first()), await box(card.locator("[data-option-figure] use"))];
      expect(s.height, `picture ${i + 1} has a height`).toBeGreaterThan(0);
      expect(s.x, `picture ${i + 1} starts inside its card`).toBeGreaterThanOrEqual(c.x - 1);
      expect(s.y).toBeGreaterThanOrEqual(c.y - 1);
      expect(s.x + s.width, `picture ${i + 1} ends inside its card`).toBeLessThanOrEqual(c.x + c.width + 1);
      expect(s.y + s.height).toBeLessThanOrEqual(c.y + c.height + 1);
      expect(Math.abs(u.width / s.width - expected) / expected, `picture ${i + 1} draws its own shape`).toBeLessThanOrEqual(0.02);
    }
    expect(await page.locator("[data-option-figure] script").count()).toBe(0);
    expect(await page.locator("[data-option-figure] [onload]").count()).toBe(0);
    expect(await page.title()).not.toBe("figure ran");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page scrolls sideways").toBe(true);
  };
  for (const [width, height] of [[1280, 800], [640, 400], [390, 844]] as const) {
    test(`(L45) the pictures on the choices' cards at ${width} × ${height}, and on the decision page`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await startTask(page, FIGURE_URL);
      await expect(cards(page)).toHaveCount(2);
      await picturesOnCards(page);
      if (width === 1280) {
        const [a, b] = [await box(cards(page).nth(0)), await box(cards(page).nth(1))];
        expect(Math.abs(a.y - b.y), "the cards stand side by side").toBeLessThanOrEqual(1);
      }
      await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
      const analysis = analysisOf(page);
      await expect(analysis).toBeVisible();
      await picturesOnCards(page);
      expect(await analysis.locator(".column [data-option-figure]").count(), "the columns show no picture").toBe(0);
      await answerDismisses(page, analysis);
    });
  }
});

// Issue #40: the note on Claude Code's latest message, naming the commands running when it was written, in a browser: it
// lies inside the message, holds each name whole, wraps a long one, and makes the page scroll sideways at no size.
test.describe("the tests of the narrationNote server, in order", () => {
  test.describe.configure({ mode: "default" });
  for (const [width, height] of [[1280, 800], [640, 400], [390, 844]] as const) {
    test(`(L46) ${width}×${height}: the note of commands running under Claude Code's message`, async ({ page }) => {
      const size = `${width} × ${height}`;
      await page.setViewportSize({ width, height });
      await startTask(page, layoutUrl("narrationNote"));
      const claude = page.locator("[data-claude]").first();
      const note = claude.locator("[data-claude-running]");
      await expect(note).toBeVisible({ timeout: 60_000 });
      await claude.scrollIntoViewIfNeeded();
      const outer = await box(claude);
      const inner = await box(note);
      expect(inner.x, `the note inside the message at ${size}`).toBeGreaterThanOrEqual(outer.x - 1);
      expect(inner.x + inner.width, `the note inside the message at ${size}`).toBeLessThanOrEqual(outer.x + outer.width + 1);
      expect(inner.y + inner.height, `the note inside the message at ${size}`).toBeLessThanOrEqual(outer.y + outer.height + 1);
      const items = note.locator("li");
      expect(await items.allTextContents()).toEqual(["npm test", NARRATION_LONG_COMMAND]);
      const long = items.nth(1);
      const wrap = await long.evaluate((el) => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight), over: el.scrollWidth - el.clientWidth }));
      expect(wrap.over, `the long name's text within its line at ${size}`).toBeLessThanOrEqual(0);
      const room = await claude.evaluate((el) => el.clientWidth);
      expect(wrap.width, `the long name no wider than the message at ${size}`).toBeLessThanOrEqual(room);
      expect(wrap.height, `the long name wraps at ${size}`).toBeGreaterThan(2 * wrap.line);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `no sideways scroll at ${size}`).toBe(true);
      if (width !== 640) {
        const over = await LIVE_SECTION(page).evaluate((el) => el.scrollHeight - el.clientHeight);
        expect(over, `the dashboard's section not overflowing at ${size}`).toBeLessThanOrEqual(1);
      }
      // W1-R1-3: the note is of reduced emphasis through a color role, never an opacity (issue #109), and stays legible.
      const colors = await note.evaluate((el) => {
        const message = el.closest("[data-claude]") as HTMLElement;
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
        const srgb = (color: string): readonly number[] => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
        };
        const lead = el.querySelector("p") as HTMLElement;
        return {
          note: srgb(getComputedStyle(lead).color),
          body: srgb(getComputedStyle(message).color),
          surface: srgb(getComputedStyle(message).backgroundColor),
          opacities: [el, lead, ...Array.from(el.querySelectorAll("li"))].map((node) => getComputedStyle(node).opacity),
        };
      });
      expect(colors.note, `the note's color differs from the message's at ${size}`).not.toEqual(colors.body);
      expect(colors.opacities.every((opacity) => opacity === "1"), `no opacity on the note at ${size}`).toBe(true);
      expect(contrastRatio(colors.note, colors.surface), `the note's contrast on the message's surface at ${size}`).toBeGreaterThanOrEqual(4.5);
    });
  }
});

/** The WCAG contrast ratio of two sRGB colors given as 0–255 channels. */
const contrastRatio = (a: readonly number[], b: readonly number[]): number => {
  const luminance = (rgb: readonly number[]): number => {
    const [r, g, bl] = rgb.map((channel) => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

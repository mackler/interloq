import type { Locator, Page } from "@playwright/test";
import { dashboard, expect, listOf, startFromTab, test, toHaveEnded, toTheList } from "./fixtures.ts";
import { attachedHeading, CONTEXT_HEADING, QUESTION_HISTORY_HEADING, RECOMMENDATION_HEADING, YOUR_CHOICE, clarificationProgress, progressLine, RAIL_CONDITION_LABEL, railToggleName, stageHeading, stepLabel, stepOfPhase, CONFIRM_SUMMARY_LABEL, CONTINUE_WITHOUT_DECIDING, END_CLARIFICATION, HELP_ME_DECIDE, SHOW_CONVERSATION, SHOW_QUESTION } from "../src/prompts.ts";
import { LONG_ANSWERS, LONG_ITEM_TITLE, LONG_STEP_LABEL } from "./longAnswers.ts";
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
  await toHaveEnded(page, 0);
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
    await toHaveEnded(page, 0);
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
      // Issue #184: the answer goes to Claude Code in the background and the agreed list is then done, so the next
      // prompt is the summary. The reply "Anything else?" acknowledges the answer and asks nothing (requirements, "What
      // Claude Code is told"), so it is no longer a prompt; issue #22: it was Claude Code's latest message on the
      // dashboard, and the proposed summary has replaced it there.
      await expect(pane(page).getByRole("button", { name: CONFIRM_SUMMARY_LABEL, exact: true })).toBeVisible();
      await expect(pane(page).getByText("Anything else?")).toHaveCount(0);
      await pane(page).getByRole("button", { name: SHOW_CONVERSATION }).click();
      await expect(dashboard(page).locator("[data-claude]")).toContainText("Relative time.");
      await expect(dashboard(page).locator("[data-last-answer] [data-your-answer]")).toContainText("Relative time");
      await page.locator("button[name=stop]").click();
      await confirmEnd(page);
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
      const problems = await nav.evaluate((rail) => {
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
      expect(problems).toEqual([]);
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
      await toHaveEnded(page, 0);
    });
  }
  test("(L19) a long question at 640 × 400, below the 450 px limit: no sideways overflow, the question in view, the first option reached by scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 400 });
    await startTask(page, LONG_QUESTION_URL);
    await belowTheLimit(page, pane(page).locator(".question-text"));
    await page.mouse.move(0, 0);
    await continueWithoutDeciding(page).click();
    await toHaveEnded(page, 0);
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
    await toHaveEnded(page, 0);
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
      await toHaveEnded(page, 0);
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
    await toHaveEnded(page, 0);
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
      await toHaveEnded(page, 0);
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
    await toHaveEnded(page, 0);
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
    await toHaveEnded(page, 0);
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
    await toHaveEnded(page, 0);
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
      await toHaveEnded(page, 0);
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
      expect(await compact.evaluate((el) => el.scrollTop), `the compact dashboard scrolled at ${width} × ${height}`).toBeGreaterThan(0);
      // Beside the rail (840 px and wider) the dashboard is under the question in one column, so reading the earlier
      // answers leaves the question in view; in the compact layout at 450 px the dashboard is below the window, under the
      // pane's 12.5rem, and the run scrolls as a whole to reach it.
      if (width >= 840) await expect(heading, `the question after scrolling the answers at ${width} × ${height}`).toBeInViewport({ ratio: 1 });
    }
  });
});

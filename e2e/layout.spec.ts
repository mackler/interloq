import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { CONTINUE_WITHOUT_DECIDING, END_CLARIFICATION, HELP_ME_DECIDE, SHOW_CONVERSATION, SHOW_QUESTION } from "../src/prompts.ts";
import { LONG_ANSWERS } from "./longAnswers.ts";
import { layoutUrl } from "./ports.ts";

// Finding 7 of docs/gui-review.md, decision Q3: the layout adapts. At M3's expanded width (840 px and wider) the rail
// and both panels are side by side; below it, one panel at a time, chosen by its title, with a badge for the other's
// new messages, and a prompt selects "You and Interloq". The "tabs" server asks two decisions in a row.
const URL = layoutUrl("tabs");
const LEFT = "You and Interloq";
const RIGHT = "Claude and Codex";
const panel = (page: Page, name: string) => page.getByRole("region", { name });
/** The question the run waits on, which takes the left column while it is pending (S27). */
const pane = (page: Page) => page.locator("section.pane");
const asking = (page: Page, text: string) => pane(page).locator(".question-text", { hasText: text });
const continueWithoutDeciding = (page: Page) => pane(page).getByRole("button", { name: CONTINUE_WITHOUT_DECIDING, exact: true });
const confirmEnd = (page: Page) => page.locator("dialog[open] button[name=confirm-end]").click();
const box = async (locator: Locator) => {
  const b = await locator.boundingBox();
  if (b === null) throw new Error("the element is not visible");
  return b;
};
const startTask = async (page: Page, task: string, url = URL) => {
  await page.goto(url);
  await expect(page.getByText("connected", { exact: true })).toBeVisible();
  // The form, an ended run, or a run left by an earlier test on the shared server, which is stopped first.
  await expect(page.locator("textarea[name=task], button[name=new], button[name=stop]:not([disabled])").first()).toBeVisible();
  const stop = page.locator("button[name=stop]");
  const again = page.locator("button[name=new]");
  const form = page.locator("textarea[name=task]");
  // Retried as a whole: the left run can end between the check and the click (it did on a loaded machine), after
  // which Stop stays disabled and a plain click would wait for the test's whole timeout.
  await expect(async () => {
    if (await form.isVisible()) return;
    // S34: a confirmation an earlier attempt opened and did not confirm stays open and intercepts every click, Stop's
    // included (end-to-end test 7a reproduces it); it is confirmed first, not reopened.
    const dialog = page.locator("dialog[open]");
    if (!(await dialog.isVisible()) && (await stop.isEnabled({ timeout: 1_000 }).catch(() => false))) await stop.click({ timeout: 2_000 });
    if (await dialog.isVisible()) {
      // S38: the confirmation closes without acting if the run ends before it is confirmed, which the check covers.
      await dialog.locator("button[name=confirm-end]").click({ timeout: 5_000 }).catch(() => undefined);
      await expect(dialog).toHaveCount(0, { timeout: 5_000 });
    }
    await again.click({ timeout: 5_000 });
    await expect(form).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await form.fill(task);
  await page.locator("button[name=start]").click();
};
const FIRST = "Which database should the service use?";
const SECOND = "Which cache should the service use?";

/** The assertions of a compact window: no horizontal overflow, a usable panel and answer field, the panel switch. */
const compactChecks = async (page: Page, context: import("@playwright/test").BrowserContext, minHeight: number) => {
  await startTask(page, "Add a database in a narrow window");
  await expect(asking(page, FIRST)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page overflows horizontally").toBe(true);
  // S27 and issue #20: the question the run waits on takes the column; the transcript is out of the way.
  const left = await box(pane(page));
  expect(left.width, "the panel's width").toBeGreaterThanOrEqual(300);
  expect(left.height, "the panel's height").toBeGreaterThanOrEqual(minHeight);
  expect((await box(page.locator("[name=answer]"))).width, "the answer field's width").toBeGreaterThanOrEqual(280);
  await expect(panel(page, RIGHT)).toBeHidden();

  // The other panel by its title; a prompt brings "You and Interloq" back.
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
  await expect(panel(page, LEFT).getByText(/finished after 1 implementation phase/)).toBeVisible();
  await other.close();
};

// W2-R1-3 and P3-R1-1 (work review 2 and planning 3): a panel keeps its reading position across a switch and a resize,
// and a panel that was hidden follows its end when it is shown again, unless the user had scrolled it up.
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
const longRunAtItsPrompt = async (page: Page, task: string) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await startTask(page, task, LONG_URL);
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
// sideways when they do not; below 390 px a message instead.
const DECIDE_URL = layoutUrl("decide");
/** The question text and the notice lie inside the analysis's box (W2-R1-1 of work review 2). */
const questionAndNoticeInside = async (analysis: Locator) => {
  const area = await box(analysis);
  for (const [name, part] of [["the question", analysis.locator(".question-text")], ["the notice", analysis.getByRole("alert")]] as const) {
    const b = await box(part);
    expect(b.y, `${name}'s top is above the analysis`).toBeGreaterThanOrEqual(area.y - 1);
    expect(b.y + b.height, `${name} is below the analysis's end`).toBeLessThanOrEqual(area.y + area.height + 1);
  }
};
const openAnalysis = async (page: Page) => {
  await startTask(page, "Add a database", DECIDE_URL);
  await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
  const analysis = page.getByRole("region", { name: /^Decision 1: / });
  await expect(analysis).toBeVisible();
  return analysis;
};
// W4-R1-1: in the compact layout a long analysis scrolls inside a bounded area, and the answer controls stay in view
// (a tall window) or can be scrolled into the run's view (a short window, or the progress opened), never overlapping
// the analysis or each other and never clipped.
const openLongAnalysis = async (page: Page, width: number, height: number) => {
  await page.setViewportSize({ width, height });
  await startTask(page, "Add a database", layoutUrl("decideLong"));
  await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
  const analysis = page.getByRole("region", { name: /^Decision 1: / });
  await expect(analysis).toBeVisible();
  return {
    analysis,
    run: page.locator("main.run"),
    area: page.locator(".decision-area"),
    // Issue #81: the region that scrolls sideways, each column's own vertical scroller, and the recommendation's region.
    sideways: analysis.locator(".sideways"),
    columns: analysis.locator(".column"),
    recommendation: analysis.locator(".recommendation"),
    prompt: page.locator("section.pane"),
    activity: page.locator("[data-activity]"),
  };
};
type Parts = Awaited<ReturnType<typeof openLongAnalysis>>;
/**
 * The task of L21, by the developer's decision at the stop of execution phase 1: in a window of any width too short for
 * the analysis's floor, the analysis gives up height so that the question and its first answer are in view together,
 * with nothing scrolled into view. The spare room asserted is 16 px: the 24 px ROOM_MARGIN of web/src/layout.ts less 8 px
 * that tolerate rasterization differences between environments rendering the same face (issue #73). The run may hold more below the first answer (the
 * rest of the prompt, the activity line), which the room does not budget, so its scroll position is checked, not its
 * scroll height.
 */
const questionWithFirstAnswer = async (page: Page, analysis: Locator, height: number) => {
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  expect(await page.locator("main.run").evaluate((el) => el.scrollTop), "the run scrolled").toBe(0);
  const question = await box(analysis.locator(".question-text"));
  expect(question.y, "the question's top is above the window").toBeGreaterThanOrEqual(0);
  const first = await box(page.getByRole("group", { name: "Proposed answers" }).getByRole("button").first());
  expect(first.y + first.height, "the first answer has less than 16 px below it").toBeLessThanOrEqual(height - 16);
};
/**
 * The order in which the analysis yields where the window is shorter than its floor (the task of L21): the columns give
 * up their height before the recommendation shows less than two of its lines, and the recommendation gives up its
 * height before the context shows less than two of its lines. A text counts as shortened only when it is cut.
 */
const yieldOrder = async (analysis: Locator) => {
  const m = await analysis.evaluate((el) => {
    const text = (s: string) => {
      const r = el.querySelector<HTMLElement>(s);
      if (r === null) return null;
      const cs = getComputedStyle(r);
      const line = parseFloat(cs.lineHeight) || 1.2 * parseFloat(cs.fontSize);
      const inner = r.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      return { short: r.scrollHeight > r.clientHeight + 1 && inner < 2 * line - 1, height: r.getBoundingClientRect().height };
    };
    return { context: text(".question-context"), recommendation: text(".recommendation"), columns: el.querySelector(".sideways")?.getBoundingClientRect().height ?? 0 };
  });
  if (m.recommendation?.short === true) expect(m.columns, "the recommendation is shortened while the columns keep height").toBeLessThanOrEqual(1);
  if (m.context?.short === true) expect(m.recommendation?.height ?? 0, "the context is shortened while the recommendation keeps height").toBeLessThanOrEqual(1);
};
/** Whether some column's own scroller holds more than it shows. */
const someColumnOverflows = (parts: Parts) => parts.columns.evaluateAll((cs) => cs.some((c) => c.scrollHeight > c.clientHeight + 1));
/** The decision area, the prompt and the activity line do not overlap, and the prompt shows all of its content. */
const separateAndWhole = async (parts: Parts) => {
  const rect = (l: Locator) => l.evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
  const [area, prompt, activity] = [await rect(parts.area), await rect(parts.prompt), await rect(parts.activity)];
  const apart = (a: { top: number; bottom: number }, b: { top: number; bottom: number }) => a.bottom <= b.top + 1 || b.bottom <= a.top + 1;
  expect(apart(area, prompt), `the decision area ${JSON.stringify(area)} and the prompt ${JSON.stringify(prompt)} overlap`).toBe(true);
  expect(apart(area, activity), `the decision area ${JSON.stringify(area)} and the activity line ${JSON.stringify(activity)} overlap`).toBe(true);
  expect(apart(prompt, activity), `the prompt ${JSON.stringify(prompt)} and the activity line ${JSON.stringify(activity)} overlap`).toBe(true);
  const clip = await parts.prompt.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(clip.scroll, "the prompt is clipped").toBeLessThanOrEqual(clip.client + 1);
};
/** Each of the prompt and the activity line can be scrolled fully into the run's view. */
const reachable = async (parts: Parts) => {
  for (const [name, part] of [["the prompt", parts.prompt], ["the activity line", parts.activity]] as const) {
    await part.scrollIntoViewIfNeeded();
    const within = await part.evaluate((el) => {
      const run = el.closest("main.run");
      if (run === null) return null;
      const [r, e] = [run.getBoundingClientRect(), el.getBoundingClientRect()];
      return { run: { top: r.top, bottom: r.bottom }, el: { top: e.top, bottom: e.bottom } };
    });
    expect(within, `${name} is outside the run`).not.toBeNull();
    if (within === null) return;
    expect(within.el.top, `${name}'s top is above the run's view`).toBeGreaterThanOrEqual(within.run.top - 1);
    expect(within.el.bottom, `${name}'s bottom is below the run's view`).toBeLessThanOrEqual(within.run.bottom + 1);
  }
};
const answerDismisses = async (page: Page, parts: Parts) => {
  await page.getByRole("group", { name: "Proposed answers" }).getByRole("button", { name: /SQLite/ }).click();
  await expect(parts.analysis).toBeHidden();
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
// only; the attempts and the whole fault, <endpoint> included (shown literally, P6-R1-1), are in the details above it.
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
    await startTask(page, "Add a database in a wide window");
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
    await expect(panel(page, LEFT).getByText(/finished after 1 implementation phase/)).toBeVisible();
  });

  // W2-R1-2: a notice is visible whichever panel is shown; here the server's own end (finding 15).
  test("(L7) with the right panel shown, the page still says that the server has ended", async ({ page }) => {
    let route: import("@playwright/test").WebSocketRoute | null = null;
    await page.routeWebSocket(/\/ws$/, (ws) => {
      route = ws;
      ws.connectToServer();
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await startTask(page, "Watch the review");
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
  test("(L8) a new run's first prompt selects 'You and Interloq' although the old run waited on a prompt of the same number", async ({ page, context }) => {
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
    await startTask(page, "The first run");
    await expect(asking(page, FIRST)).toBeVisible();
    await showPanel(page, RIGHT);
    hold = true;
    await current!.close();
    const other = await context.newPage();
    await other.goto(URL);
    await other.locator("button[name=stop]").click();
    await confirmEnd(other);
    await other.locator("button[name=new]").click();
    await other.locator("textarea[name=task]").fill("The second run");
    await other.locator("button[name=start]").click();
    await expect(asking(other, FIRST)).toBeVisible();
    hold = false;
    await expect(page.getByText("connected", { exact: true })).toBeVisible();
    await expect(page.getByText("The second run").first()).toBeVisible();
    await expect(pane(page)).toBeVisible();
    await expect(page.locator("[name=answer]")).toBeVisible();
    await other.close();
  });
});

test.describe("the tests of the long server, in order", () => {
  test.describe.configure({ mode: "default" });

  test("(L4) a panel's reading position survives a switch of panels and a resize across 840 px", async ({ page }) => {
    await longRunAtItsPrompt(page, "Keep my place");
    await toTop(list(page, LEFT));
    await showPanel(page, RIGHT);
    await showPanel(page, LEFT);
    expect(await list(page, LEFT).evaluate((el) => el.scrollTop), "after a switch").toBe(0);
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await list(page, LEFT).evaluate((el) => el.scrollTop), "after a resize").toBe(0);
  });

  test("(L5) a hidden panel opens at its end, and follows the messages that arrived while it was hidden", async ({ page }) => {
    await longRunAtItsPrompt(page, "Follow the review");
    await showPanel(page, RIGHT);
    await expect.poll(() => fromEnd(list(page, RIGHT)), { message: "hidden from the start" }).toBeLessThan(32);
    await showPanel(page, LEFT);
    await answerContinue(page);
    await expect(page.getByRole("button", { name: new RegExp(`^${RIGHT}.*new`) })).toBeVisible();
    await showPanel(page, RIGHT);
    await expect.poll(() => fromEnd(list(page, RIGHT)), { message: "following after the reveal" }).toBeLessThan(32);
  });

  test("(L6) a panel scrolled up keeps its position while hidden, and its chip counts what arrived", async ({ page }) => {
    await longRunAtItsPrompt(page, "Read the review from the start");
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
      await startTask(page, `Show the time at ${width}`, LONG_CHOICES_URL);
      await expect(page.getByRole("button", { name: END_CLARIFICATION })).toBeVisible();
      // Issue #21: a narrow window's progress line names the step and its count.
      if (width < 840) await expect(page.locator("details.progress summary")).toHaveText("Progress: Gather Requirements — Clarification, 0 of 1 answered");
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
      // The cards scroll within the pane's lower region, so the message field, Send and Finish clarification can be
      // scrolled into the window, with the question still in view.
      for (const name of ["[name=answer]", "button[name=send]", `button:has-text('${END_CLARIFICATION}')`]) {
        await page.locator(name).scrollIntoViewIfNeeded();
        await expect(page.locator(name)).toBeInViewport();
        await expect(pane(page).locator(".question-text")).toBeInViewport();
      }
      await cards.nth(1).focus();
      await page.keyboard.press("Enter");
      await expect(pane(page).getByText("Anything else?")).toBeVisible();
      await pane(page).getByRole("button", { name: SHOW_CONVERSATION }).click();
      await expect(panel(page, LEFT).locator("[data-author=user]").last()).toContainText("Relative time");
      await page.locator("button[name=stop]").click();
      await confirmEnd(page);
    });
  }
});

test.describe("the tests of the decide server, in order", () => {
  test.describe.configure({ mode: "default" });

  test("(L10) the analysis at 1280 × 800: both columns side by side", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const analysis = await openAnalysis(page);
    const [a, b] = [await box(analysis.locator(".column").nth(0)), await box(analysis.locator(".column").nth(1))];
    expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1);
    expect(b.x).toBeGreaterThanOrEqual(a.x + a.width);
    expect(a.width).toBeGreaterThanOrEqual(320);
    await expect(analysis.getByText("Scroll sideways to see every option.")).toBeHidden();
    await page.getByRole("group", { name: "Proposed answers" }).getByRole("button", { name: /SQLite/ }).click();
    await expect(analysis).toBeHidden();
  });

  // Issue #79, decision Q1 kept by the developer ("Keep the rule as decided"): at 1280 × 800 the columns keep their strip,
  // and the context takes all the room the rest leaves, scrolling for the remainder; nothing is left empty while it is cut.
  test("(L24) a context of about ten lines at 1280 × 800 takes the room the rest leaves, and scrolls for the rest", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const analysis = await openAnalysis(page);
    const context = analysis.locator(".question-context");
    const m = await context.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight, line: parseFloat(getComputedStyle(el).lineHeight) || 1.2 * parseFloat(getComputedStyle(el).fontSize) }));
    expect(m.scroll, "the context is about ten lines").toBeGreaterThan(6 * m.line);
    expect(m.scroll, "the context does not scroll").toBeGreaterThan(m.client + 1);
    const fill = await analysis.evaluate((el) => {
      const cs = getComputedStyle(el);
      const kids = [...el.children] as HTMLElement[];
      const span = kids[kids.length - 1].getBoundingClientRect().bottom - kids[0].getBoundingClientRect().top;
      const sideways = el.querySelector<HTMLElement>(".sideways")!.getBoundingClientRect().height;
      const recommendation = el.querySelector<HTMLElement>(".recommendation")!;
      return {
        span,
        inner: el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
        strip: parseFloat(cs.getPropertyValue("--strip")),
        sideways,
        recommendationWhole: recommendation.scrollHeight <= recommendation.clientHeight + 1,
        minimums: [el.querySelector<HTMLElement>(".question-context")!, recommendation].map((r) => {
          const rs = getComputedStyle(r);
          return 2 * (parseFloat(rs.lineHeight) || 1.2 * parseFloat(rs.fontSize)) + parseFloat(rs.paddingTop) + parseFloat(rs.paddingBottom) + parseFloat(rs.borderTopWidth) + parseFloat(rs.borderBottomWidth);
        }),
        heights: [el.querySelector<HTMLElement>(".question-context")!.getBoundingClientRect().height, recommendation.getBoundingClientRect().height],
        recommendationBottom: recommendation.getBoundingClientRect().bottom,
        bottom: el.getBoundingClientRect().bottom,
      };
    });
    expect(fill.sideways, "the columns' strip").toBeGreaterThanOrEqual(fill.strip - 1);
    expect(fill.recommendationBottom, "the recommendation leaves the analysis").toBeLessThanOrEqual(fill.bottom + 1);
    // Decision Q1: where both texts are longer than the room the strip leaves, they share it equally, unless one text's
    // own minimum (two lines plus its region's padding, W4-R1-1) is more than half of that room (P1-R1-1).
    const halfRoom = (fill.heights[0] + fill.heights[1]) / 2;
    if (!fill.recommendationWhole && Math.max(...fill.minimums) <= halfRoom) expect(Math.abs(fill.heights[0] - fill.heights[1]), "the context and the recommendation do not share the room equally").toBeLessThanOrEqual(1);
    if (!fill.recommendationWhole && Math.max(...fill.minimums) > halfRoom) expect(Math.abs(fill.heights[1] - Math.max(...fill.minimums)), "the recommendation is not at its own minimum").toBeLessThanOrEqual(1);
    expect(Math.abs(fill.span - fill.inner), "room is left empty while the context is cut").toBeLessThanOrEqual(1);
    await page.getByRole("group", { name: "Proposed answers" }).getByRole("button", { name: /SQLite/ }).click();
    await expect(analysis).toBeHidden();
  });

  test("(L24a) the same context at 1280 × 1100 is shown whole", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1100 });
    const analysis = await openAnalysis(page);
    const m = await analysis.locator(".question-context").evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
    expect(m.client, "the context is cut").toBeGreaterThanOrEqual(m.scroll - 1);
    await page.getByRole("group", { name: "Proposed answers" }).getByRole("button", { name: /SQLite/ }).click();
    await expect(analysis).toBeHidden();
  });

  // The task of L21, by the developer's decision at the stop of execution phase 1: in a short wide window the analysis
  // gives up height (it once kept its minimum total, W3-R1-1 and decision G-R1-2), so that the question and the first
  // answer are in view together; nothing in it is clipped outside its own box.
  test("(L27) the analysis at 1280 × 400 yields: the question and the first answer in view, the question and the recommendation inside the analysis", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 400 });
    const analysis = await openAnalysis(page);
    await questionWithFirstAnswer(page, analysis, 400);
    const area = await box(analysis);
    for (const [name, part] of [["the question", analysis.locator(".question-text")], ["the recommendation", analysis.locator(".recommendation")]] as const) {
      if (!(await part.isVisible())) continue;
      const b = await box(part);
      expect(b.y, `${name}'s top is above the analysis`).toBeGreaterThanOrEqual(area.y - 1);
      expect(b.y + b.height, `${name} is below the analysis's end`).toBeLessThanOrEqual(area.y + area.height + 1);
    }
    await page.getByRole("group", { name: "Proposed answers" }).getByRole("button", { name: /SQLite/ }).click();
    await expect(analysis).toBeHidden();
  });

  test("(L11) the analysis at 390 × 844: one column in view, the other reached by scrolling sideways, no page overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const analysis = await openAnalysis(page);
    await expect(analysis.getByText("Scroll sideways to see every option.")).toBeVisible();
    const first = await box(analysis.locator(".column").nth(0));
    expect(first.width).toBeGreaterThanOrEqual(320);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page overflows horizontally").toBe(true);
    const second = analysis.locator(".column").nth(1);
    await second.scrollIntoViewIfNeeded();
    const shown = await box(second);
    expect(shown.x).toBeGreaterThanOrEqual(0);
    expect(shown.x + shown.width).toBeLessThanOrEqual(390 + 1);
    await page.getByRole("group", { name: "Proposed answers" }).getByRole("button", { name: /SQLite/ }).click();
    await expect(analysis).toBeHidden();
  });

  test("(L12) the analysis at 360 × 640: a message asks for a wider window, and the question can be answered", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    const analysis = await openAnalysis(page);
    await expect(analysis.getByRole("alert")).toHaveText(/at least 390 pixels wide/);
    await expect(analysis.locator(".column")).toHaveCount(0);
    await questionAndNoticeInside(analysis);
    await page.getByRole("group", { name: "Proposed answers" }).getByRole("button", { name: /SQLite/ }).click();
    await expect(analysis).toBeHidden();
  });

  // Work review 2 (W2-R1-1): below 390 px the long context is bounded by the room left, so the question and the notice
  // stay inside the analysis, and the context scrolls for the rest.
  test("(L12a) a long context at 360 × 800: the question and the notice stay inside the analysis, and the context scrolls", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const analysis = await openAnalysis(page);
    await expect(analysis.getByRole("alert")).toHaveText(/at least 390 pixels wide/);
    await questionAndNoticeInside(analysis);
    const m = await analysis.locator(".question-context").evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
    expect(m.scroll, "the context does not scroll").toBeGreaterThan(m.client + 1);
    await page.getByRole("group", { name: "Proposed answers" }).getByRole("button", { name: /SQLite/ }).click();
    await expect(analysis).toBeHidden();
  });
});

test.describe("the tests of the decideLong server, in order", () => {
  test.describe.configure({ mode: "default" });

  // W1-R1-3, issue #81: a recommendation of several paragraphs has a region of its own below the columns, outside their
  // scrollers; it does not squeeze them below their strip, and its end is reached inside its own region.
  test("(L13) a long recommendation at 1280 × 800: the columns keep their height, and the recommendation's end can be scrolled into view", async ({ page }) => {
    const parts = await openLongAnalysis(page, 1280, 800);
    const strip = await parts.analysis.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue("--strip")));
    expect(strip, "the strip").toBeGreaterThan(0);
    expect((await box(parts.sideways)).height, "the columns' region keeps its strip").toBeGreaterThanOrEqual(strip - 1);
    expect(await parts.recommendation.evaluate((el) => el.closest(".sideways, .column") === null), "the recommendation is outside the columns' scrollers").toBe(true);
    expect((await box(parts.recommendation)).y, "the recommendation is below the columns").toBeGreaterThanOrEqual((await box(parts.sideways)).y + (await box(parts.sideways)).height - 1);
    const last = parts.analysis.getByText("The last paragraph of the recommendation.");
    await parts.recommendation.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    const [end, region] = [await box(last), await box(parts.recommendation)];
    expect(end.y).toBeGreaterThanOrEqual(region.y - 1);
    expect(end.y + end.height).toBeLessThanOrEqual(region.y + region.height + 1);
    await answerDismisses(page, parts);
  });

  // W4-R1-1 of work review 4: in a short wide window both long texts are cut to their minimums, and each still shows two
  // lines inside its own region's padding, the recommendation's padding being larger than the context's.
  // The task of L21: at 1280 × 400 the floor does not fit beside the first answer, and the analysis yields in order.
  test("(L27a) at 1280 × 400 the analysis yields in order: the columns, then the recommendation, then the context", async ({ page }) => {
    const parts = await openLongAnalysis(page, 1280, 400);
    await questionWithFirstAnswer(page, parts.analysis, 400);
    await yieldOrder(parts.analysis);
    await answerDismisses(page, parts);
  });

  // Decision G-R1-2: at 390 × 844 the analysis's minimum total and the answer controls exceed the window, so the run
  // scrolls, and the controls are reached by scrolling it (reachable, below).
  test("(L14) a long analysis at 390 × 844: it scrolls inside itself, and the answer controls can be reached", async ({ page }) => {
    const parts = await openLongAnalysis(page, 390, 844);
    // Issue #81: the analysis scrolls inside itself, in a column's own scroller (its entry opened, issue #87), and the
    // recommendation's end is reached inside the recommendation's own region.
    await parts.analysis.getByRole("button", { name: /^Show the reasoning of Advantage 1:/ }).click();
    await expect.poll(() => someColumnOverflows(parts), { message: "no column scrolls inside itself" }).toBe(true);
    const last = parts.analysis.getByText("The last paragraph of the recommendation.");
    await parts.recommendation.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    const [end, region] = [await box(last), await box(parts.recommendation)];
    expect(end.y).toBeGreaterThanOrEqual(region.y - 1);
    expect(end.y + end.height).toBeLessThanOrEqual(region.y + region.height + 1);
    expect(await parts.run.evaluate((el) => el.scrollTop), "the run scrolled to show the recommendation").toBe(0);
    await expect(page.getByRole("button", { name: new RegExp(LEFT) })).toHaveCount(0);
    await expect(page.getByRole("button", { name: new RegExp(RIGHT) })).toHaveCount(0);
    await separateAndWhole(parts);
    await reachable(parts);
    await answerDismisses(page, parts);
  });

  // The task of L21, by the developer's decision at the stop of execution phase 1: in a short window the analysis gives
  // up height so that the question and the first answer are in view together; the controls below the first answer are
  // reached by scrolling. Its columns have no height left at this size, so no column is opened here.
  test("(L15) a long analysis at 640 × 400: the analysis yields, the question and the first answer are in view, and the answer controls can be reached", async ({ page }) => {
    const parts = await openLongAnalysis(page, 640, 400);
    await questionWithFirstAnswer(page, parts.analysis, 400);
    await yieldOrder(parts.analysis);
    await separateAndWhole(parts);
    await reachable(parts);
    await answerDismisses(page, parts);
  });

  test("(L16) a long analysis at 390 × 600 with the progress opened: the analysis yields, the question and the first answer are in view, and the answer controls can be reached", async ({ page }) => {
    // The task of L21: at 600 px the floor does not fit beside the first answer even with the progress closed (a room of
    // 326 px against a minimum total of about 330), so the analysis yields here too.
    const parts = await openLongAnalysis(page, 390, 600);
    await page.locator("details.progress > summary, details.progress summary").first().click();
    await expect(page.locator("details.progress")).toHaveAttribute("open", "");
    await questionWithFirstAnswer(page, parts.analysis, 600);
    // Opening the progress changes the room the analysis is allotted, so its measurements are retried until it settles.
    await expect(async () => {
      await yieldOrder(parts.analysis);
      await separateAndWhole(parts);
    }).toPass({ timeout: 60_000 });
    await reachable(parts);
    await answerDismisses(page, parts);
  });

  // Issue #81: each column scrolls on its own inside the region that scrolls sideways; decision Q1: the strip is measured
  // from the closed columns, so opening entries, here or in another tab, moves nothing above or below the columns.
  test("(L26) each column scrolls on its own; the regions above and below keep their heights whatever is open", async ({ context, page }) => {
    const parts = await openLongAnalysis(page, 1280, 800);
    const heights = () => Promise.all([parts.analysis.locator(".question-context"), parts.recommendation].map(async (l) => Math.round((await box(l)).height)));
    const closed = await heights();
    await parts.analysis.getByRole("button", { name: /^Show the reasoning of Advantage 1:/ }).click();
    expect(await heights(), "opening an entry moved the regions above or below the columns").toEqual(closed);
    const [long, short] = [parts.columns.nth(0), parts.columns.nth(1)];
    await expect.poll(() => long.evaluate((el) => el.scrollHeight > el.clientHeight + 1), { message: "the long column does not scroll on its own" }).toBe(true);
    const [l, w] = [await box(long), await box(parts.sideways)];
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
    // An entry open in another tab when this one loads, and a resize with it open: the same heights.
    const other = await context.newPage();
    await other.setViewportSize({ width: 1280, height: 800 });
    await other.goto(layoutUrl("decideLong"));
    await expect(other.getByRole("region", { name: /^Decision 1: / })).toBeVisible();
    await page.reload();
    await expect(parts.analysis.getByRole("button", { name: /^Hide the reasoning of Advantage 1:/ })).toBeVisible();
    expect(await heights(), "an entry open from another tab moved the regions").toEqual(closed);
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(heights, { message: "a resize with an entry open moved the regions" }).toEqual(closed);
    await other.close();
    await answerDismisses(page, parts);
  });

  // Decision Q1: a closed column shorter than ten lines in a tall window is its own strip, measured from its content,
  // not from its scroller, whichever entries are open.
  test("(L26) short closed columns in a tall window: the strip is the tallest column's closed content", async ({ context, page }) => {
    const parts = await openLongAnalysis(page, 1280, 1400);
    const read = () =>
      parts.analysis.evaluate((el) => {
        const strip = parseFloat(getComputedStyle(el).getPropertyValue("--strip"));
        const contents = [...el.querySelectorAll<HTMLElement>(".column")].map((c) => {
          const cs = getComputedStyle(c);
          const inner = c.querySelector<HTMLElement>(".column-content")!;
          const bodies = [...inner.querySelectorAll<HTMLElement>(".elements")].reduce((n, b) => n + b.getBoundingClientRect().height + parseFloat(getComputedStyle(b).marginTop) + parseFloat(getComputedStyle(b).marginBottom), 0);
          return inner.offsetHeight + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) - bodies;
        });
        const line = (parseFloat(getComputedStyle(el.querySelector(".question-context")!).lineHeight) || 1.2 * parseFloat(getComputedStyle(el.querySelector(".question-context")!).fontSize));
        return { strip, closed: Math.max(...contents), ten: 10 * line };
      });
    const first = await read();
    expect(first.closed, "the closed columns are shorter than ten lines").toBeLessThan(first.ten);
    expect(Math.abs(first.strip - first.closed), "the strip is not the closed columns' content").toBeLessThanOrEqual(1);
    const other = await context.newPage();
    await other.setViewportSize({ width: 1280, height: 1400 });
    await other.goto(layoutUrl("decideLong"));
    await other.getByRole("region", { name: /^Decision 1: / }).getByRole("button", { name: /^(Show|Hide) the reasoning of Advantage 1:/ }).first().click();
    await page.reload();
    await expect(parts.analysis.getByRole("button", { name: /^Hide the reasoning of Advantage 1:/ })).toBeVisible();
    expect(Math.abs((await read()).strip - first.strip), "an entry open from another tab changed the strip").toBeLessThanOrEqual(1);
    await other.close();
    await answerDismisses(page, parts);
  });

  // S39 (W2-R1-2): beside an analysis only the context scrolls; the question text stays in view with the first answer card,
  // before and after the context is scrolled to its end, and the answer controls remain reachable.
  for (const [width, height] of [[390, 844], [640, 400]] as const) {
    test(`(L20) a long context beside the analysis at ${width} × ${height}: the question stays in view with the first answer`, async ({ page }) => {
      const parts = await openLongAnalysis(page, width, height);
      const context = parts.analysis.locator(".question-context");
      const question = parts.analysis.locator(".question-text");
      const firstCard = page.getByRole("group", { name: "Proposed answers" }).getByRole("button").first();
      const overflow = await context.evaluate((el) => el.scrollHeight - el.clientHeight);
      expect(overflow, "the context overflows its region").toBeGreaterThan(0);
      expect(await question.evaluate((el) => el.closest(".question-context") === null), "the question is outside the scrolled context").toBe(true);
      const within = async (what: string, parts: readonly (readonly [string, Locator])[]) => {
        for (const [name, part] of parts) {
          const b = await box(part);
          expect(b.y, `${what}: ${name}'s top`).toBeGreaterThanOrEqual(-1);
          expect(b.y + b.height, `${what}: ${name} is below the window`).toBeLessThanOrEqual(height + 1);
        }
      };
      // Decision G-R1-2 (the grown analysis wins): at 640 × 400 the analysis keeps its minimum total, so the question is
      // in the window with its context region, and the first answer comes into the window when the page is scrolled to it.
      const inView = async (what: string) => {
        if (height === 400) {
          await question.scrollIntoViewIfNeeded();
          await within(what, [["the question", question], ["the context region", context]]);
          await firstCard.scrollIntoViewIfNeeded();
          await within(what, [["the first answer", firstCard]]);
          return;
        }
        await firstCard.scrollIntoViewIfNeeded();
        await within(what, [["the question", question], ["the first answer", firstCard]]);
      };
      await inView("before scrolling the context");
      await context.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
      await expect.poll(() => context.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await inView("after scrolling the context to its end");
      await separateAndWhole(parts);
      await reachable(parts);
      await answerDismisses(page, parts);
    });
  }
});

test.describe("the tests of the planSteps server, in order", () => {
  test.describe.configure({ mode: "default" });

  // Issue #6: a step's long text scrolls inside its tooltip, which stays in the viewport, in a desktop window and, with the
  // progress opened, in a phone-sized one.
  for (const [width, height] of [[1280, 800], [390, 844]] as const) {
    test(`(L17) a long step text at ${width} × ${height}: the tooltip stays in the viewport and scrolls inside itself`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await startTask(page, "Build the rail", layoutUrl("planSteps"));
      if (width < 840) {
        await page.locator("details.progress > summary, details.progress summary").first().click();
        await expect(page.locator("details.progress")).toHaveAttribute("open", "");
      }
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
    await startTask(page, "Build the rail", layoutUrl("planSteps"));
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
});

test.describe("the tests of the longQuestion server, in order", () => {
  test.describe.configure({ mode: "default" });

  for (const [width, height] of [[390, 844], [640, 400], [1280, 800]] as const) {
    test(`(L19) a long question at ${width} × ${height}: the question and its first option in view, each region scrolls on its own`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await startTask(page, `Choose a database at ${width}`, LONG_QUESTION_URL);
      const question = pane(page).locator(".question-text");
      await expect(question).toBeInViewport();
      const first = pane(page).getByRole("group", { name: "Proposed answers" }).getByRole("button").first();
      await expect(first).toBeInViewport({ ratio: 0.1 });
      // The transcript is not what the user reads while the question waits (issue #20).
      await expect(panel(page, LEFT)).toBeHidden();
      for (const region of [pane(page).locator(".top"), pane(page).locator(".bottom")]) {
        const scrolls = await region.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
          el.dispatchEvent(new Event("scroll"));
          return el.scrollHeight > el.clientHeight;
        });
        expect(scrolls, "the region holds more than it shows").toBe(true);
        await expect(question).toBeInViewport();
      }
      for (const name of ["[name=answer]", "button[name=send]"]) {
        await page.locator(name).scrollIntoViewIfNeeded();
        await expect(page.locator(name)).toBeInViewport();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page overflows horizontally").toBe(true);
      // The pointer is left where Start was clicked; a term may lie under it now and its tooltip cover the answer.
      await page.mouse.move(0, 0);
      await continueWithoutDeciding(page).click();
      await expect(panel(page, LEFT).getByText(/finished after 1 implementation phase/)).toBeVisible();
    });
  }
});

test.describe("the tests of the longContextShortAnswers server, in order", () => {
  test.describe.configure({ mode: "default" });

  // Issue #79 (P2-R1-1): in a tall window the question pane's context takes the room its answers leave, instead of 30 %
  // of the pane: with short answers, the whole context is shown, and no room stays empty below the answers.
  test("(L25) a long context with short answers at 1280 × 1700: the pane's content fits, and the context is whole", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1700 });
    await startTask(page, "Choose a database at 1700", layoutUrl("longContextShortAnswers"));
    await expect(pane(page).locator(".question-text")).toBeInViewport();
    const m = await pane(page).evaluate((el) => {
      const cs = getComputedStyle(el);
      const t = el.querySelector<HTMLElement>(".top")!;
      const bottom = el.querySelector<HTMLElement>(".bottom")!;
      const kids = [...el.children] as HTMLElement[];
      const gaps = parseFloat(cs.rowGap || cs.gap) * (kids.length - 1);
      const content = kids.reduce((n, k) => n + (k === t ? t.scrollHeight : k === bottom ? bottom.scrollHeight : k.getBoundingClientRect().height), 0);
      const inner = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const last = bottom.lastElementChild!.getBoundingClientRect().bottom;
      return { content: content + gaps, inner, client: t.clientHeight, scroll: t.scrollHeight, free: el.getBoundingClientRect().bottom - parseFloat(cs.paddingBottom) - last };
    });
    expect(m.content, "the pane's content does not fit, so the test cannot show the context whole").toBeLessThanOrEqual(m.inner + 1);
    expect(m.client, "the context is cut").toBeGreaterThanOrEqual(m.scroll - 1);
    expect(m.client >= m.scroll - 1 || m.free <= 1, "the context is cut while empty room stays below the answers").toBe(true);
    await continueWithoutDeciding(page).click();
    await expect(panel(page, LEFT).getByText(/finished after 1 implementation phase/)).toBeVisible();
  });
});

test.describe("the tests of the permissionLong server, in order", () => {
  test.describe.configure({ mode: "default" });
  for (const [width, height] of [[390, 844], [640, 400]] as const) {
    test(`(L21) a permission request with a 40-line command at ${width} × ${height}: the question and the first option in view`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await startTask(page, `Prepare the build at ${width}`, PERMISSION_URL);
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
      await together("in the question pane", question);
      // The whole command is in the details, reached by scrolling the region above the question.
      const top = pane(page).locator(".top");
      await expect(top).toContainText("line 40 of a long command");
      // The command is one element among others in the details, and it is not the last of them: scrolling the region to
      // its end shows what follows the command, not the command's last line. Bring the command's own end into view.
      const command = top.locator("pre").filter({ hasText: "line 40 of a long command" });
      await command.evaluate((el) => el.scrollIntoView({ block: "end" }));
      await expect(command).toBeInViewport();
      await together("after scrolling the details", question);
      await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
      const analysis = page.getByRole("region", { name: /^Decision 1: / });
      await expect(analysis).toBeVisible();
      await together("beside the analysis", analysis.locator(".question-text"));
      await firstOption().click();
      await expect(panel(page, LEFT).getByText(/finished after 1 implementation phase/)).toBeVisible();
    });
  }
  // Issue #73: the page names Liberation, installed in Regular, Bold, Italic and Bold Italic in the developer's browser,
  // the CI runner and the development container. A declared family that is not installed falls through silently, so the
  // test reads the faces the renderer used (Chrome DevTools Protocol), not the declared font-family. Code keeps the size
  // it had under the bare monospace family, 13/16 of its parent's, so that naming a family moves none of the commands the
  // layout tests measure.
  test("(L28) the page renders in Liberation: body text, bold text and code, at the sizes it had", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await startTask(page, "Prepare the build in Liberation", PERMISSION_URL);
    await expect(pane(page).locator(".question-text")).toContainText("Do you want to allow it?");
    const families = (fonts: readonly UsedFont[]) => [...new Set(fonts.map((f) => f.familyName))];
    expect(families(await usedFont(page, "section.pane .question-text")), "the question's text").toEqual(["Liberation Sans"]);
    expect((await usedFont(page, "section.pane .option-label strong")).map((f) => f.postScriptName), "a bold option label").toEqual(["LiberationSans-Bold"]);
    expect(families(await usedFont(page, "section.pane .top li > code")), "inline code").toEqual(["Liberation Mono"]);
    expect(families(await usedFont(page, "section.pane .top pre > code")), "a code block").toEqual(["Liberation Mono"]);
    const sizes = await pane(page).locator(".top").evaluate((top) =>
      [...top.querySelectorAll("li > code, li > pre")].map((el) => ({ tag: el.tagName, own: parseFloat(getComputedStyle(el).fontSize), parent: parseFloat(getComputedStyle(el.parentElement!).fontSize) })),
    );
    expect(sizes.length, "the details hold code").toBeGreaterThan(0);
    for (const s of sizes) expect(Math.abs(s.own - (s.parent * 13) / 16), `${s.tag} is ${s.own} px under a parent of ${s.parent} px`).toBeLessThanOrEqual(0.5);
    await page.getByRole("group", { name: "Proposed answers" }).getByRole("button").first().click();
    await expect(panel(page, LEFT).getByText(/finished after 1 implementation phase/)).toBeVisible();
  });
  // The developer's decision at the stop of execution phase 1 of the task of L21: where the analysis box is too short for
  // its heading and its question, the heading stays on one line beside its "Show conversation" button, its words cut
  // with an ellipsis where the line is too narrow and its whole text shown on hover (its title).
  for (const [width, height, cut] of [[640, 400, true], [390, 844, true], [1280, 800, false]] as const) {
    test(`(L29) the analysis's heading stays on one line beside its button at ${width} × ${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await startTask(page, `Prepare the build with a one-line heading at ${width}`, PERMISSION_URL);
      await expect(pane(page).locator(".question-text")).toContainText("Do you want to allow it?");
      await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
      const analysis = page.getByRole("region", { name: /^Decision 1: / });
      await expect(analysis).toBeVisible();
      const m = await analysis.evaluate((el) => {
        const head = el.querySelector<HTMLElement>(".head")!;
        const h2 = head.querySelector("h2")!;
        const button = head.querySelector("button")!;
        return { row: head.getBoundingClientRect().height, button: button.getBoundingClientRect().height, title: h2.getAttribute("title"), name: el.getAttribute("aria-label"), cut: h2.scrollWidth > h2.clientWidth, overflow: getComputedStyle(h2).textOverflow };
      });
      expect(m.row, "the heading's row is taller than its button").toBeLessThanOrEqual(m.button + 1);
      expect(m.title, "the heading's whole text on hover").toBe(m.name);
      if (cut) {
        expect(m.cut, "the heading is cut at this width").toBe(true);
        expect(m.overflow, "the cut heading ends in an ellipsis").toBe("ellipsis");
      } else expect(m.cut, "the heading is cut in a wide window").toBe(false);
      await page.getByRole("group", { name: "Proposed answers" }).getByRole("button").first().click();
      await expect(panel(page, LEFT).getByText(/finished after 1 implementation phase/)).toBeVisible();
    });
  }
  test("(L21a) a permission request at 640 × 400 beside the analysis: the question and the first answer in view with room to spare, the analysis within its own box", async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 400 });
    await startTask(page, "Prepare the build with room to spare", PERMISSION_URL);
    await expect(pane(page).locator(".question-text")).toContainText("Do you want to allow it?");
    await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
    const analysis = page.getByRole("region", { name: /^Decision 1: / });
    await expect(analysis).toBeVisible();
    await questionWithFirstAnswer(page, analysis, 400);
    await yieldOrder(analysis);
    const m = await analysis.evaluate((el) => {
      const own = (s: string) => {
        const r = el.querySelector<HTMLElement>(s);
        return r === null ? null : { rendered: r.getBoundingClientRect().height, inline: parseFloat(r.style.height) };
      };
      return { scroll: el.scrollHeight, client: el.clientHeight, context: own(".question-context"), recommendation: own(".recommendation") };
    });
    expect(m.scroll, "the analysis's content overflows its own box").toBeLessThanOrEqual(m.client + 1);
    for (const [name, r] of [["the context", m.context], ["the recommendation", m.recommendation]] as const) {
      if (r === null) continue;
      expect(Math.abs(r.rendered - r.inline), `${name} renders at ${r.rendered} px, not its allotted ${r.inline} px`).toBeLessThanOrEqual(1);
    }
    await page.getByRole("group", { name: "Proposed answers" }).getByRole("button").first().click();
    await expect(panel(page, LEFT).getByText(/finished after 1 implementation phase/)).toBeVisible();
  });
  // Finding W2-R1-1 of work review 2: a notice that appears while the analysis is shown takes room above the decision
  // area, and the room is measured again, so the question and the first answer stay in view without a resize. The
  // server sends a refusal only to the tab whose action it refuses, so no action of another tab gives this tab a
  // notice; the test delivers the server's own `refused` frame to the page through Playwright's WebSocket routing.
  test("(L21b) a notice that appears beside the analysis at 640 × 400: the question and the first answer stay in view", async ({ page }) => {
    let toPage: ((frame: string) => void) | null = null;
    await page.routeWebSocket(/\/\/127\.0\.0\.1:\d+/, (ws) => {
      ws.connectToServer();
      toPage = (frame) => ws.send(frame);
    });
    await page.setViewportSize({ width: 640, height: 400 });
    await startTask(page, "Prepare the build with a notice", PERMISSION_URL);
    await expect(pane(page).locator(".question-text")).toContainText("Do you want to allow it?");
    await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
    const analysis = page.getByRole("region", { name: /^Decision 1: / });
    await expect(analysis).toBeVisible();
    await questionWithFirstAnswer(page, analysis, 400);
    const reason = "a run is in progress; stop it or wait for its end";
    expect(toPage, "the page's WebSocket was not routed").not.toBeNull();
    toPage!(JSON.stringify({ type: "refused", reason }));
    await expect(page.getByRole("alert").filter({ hasText: reason })).toBeVisible();
    await questionWithFirstAnswer(page, analysis, 400);
    await page.getByRole("group", { name: "Proposed answers" }).getByRole("button").first().click();
    await expect(panel(page, LEFT).getByText(/finished after 1 implementation phase/)).toBeVisible();
  });
});

test.describe("the tests of the whitespace server, in order", () => {
  test.describe.configure({ mode: "default" });

  test("(L22) code in rendered Markdown keeps its whitespace: in the pane, beside an analysis and in the transcript", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await startTask(page, "Probe the whitespace", WHITESPACE_URL);
    await expect(pane(page).locator(".question-text")).toContainText("Do you want to allow it?");
    await distinctWidths("in the question pane", pane(page).locator(".top"));
    await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
    const analysis = page.getByRole("region", { name: /^Decision 1: / });
    await expect(analysis).toBeVisible();
    await distinctWidths("beside the analysis", analysis.locator(".question-context"));
    await page.getByRole("group", { name: "Proposed answers" }).getByRole("button").first().click();
    await expect(panel(page, LEFT).getByText(/finished after 1 implementation phase/)).toBeVisible();
    await distinctWidths("in the transcript", panel(page, LEFT).locator("article", { hasText: "Probe" }).last());
  });
});

test.describe("the tests of the transportLong server, in order", () => {
  test.describe.configure({ mode: "default" });

  for (const [width, height] of [[390, 844], [640, 400]] as const) {
    test(`(L23) the exhaustion pause after a long fault at ${width} × ${height}: the question and the first option in view`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await startTask(page, `Reach Codex at ${width}`, TRANSPORT_LONG_URL);
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
      await together("at the pause");
      const top = pane(page).locator(".top");
      await expect(top.locator("code")).toContainText("<endpoint> refused the connection");
      await top.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
      await expect(top.getByText(/END OF FAULT/)).toBeInViewport();
      await together("after scrolling the details");
      await firstOption().click();
      await expect(panel(page, LEFT).getByText(/finished after 1 implementation phase/)).toBeVisible();
    });
  }
});

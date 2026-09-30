import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { CONTINUE_WITHOUT_DECIDING, END_CLARIFICATION, HELP_ME_DECIDE, SHOW_CONVERSATION, SHOW_QUESTION } from "../src/prompts.ts";
import { LONG_ANSWERS } from "./longAnswers.ts";

// Finding 7 of docs/gui-review.md, decision Q3: the layout adapts. At M3's expanded width (840 px and wider) the rail
// and both panels are side by side; below it, one panel at a time, chosen by its title, with a badge for the other's
// new messages, and a prompt selects "You and Interloq". The "tabs" server asks two decisions in a row.
const URL = "http://127.0.0.1:8106/";
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
    if (await stop.isEnabled({ timeout: 1_000 }).catch(() => false)) {
      await stop.click({ timeout: 2_000 });
      // S38: the confirmation closes without acting if the run ends before it is confirmed, which the retry covers.
      await page.locator("dialog[open] button[name=confirm-end]").click({ timeout: 2_000 }).catch(() => undefined);
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

// W2-R1-3 and P3-R1-1 (work review 2 and planning 3): a panel keeps its reading position across a switch and a resize,
// and a panel that was hidden follows its end when it is shown again, unless the user had scrolled it up.
const LONG_URL = "http://127.0.0.1:8108/";
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
  await expect(continueWithoutDeciding(page)).toBeVisible({ timeout: 60_000 });
  await pane(page).getByRole("button", { name: SHOW_CONVERSATION }).click();
};
/** Back to the question from the conversation, and the answer that continues the run. */
const answerContinue = async (page: Page) => {
  await page.getByRole("button", { name: SHOW_QUESTION }).click();
  await continueWithoutDeciding(page).click();
};

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

// Issue #12: an interview's numbered answers that run to a paragraph each are cards that hold their full text, in a
// narrow and in a wide window; a card is a native button, chosen by keyboard, and the transcript keeps the full line.
const LONG_CHOICES_URL = "http://127.0.0.1:8110/";
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

// Decision support (decision Q5): one column per option at every allowed width, side by side when they fit, scrolling
// sideways when they do not; below 390 px a message instead.
const DECIDE_URL = "http://127.0.0.1:8111/";
const openAnalysis = async (page: Page) => {
  await startTask(page, "Add a database", DECIDE_URL);
  await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
  const analysis = page.getByRole("region", { name: /^Decision 1: / });
  await expect(analysis).toBeVisible();
  return analysis;
};
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
  await page.getByRole("group", { name: "Proposed answers" }).getByRole("button", { name: /SQLite/ }).click();
  await expect(analysis).toBeHidden();
});

// W1-R1-3: a recommendation of several paragraphs scrolls with the columns and does not squeeze them.
test("(L13) a long recommendation at 1280 × 800: the columns keep their height, and the recommendation's end can be scrolled into view", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await startTask(page, "Add a database", "http://127.0.0.1:8112/");
  await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
  const analysis = page.getByRole("region", { name: /^Decision 1: / });
  await expect(analysis).toBeVisible();
  expect((await box(analysis.locator(".column").nth(0))).height).toBeGreaterThanOrEqual(200);
  const last = analysis.getByText("The last paragraph of the recommendation.");
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  const [end, area] = [await box(last), await box(analysis)];
  expect(end.y + end.height).toBeLessThanOrEqual(area.y + area.height + 1);
  await page.getByRole("group", { name: "Proposed answers" }).getByRole("button", { name: /SQLite/ }).click();
  await expect(analysis).toBeHidden();
});

// W4-R1-1: in the compact layout a long analysis scrolls inside a bounded area, and the answer controls stay in view
// (a tall window) or can be scrolled into the run's view (a short window, or the progress opened), never overlapping
// the analysis or each other and never clipped.
const openLongAnalysis = async (page: Page, width: number, height: number) => {
  await page.setViewportSize({ width, height });
  await startTask(page, "Add a database", "http://127.0.0.1:8112/");
  await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
  const analysis = page.getByRole("region", { name: /^Decision 1: / });
  await expect(analysis).toBeVisible();
  return {
    analysis,
    run: page.locator("main.run"),
    area: page.locator(".decision-area"),
    scroll: analysis.locator(".scroll"),
    prompt: page.locator("section.pane"),
    activity: page.locator("[data-activity]"),
  };
};
type Parts = Awaited<ReturnType<typeof openLongAnalysis>>;
/** The height of the decision area's floor, min(12rem, 40dvh), in this window. */
const floorOf = (page: Page) => page.evaluate(() => Math.min(12 * parseFloat(getComputedStyle(document.documentElement).fontSize), 0.4 * window.innerHeight));
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

test("(L14) a long analysis at 390 × 844: it scrolls inside itself, and the answer controls are in view", async ({ page }) => {
  const parts = await openLongAnalysis(page, 390, 844);
  const run = await parts.run.evaluate((el) => ({ top: el.scrollTop, scroll: el.scrollHeight, client: el.clientHeight }));
  expect(run.top).toBe(0);
  expect(run.scroll, "the run scrolls").toBeLessThanOrEqual(run.client + 1);
  for (const [name, part] of [["the prompt", parts.prompt], ["the activity line", parts.activity]] as const) {
    const b = await box(part);
    expect(b.y, `${name}'s top`).toBeGreaterThanOrEqual(0);
    expect(b.y + b.height, `${name} is below the window`).toBeLessThanOrEqual(844 + 1);
  }
  const inner = await parts.scroll.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(inner.scroll, "the analysis does not scroll inside itself").toBeGreaterThan(inner.client);
  const last = parts.analysis.getByText("The last paragraph of the recommendation.");
  await last.scrollIntoViewIfNeeded();
  const [end, scroll] = [await box(last), await box(parts.scroll)];
  expect(end.y).toBeGreaterThanOrEqual(scroll.y - 1);
  expect(end.y + end.height).toBeLessThanOrEqual(scroll.y + scroll.height + 1);
  expect(await parts.run.evaluate((el) => el.scrollTop), "the run scrolled to show the recommendation").toBe(0);
  await expect(page.getByRole("button", { name: new RegExp(LEFT) })).toHaveCount(0);
  await expect(page.getByRole("button", { name: new RegExp(RIGHT) })).toHaveCount(0);
  await separateAndWhole(parts);
  await answerDismisses(page, parts);
});

test("(L15) a long analysis at 640 × 400: the analysis stays at its floor, and the answer controls can be reached", async ({ page }) => {
  const parts = await openLongAnalysis(page, 640, 400);
  const floor = await floorOf(page);
  expect((await box(parts.area)).height, "the decision area grows beyond its floor").toBeLessThanOrEqual(floor + 1);
  const inner = await parts.scroll.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(inner.scroll, "the analysis does not scroll inside itself").toBeGreaterThan(inner.client);
  await separateAndWhole(parts);
  await reachable(parts);
  await answerDismisses(page, parts);
});

test("(L16) a long analysis at 390 × 600 with the progress opened: the analysis stays at its floor, and the answer controls can be reached", async ({ page }) => {
  // At 844 px the scenario's short timeline leaves the controls and the floor room enough; at 600 px they do not.
  const parts = await openLongAnalysis(page, 390, 600);
  await page.locator("details.progress > summary, details.progress summary").first().click();
  await expect(page.locator("details.progress")).toHaveAttribute("open", "");
  const floor = await floorOf(page);
  expect((await box(parts.area)).height, "the decision area grows beyond its floor").toBeLessThanOrEqual(floor + 1);
  await separateAndWhole(parts);
  await reachable(parts);
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
    const inView = async (what: string) => {
      await firstCard.scrollIntoViewIfNeeded();
      for (const [name, part] of [["the question", question], ["the first answer", firstCard]] as const) {
        const b = await box(part);
        expect(b.y, `${what}: ${name}'s top`).toBeGreaterThanOrEqual(-1);
        expect(b.y + b.height, `${what}: ${name} is below the window`).toBeLessThanOrEqual(height + 1);
      }
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

// Issue #6: a step's long text scrolls inside its tooltip, which stays in the viewport, in a desktop window and, with the
// progress opened, in a phone-sized one.
for (const [width, height] of [[1280, 800], [390, 844]] as const) {
  test(`(L17) a long step text at ${width} × ${height}: the tooltip stays in the viewport and scrolls inside itself`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await startTask(page, "Build the rail", "http://127.0.0.1:8115/");
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
  await startTask(page, "Build the rail", "http://127.0.0.1:8115/");
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

// S29 (Q10, issue #20): a question with a long context, many terms and long options keeps the question and its first
// option in view together at every supported size; each region scrolls on its own to its end with the question still in
// view, and the answer controls can be reached.
const LONG_QUESTION_URL = "http://127.0.0.1:8118/";
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
    await continueWithoutDeciding(page).click();
    await expect(panel(page, LEFT).getByText(/finished after 1 implementation phase/)).toBeVisible();
  });
}

// S49 (W4-R1-1): a permission request whose command runs to 40 lines keeps its question and first option in view together,
// in the question pane and beside a decision's analysis; the command is read by scrolling the details.
const PERMISSION_URL = "http://127.0.0.1:8119/";
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

// (L22) S51 (W3-R1-2 of work review 5): code in rendered Markdown keeps its whitespace visually. A code element's text
// keeps every space, but the browser's default white-space collapses runs and drops the spaces at the edges, so
// "a b", "a  b" and "a<tab>b" would look alike and " a " like "a". Measured in the question pane, beside an analysis and
// in the transcript's answered exchange.
const WHITESPACE_URL = "http://127.0.0.1:8120/";
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

// (L23) S52 (W5-R1-1): the exhaustion pause after a fault of 2,500 characters. The question names the agent and the call
// only; the attempts and the whole fault, <endpoint> included (shown literally, P6-R1-1), are in the details above it.
const TRANSPORT_LONG_URL = "http://127.0.0.1:8121/";
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

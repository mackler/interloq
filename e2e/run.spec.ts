import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { phaseName } from "../src/uiEvents.ts";
import { type RunScenario, runUrl } from "./ports.ts";
import { ownName } from "../src/hostDir.ts";
import { tabTitle } from "../web/src/title.ts";
import { endNotificationTitle, pauseNotificationTitle, clarificationHeading, interviewHelp, ENTRY_DISPUTED_LABEL, AGREED_REASON_HEADING, confirmEndText, questionTitle, CONFIRM_SUMMARY_LABEL, CONTINUE_WITHOUT_DECIDING, END_CLARIFICATION, HELP_ME_DECIDE, loopSummary, SHOW_CONVERSATION, SHOW_QUESTION, transportRetryLine, UNCHANGED_PROCEED, PLAN_STEP_STATE_LABEL, planStepLabel, RAIL_CONDITION_LABEL, railToggleName, stageHeading, stepLabel } from "../src/prompts.ts";

// Plan step 5.2: the page against the server over scripted agents (e2e/server.ts), one server per scenario. Every test
// fails on an uncaught error or a console error in any of its pages (e2e/fixtures.ts, finding 10 of docs/gui-review.md).
type Scenario = RunScenario;
const url = runUrl;
const left = (page: Page) => page.getByRole("region", { name: "You and Interloq" });
const right = (page: Page) => page.getByRole("region", { name: "Claude and Codex" });
const rail = (page: Page) => page.getByRole("navigation", { name: "Progress of the run" });
/** The question the run waits on, which takes the left column while it is pending (S27). */
const pane = (page: Page) => page.locator("section.pane");
const asking = (page: Page, text: string) => pane(page).locator(".question-text", { hasText: text });
const DATABASE = "Which database should the service use?";
const CACHE = "Which cache should the service use?";
const option = (page: Page, name: string | RegExp) => pane(page).getByRole("group", { name: "Proposed answers" }).getByRole("button", { name });
const continueWithoutDeciding = (page: Page) => pane(page).getByRole("button", { name: CONTINUE_WITHOUT_DECIDING, exact: true });
/** Confirms the ending of the run in the page's dialog (S25). */
const confirmEnd = (page: Page) => page.locator("dialog[open] button[name=confirm-end]").click();

type Edges = { left: number; right: number };
/** The horizontal edges of an element's content box: less its padding and, on the right, any scrollbar (P1-R2-2). */
const contentEdges = (el: Locator): Promise<Edges> =>
  el.evaluate((e) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    const left = r.left + e.clientLeft;
    return { left: left + parseFloat(cs.paddingLeft), right: left + e.clientWidth - parseFloat(cs.paddingRight) };
  });
const edges = (el: Locator): Promise<Edges> => el.evaluate((e) => ({ left: e.getBoundingClientRect().left, right: e.getBoundingClientRect().right }));
/**
 * Issue #2: a message lies on the named side of the content box of the element it is laid out in (its phase's band, or
 * the panel's list before any phase, issue #15), within 2 px; `container` is the region it is looked up in.
 */
const onSide = async (message: Locator, container: Locator, side: "left" | "right") => {
  await expect(container.locator("xpath=.").first()).toBeVisible();
  const [m, c] = [await edges(message), await contentEdges(message.locator("xpath=.."))];
  expect(Math.abs(m[side] - c[side]), `${side} edge ${m[side]} against ${c[side]}`).toBeLessThanOrEqual(2);
};

/** Opens the page, returns to the form if a run has ended, and starts a task. */
const startTask = async (page: Page, scenario: Scenario, task: string) => {
  await page.goto(url(scenario));
  await expect(page.getByText("connected", { exact: true })).toBeVisible();
  // The form, an ended run, or a run left by an earlier test on the shared server, which is stopped first.
  await expect(page.locator("textarea[name=task], button[name=new], button[name=stop]:not([disabled])").first()).toBeVisible();
  await toTheForm(page);
  await page.locator("textarea[name=task]").fill(task);
  await page.locator("button[name=start]").click();
};
/** From the page as it is to the start form: a run left running is stopped and confirmed, an ended one left behind. */
const toTheForm = async (page: Page) => {
  const stop = page.locator("button[name=stop]");
  const again = page.locator("button[name=new]");
  const form = page.locator("textarea[name=task]");
  // Retried as a whole: the left run can end between the check and the click (it did on a loaded machine), after
  // which Stop stays disabled and a plain click would wait for the test's whole timeout.
  await expect(async () => {
    if (await form.isVisible()) return;
    // S34: a confirmation an earlier attempt opened and did not confirm (its click missed the window on a loaded
    // machine) stays open and intercepts every click on the page, Stop's included; it is confirmed first, not reopened.
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
};

// ---- Finding 10 of docs/gui-review.md ------------------------------------------------------------------------

test.describe("the tests of the converge server, in order", () => {
  test.describe.configure({ mode: "default" });

  test("(1) a run from the form: the timeline shows its phases and the right panel the agents' exchange", async ({ page }) => {
    await startTask(page, "converge", "Document the service");
    // Issue #6: one iteration, so the phases carry no number.
    await expect(rail(page).getByText("Planning", { exact: true })).toBeVisible();
    await expect(rail(page).getByText("Implementation", { exact: true })).toBeVisible();
    await expect(rail(page).getByText("Code review", { exact: true })).toBeVisible();
    await expect(right(page).getByText("The step names no file.")).toBeVisible();
    await expect(right(page).getByText(/accepted: rationale P1-R1-1/)).toBeVisible();
    await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
    // Issues #14 and #28: a finished loop is one line with what its cycles resolved, and no limit is shown.
    await expect(rail(page).getByText(loopSummary(2, 1, "converged"), { exact: true })).toBeVisible();
    await expect(rail(page).getByText(loopSummary(1, 0, "converged"), { exact: true })).toBeVisible();
    await expect(rail(page).getByText(/ of \d/)).toHaveCount(0);
    await expect(page.locator("button[name=new]")).toBeVisible();
    // Issue #2: in the right panel Claude speaks from the left and Codex from the right.
    const list = right(page).locator(".list");
    await onSide(list.locator("article[data-author=claude]").first(), list, "left");
    await onSide(list.locator("article[data-author=codex]").first(), list, "right");
    // Issue #15: each phase is a band opened by its label with the time it began; each kind of phase has its own tone.
    await expect(left(page).locator(".phase-label", { hasText: /^Planning · \S/ })).toBeVisible();
    await expect(left(page).locator(".phase-label", { hasText: /^Implementation · \S/ })).toBeVisible();
    const tone = (band: Locator) => band.evaluate((e) => getComputedStyle(e).backgroundColor);
    const [planningTone, executionTone] = [await tone(left(page).locator(".band-planning").first()), await tone(left(page).locator(".band-execution").first())];
    expect(planningTone).not.toBe(executionTone);
    expect(planningTone).not.toBe(await left(page).locator(".list").evaluate((e) => getComputedStyle(e).backgroundColor));
  });

  test("the fixture records an uncaught error in a second page of the context", async ({ context, pageErrors }) => {
    const second = await context.newPage();
    await second.goto(url("converge"));
    await second.evaluate(() => void setTimeout(() => { throw new Error("an uncaught error in the second tab"); }));
    await expect.poll(() => pageErrors.length).toBe(1);
    expect(pageErrors[0]).toMatch(/an uncaught error in the second tab/);
    pageErrors.length = 0;
  });

  test("(10) Start still starts when the browser refuses to store the directory", async ({ page }) => {
    await page.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException("access denied", "SecurityError");
      };
    });
    await startTask(page, "converge", "Document the service once more");
    await expect(rail(page).getByText("Planning", { exact: true })).toBeVisible();
  });

  // Issue #29: the e2e servers run in a temporary repository that is no bind mount, so the page identifies the project
  // by its path, with no run in progress and during one, and the tab's title is the path's own name.
  test("(26) the page identifies the project by its path when no mount record names it, with no run and during one", async ({ page }) => {
    await page.goto(url("converge"));
    await expect(page.getByText("connected", { exact: true })).toBeVisible();
    await toTheForm(page);
    const repo = await page.locator("input[name=project]").inputValue();
    expect(repo).toMatch(/^\//);
    const location = page.locator("header .location");
    await expect(location).toHaveText(repo);
    await expect(page).toHaveTitle(`${repo.split("/").at(-1)} — Interloq`);
    await page.locator("textarea[name=task]").fill("Document the service for the identification");
    await page.locator("button[name=start]").click();
    await expect(rail(page).getByText("Planning", { exact: true })).toBeVisible();
    await expect(location).toHaveText(repo);
  });
});

test.describe("the tests of the decision server, in order", () => {
  test.describe.configure({ mode: "default" });

  test("(2) a decision prompt with its buttons: Continue without deciding continues, and the answer is the user's message", async ({ page }) => {
    await startTask(page, "decision", "Add a database");
    await expect(asking(page, DATABASE)).toBeVisible();
    // S27: while the question waits, it takes the left column; S6: it is the run's first question.
    await expect(left(page)).toBeHidden();
    await expect(pane(page).locator("h2")).toHaveText(questionTitle(1));
    await continueWithoutDeciding(page).click();
    await expect(left(page).locator("[data-author=user]").getByText(CONTINUE_WITHOUT_DECIDING)).toBeVisible();
    await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
  });

  test("(3) a reload during a run shows the same messages and the pending prompt", async ({ page }) => {
    await startTask(page, "decision", "Add a database again");
    await expect(asking(page, DATABASE)).toBeVisible();
    const before = await left(page).locator("article").allTextContents();
    await page.reload();
    await expect(asking(page, DATABASE)).toBeVisible();
    expect(await left(page).locator("article").allTextContents()).toEqual(before);
    await expect(continueWithoutDeciding(page)).toBeVisible();
    await continueWithoutDeciding(page).click();
    await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
  });

  test("(11) Enter while an input method is composing does not answer", async ({ page }) => {
    await startTask(page, "decision", "Add a database with composition");
    await expect(asking(page, DATABASE)).toBeVisible();
    const field = page.locator("[name=answer]");
    await field.fill("unfinished composition");
    await field.evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
    await page.waitForTimeout(300);
    await expect(left(page).locator("[data-author=user]")).toHaveCount(0);
    await expect(field).toHaveValue("unfinished composition");
    await continueWithoutDeciding(page).click();
    await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
  });

  // S24, S25: q typed at a question asks for confirmation; confirmed, the run ends as interrupted, with exit code 130.
  test("(20) q typed and confirmed ends the run as an interruption", async ({ page }) => {
    await startTask(page, "decision", "Add a database and leave");
    await expect(asking(page, DATABASE)).toBeVisible();
    await page.locator("[name=answer]").fill("q");
    await page.locator("[name=answer]").press("Enter");
    await expect(page.locator("dialog[open]")).toContainText(confirmEndText("endRun"));
    await confirmEnd(page);
    await expect(left(page).getByText(/INTERRUPTED by the user\. State is preserved in/)).toBeVisible();
    await expect(page.getByText("This task has ended (interrupted).")).toBeVisible();
  });
  // Issue #16: a pause at a hidden tab marks the title, keeping the project, and raises one desktop notification; the
  // run's end there marks it again and notifies, and the tab seen clears the marker. The stub records and logs nothing.
  test("(27) a pause and the run's end at a hidden tab: the title's marker beside the project, and one notification each", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { visibility: string; shown: string[] };
      w.visibility = "hidden";
      w.shown = [];
      Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => w.visibility });
      class RecordingNotification {
        static permission = "granted";
        static requestPermission = () => Promise.resolve("granted");
        onclick: unknown = null;
        constructor(title: string) {
          w.shown.push(title);
        }
        close() {}
      }
      Object.defineProperty(window, "Notification", { configurable: true, writable: true, value: RecordingNotification });
      localStorage.setItem("interloq.alerts", JSON.stringify({ desktop: "on", sound: "off" }));
    });
    await startTask(page, "decision", "Add a database and notify");
    await expect(asking(page, DATABASE)).toBeVisible();
    const repo = (await page.locator("header .location").textContent())!.trim();
    const name = ownName(repo);
    const shown = () => page.evaluate(() => (window as unknown as { shown: string[] }).shown);
    await expect(page).toHaveTitle(tabTitle(repo, { _tag: "Waiting" }));
    expect(await shown()).toEqual([pauseNotificationTitle(name)]);
    await continueWithoutDeciding(page).click();
    await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
    await expect(page).toHaveTitle(tabTitle(repo, { _tag: "Ended", code: 0 }));
    expect(await shown()).toEqual([pauseNotificationTitle(name), endNotificationTitle(name, 0)]);
    await page.evaluate(() => {
      (window as unknown as { visibility: string }).visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page).toHaveTitle(tabTitle(repo));
  });

  // W1-R1-1 of issue #16: the icon's waiting badge is the error color of the scheme the page is shown in, dark or light.
  test("(28) the icon's badge has the page's error color in the dark scheme and in the light one", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await startTask(page, "decision", "Add a database in the dark");
    await expect(asking(page, DATABASE)).toBeVisible();
    const colors = () =>
      page.evaluate(() => {
        const href = document.head.querySelector("link[rel=icon]")?.getAttribute("href") ?? "";
        const svg = decodeURIComponent(href.slice(href.indexOf(",") + 1));
        const badge = /<circle class="badge"[^>]* fill="([^"]*)"/.exec(svg)?.[1] ?? null;
        const probe = document.createElement("span");
        probe.style.color = "var(--m3c-error)";
        document.body.append(probe);
        const error = getComputedStyle(probe).color;
        probe.remove();
        return { badge, error };
      });
    const dark = await colors();
    expect(dark.badge).toBe(dark.error);
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(async () => (await colors()).badge).not.toBe(dark.badge);
    const light = await colors();
    expect(light.badge).toBe(light.error);
    await continueWithoutDeciding(page).click();
    await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
  });
});

test.describe("the tests of the stop server, in order", () => {
  test.describe.configure({ mode: "default" });

  test("(4) Stop, confirmed, interrupts the task, and the page offers a new one", async ({ page }) => {
    await startTask(page, "stop", "A task to stop");
    await expect(left(page).getByText(/cycle 1: Claude Code response/)).toBeVisible();
    // Issue #14: while the loop runs, each cycle says what its review found.
    await expect(rail(page).getByText("cycle 1: 1 issue", { exact: true })).toBeVisible();
    await page.locator("button[name=stop]").click();
    // S25: the dialog says what ends and the exit code; Cancel keeps the run, confirming stops it.
    await expect(page.locator("dialog[open]")).toContainText("exit code 130");
    await page.locator("dialog[open] button[name=cancel-end]").click();
    await expect(page.locator("button[name=stop]")).toBeEnabled();
    await page.locator("button[name=stop]").click();
    await confirmEnd(page);
    await expect(left(page).getByText(/INTERRUPTED by the user\. State is preserved in/)).toBeVisible();
    await expect(page.locator("button[name=stop]")).toBeDisabled();
    await page.locator("button[name=new]").click();
    await expect(page.locator("textarea[name=task]")).toBeVisible();
  });
});

test.describe("the tests of the interview server, in order", () => {
  test.describe.configure({ mode: "default" });

  test("(5) an interview through confirmation: the page's help, a numbered answer, /done, the confirmed summary", async ({ page }) => {
    await startTask(page, "interview", "Add a service");
    await expect(asking(page, DATABASE)).toBeVisible();
    // S27: the conversation is one click away while the question waits.
    await pane(page).getByRole("button", { name: SHOW_CONVERSATION }).click();
    await expect(left(page).getByText(interviewHelp(clarificationHeading("clarification")))).toBeVisible();
    await page.getByRole("button", { name: SHOW_QUESTION }).click();
    await expect(left(page).getByText('"""')).toHaveCount(0);
    // Issue #21: Gather Requirements shows its steps; the clarification counts the agreed question, answered or not.
    const step = (label: string) => rail(page).locator("[data-step]", { has: page.locator("[data-step-label]", { hasText: label }) });
    await expect(step(stepLabel("formulate"))).toHaveAttribute("data-step", "done");
    await expect(step(stepLabel("clarification"))).toHaveAttribute("data-step", "active");
    await expect(step(stepLabel("clarification")).locator("[data-count]")).toHaveText("0 of 1 answered");
    await option(page, /PostgreSQL/).click();
    await expect(pane(page).getByText("Anything else?")).toBeVisible();
    await expect(step(stepLabel("clarification")).locator("[data-count]")).toHaveText("1 of 1 answered");
    await pane(page).getByRole("button", { name: SHOW_CONVERSATION }).click();
    // Issue #2 (Q5): in the left panel Claude and Interloq speak from the left, the user from the right.
    const list = left(page).locator(".list");
    await onSide(list.locator("article[data-author=claude]").first(), list, "left");
    await onSide(list.locator("article[data-author=program]").first(), list, "left");
    await onSide(list.locator("article[data-author=user]").first(), list, "right");
    // Issue #15 (P1-R1-1, P1-R2-1): inside a band the sides hold, and the band spans the list's content.
    const band = list.locator(".band-questions").first();
    await expect(band.locator("article[data-author=user]").first()).toBeVisible();
    await onSide(band.locator("article[data-author=claude]").first(), band, "left");
    await onSide(band.locator("article[data-author=user]").first(), band, "right");
    const [b, c] = [await edges(band), await contentEdges(list)];
    expect(Math.abs(b.right - b.left - (c.right - c.left)), "the band is as wide as the list's content").toBeLessThanOrEqual(2);
    await page.getByRole("button", { name: SHOW_QUESTION }).click();
    await pane(page).getByRole("button", { name: END_CLARIFICATION }).click();
    await expect(pane(page).getByText("The service uses PostgreSQL.")).toBeVisible();
    await pane(page).getByRole("button", { name: CONFIRM_SUMMARY_LABEL, exact: true }).click();
    // Four review loops and an execution follow; the run takes about 5 s alone and longer under the whole suite's load.
    await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
    await expect(rail(page).getByText("Gather Requirements", { exact: true })).toBeVisible();
    await expect(step(stepLabel("clarification"))).toHaveAttribute("data-step", "done");
    await expect(step(stepLabel("clarification")).getByText(loopSummary(1, 0, "converged"), { exact: true })).toBeVisible();
  });
});

test.describe("the tests of the emptyQuestions server, in order", () => {
  test.describe.configure({ mode: "default" });

  test("(23) an empty agreed question list: planning starts without a prompt, and the run finishes (issue #83)", async ({ page }) => {
    await startTask(page, "emptyQuestions", "Document the service");
    // One planning phase is foreseen, so the rail names it without a number (phaseName with a count of 1).
    const planning = rail(page).locator("li.entry", { has: page.getByText(phaseName({ kind: "planning", n: 1 }, 1), { exact: true }) });
    await expect(planning).toHaveAttribute("data-state", /active|done/);
    await expect(pane(page)).toHaveCount(0);
    await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
    await expect(rail(page).locator("li.entry", { has: page.getByText("Gather Requirements", { exact: true }) })).toHaveAttribute("data-state", "done");
    await expect(pane(page)).toHaveCount(0);
  });
});

test.describe("the tests of the workCorrection server, in order", () => {
  test.describe.configure({ mode: "default" });

  test("(6) a work correction runs planning, execution and the work review a second time", async ({ page }) => {
    await startTask(page, "workCorrection", "Write the tool");
    await expect(left(page).getByText(/finished after 2 implementation phase/)).toBeVisible();
    for (const phase of ["Planning 1", "Implementation 1", "Code review 1", "Planning 2", "Implementation 2", "Code review 2"]) await expect(rail(page).getByText(phase, { exact: true })).toBeVisible();
    // Issue #14 (G-R1-1): the work review that led to the second planning phase names its corrections due.
    await expect(rail(page).getByText(loopSummary(1, 1, "revise"), { exact: true })).toBeVisible();
    await expect(right(page).getByText("The step misses its test.")).toBeVisible();
    // Issue #15: every planning phase has the same tone, and so has every execution phase, apart from the other's.
    const tones = (kind: string) => left(page).locator(`.band-${kind}`).evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
    const [planning, execution] = [await tones("planning"), await tones("execution")];
    expect(planning.length).toBe(2);
    expect(execution.length).toBe(2);
    expect(new Set(planning).size).toBe(1);
    expect(new Set(execution).size).toBe(1);
    expect(planning[0]).not.toBe(execution[0]);
  });
});

test.describe("the tests of the tabs server, in order", () => {
  test.describe.configure({ mode: "default" });

  test("(7) two tabs: another tab's answer withdraws the unsent draft with a notice, and the run continues", async ({ context, page }) => {
    await startTask(page, "tabs", "Add a database");
    const other = await context.newPage();
    await other.goto(url("tabs"));
    await expect(asking(other, DATABASE)).toBeVisible();
    await other.locator("[name=answer]").fill("an unsent answer");
    await continueWithoutDeciding(page).click();
    await expect(asking(other, CACHE)).toBeVisible();
    await expect(other.locator("[name=answer]")).toHaveValue("");
    await expect(other.getByText(/answered in another tab; your unsent text was discarded: «an unsent answer»/)).toBeVisible();
    await continueWithoutDeciding(other).click();
    await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
  });

  // S34 (the stop of execution phase 5): test 7 once failed because startTask found a run left on the shared "tabs" server,
  // clicked Stop, and its confirmation stayed open when the confirm click missed its window; every retry then clicked Stop
  // again, and the open dialog intercepted that click until the helper's deadline. A confirmation left open is the state
  // this reproduces deterministically: startTask must confirm it and go on.
  test("(7a) a Stop confirmation left open by an earlier attempt: startTask confirms it and starts the task", async ({ page }) => {
    await startTask(page, "tabs", "Add a database");
    await expect(asking(page, DATABASE)).toBeVisible();
    await page.locator("button[name=stop]").click();
    await expect(page.locator("dialog[open]")).toBeVisible();
    await toTheForm(page);
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page.locator("textarea[name=task]")).toBeVisible();
  });
});

test.describe("the tests of the drop server, in order", () => {
  test.describe.configure({ mode: "default" });

  test("(8) a dropped connection: an answer made meanwhile is sent once after the hello, and the replay duplicates nothing", async ({ page }) => {
    let hold = false;
    let current: WebSocketRoute | null = null;
    await page.routeWebSocket(/\/ws$/, (ws) => {
      if (hold) {
        ws.close();
        return;
      }
      current = ws;
      ws.connectToServer();
    });
    await startTask(page, "drop", "Add a database");
    await expect(asking(page, DATABASE)).toBeVisible();
    hold = true;
    await current!.close();
    await expect(page.getByText("reconnecting…", { exact: true })).toBeVisible();
    await continueWithoutDeciding(page).click();
    hold = false;
    await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
    await expect(left(page).locator("article").filter({ hasText: DATABASE })).toHaveCount(1);
    await expect(left(page).locator("[data-author=user]").getByText(CONTINUE_WITHOUT_DECIDING)).toHaveCount(1);
  });
});

test.describe("the tests of the long server, in order", () => {
  test.describe.configure({ mode: "default" });

  test("(9) a long transcript: scrolled up, the position stays while messages arrive, and the chip leads to the end", async ({ page }) => {
    await startTask(page, "long", "Plan in detail");
    await expect(continueWithoutDeciding(page)).toBeVisible({ timeout: 180_000 });
    await pane(page).getByRole("button", { name: SHOW_CONVERSATION }).click();
    const list = left(page).locator(".list");
    expect(await left(page).locator("article").count()).toBeGreaterThan(150);
    await list.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await page.getByRole("button", { name: SHOW_QUESTION }).click();
    await continueWithoutDeciding(page).click();
    await expect(left(page).getByRole("button", { name: /new message/ })).toBeVisible();
    expect(await list.evaluate((el) => el.scrollTop)).toBe(0);
    await left(page).getByRole("button", { name: /new message/ }).click();
    await expect.poll(() => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(32);
  });
});

test.describe("the tests of the questionReview server, in order", () => {
  test.describe.configure({ mode: "default" });

  // Defect A of docs/page-question-phase-defects.md: the page had never carried a question phase whose review raised an
  // issue; the response with the amended list stopped the page, live and in every replay.
  test("(12) a question phase through the page: the list's review and response, one interview turn, an answer, the requirements review", async ({ context, page }) => {
    await startTask(page, "questionReview", "Add a service");
    await expect(right(page).getByText("The list does not ask for the port.")).toBeVisible();
    await expect(right(page).getByText(/accepted: rationale Q-R1-1/)).toBeVisible();
    await expect(asking(page, DATABASE)).toBeVisible();
    // A second tab receives the same run by replay, and the pending interview prompt with it.
    const other = await context.newPage();
    await other.goto(url("questionReview"));
    await expect(right(other).getByText(/accepted: rationale Q-R1-1/)).toBeVisible();
    await expect(option(other, /1\. PostgreSQL/)).toBeVisible();
    await other.close();
    await option(page, /1\. PostgreSQL/).click();
    await expect(pane(page).getByText("The service uses PostgreSQL on port 8080.")).toBeVisible();
    await pane(page).getByRole("button", { name: CONFIRM_SUMMARY_LABEL, exact: true }).click();
    await expect(right(page).getByText(/Requirements review, cycle 1/)).toBeVisible();
    await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
  });
});

test.describe("the tests of the decide server, in order", () => {
  test.describe.configure({ mode: "default" });

  // Decision support: "Help me decide" on a question with options, the analysis over both chat columns, then the answer.
  test("(13) Help me decide: the analysis covers the chat columns until the question is answered", async ({ page }) => {
    await startTask(page, "decide", "Add a database");
    await expect(asking(page, DATABASE)).toBeVisible();
    await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
    const analysis = page.getByRole("region", { name: /^Decision 1: / });
    await expect(analysis).toBeVisible();
    await expect(analysis.locator(".column h3")).toHaveText(["SQLite", "PostgreSQL"]);
    await expect(analysis.getByText("Disadvantages:").first()).toBeVisible();
    // Issue #87: the entries start collapsed; the counterargument is read after its entry is opened.
    await analysis.getByRole("button", { name: /^Show the reasoning of Advantage 1:/ }).click();
    await expect(analysis.getByText("On the other hand, the server needs its own configuration. *")).toBeVisible();
    await expect(left(page)).toBeHidden();
    // The conversation is one click away, and the analysis one click back.
    await page.getByRole("button", { name: SHOW_CONVERSATION }).click();
    await expect(left(page)).toBeVisible();
    await page.getByRole("button", { name: "Show the analysis" }).click();
    await expect(analysis).toBeVisible();
    await option(page, /PostgreSQL/).click();
    await expect(analysis).toBeHidden();
    await expect(left(page).locator("[data-author=user]").getByText("PostgreSQL — a database server")).toBeVisible();
    await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
  });

  // Issue #87 (decision G-R1-1): two tabs of one run show the same entries open; the state survives a reload, and the
  // mark is on the entry that hides a contradicting position in both.
  test("(24) two tabs agree on which entries of an analysis are open, and a reload keeps them", async ({ context, page }) => {
    await startTask(page, "decide", "Add a database");
    await expect(asking(page, DATABASE)).toBeVisible();
    await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
    const analysisOf = (p: Page) => p.getByRole("region", { name: /^Decision 1: / });
    await expect(analysisOf(page)).toBeVisible();
    const other = await context.newPage();
    await other.goto(url("decide"));
    await expect(analysisOf(other)).toBeVisible();
    const advantage = (p: Page) => analysisOf(p).getByRole("button", { name: /^(Show|Hide) the reasoning of Advantage 1:/ });
    const body = (p: Page) => analysisOf(p).getByText("The comparative condition of E1.");
    for (const p of [page, other]) {
      await expect(advantage(p)).toHaveAttribute("aria-expanded", "false");
      await expect(body(p)).toHaveCount(0);
      await expect(analysisOf(p).locator(".entry").nth(0).getByRole("img", { name: ENTRY_DISPUTED_LABEL })).toBeVisible();
      await expect(analysisOf(p).locator(".entry").nth(1).getByRole("img", { name: ENTRY_DISPUTED_LABEL })).toHaveCount(0);
    }
    await advantage(page).click();
    await expect(advantage(other)).toHaveAttribute("aria-expanded", "true");
    await expect(body(other)).toBeVisible();
    await advantage(other).click();
    await expect(advantage(page)).toHaveAttribute("aria-expanded", "false");
    await expect(body(page)).toHaveCount(0);
    await advantage(page).click();
    await other.reload();
    await expect(advantage(other)).toHaveAttribute("aria-expanded", "true");
    await expect(body(other)).toBeVisible();
    await option(page, /PostgreSQL/).click();
    await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
  });
});

test.describe("the tests of the decideRevise server, in order", () => {
  test.describe.configure({ mode: "default" });

  // W2-R1-1: a decision whose analysis is revised in its review: the response reaches the page, which stays connected.
  test("(14) a revised analysis: the decision's response reaches the page, which stays connected and shows the amended analysis", async ({ page }) => {
    await startTask(page, "decideRevise", "Add a database");
    await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
    const analysis = page.getByRole("region", { name: /^Decision 1: / });
    await expect(analysis).toBeVisible();
    await expect(analysis.getByText("The amended advantage: developers set up the service sooner.")).toBeVisible();
    await expect(page.getByText("connected", { exact: true })).toBeVisible();
    await expect(page.getByText(/could not read a message|stopped reconnecting/)).toHaveCount(0);
    await page.getByRole("button", { name: SHOW_CONVERSATION }).click();
    await expect(right(page).getByText(/D1-R1-1/).first()).toBeVisible();
    await page.getByRole("button", { name: SHOW_QUESTION }).click();
    await option(page, /SQLite/).click();
    await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
  });
});

test.describe("the tests of the decideBlank server, in order", () => {
  test.describe.configure({ mode: "default" });

  // W3-R1-1: an empty message after the analysis is rejected and asked again; the analysis stays until the answer.
  test("(15) a rejected empty reply keeps the analysis shown; the answer that follows dismisses it", async ({ page }) => {
    await startTask(page, "decideBlank", "Add a service");
    await page.getByRole("button", { name: HELP_ME_DECIDE }).click();
    const analysis = page.getByRole("region", { name: /^Decision 1: / });
    await expect(analysis).toBeVisible();
    // S46 (W3-R1-3): the agreed question's reason, its details, is shown with its context beside the analysis.
    const context = analysis.locator(".question-context");
    await context.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(context).toContainText(AGREED_REASON_HEADING);
    await expect(context).toContainText("r");
    await page.locator("textarea[name=answer]").press("Enter");
    // The Help me decide answer and the empty one.
    await expect(page.locator("[data-author=user]")).toHaveCount(2);
    await expect(analysis).toBeVisible();
    await expect(analysis.locator(".column h3")).toHaveText(["PostgreSQL", "SQLite"]);
    await option(page, /1\. PostgreSQL/).click();
    await expect(analysis).toBeHidden();
    await pane(page).getByRole("button", { name: CONFIRM_SUMMARY_LABEL, exact: true }).click();
    await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
  });
});

test.describe("the tests of the planSteps server, in order", () => {
  test.describe.configure({ mode: "default" });

  test("(16) the plan in the rail: its stages and steps under the Implementation that carries it out, the current step, the revision", async ({ page }) => {
    await startTask(page, "planSteps", "Build the rail");
    const entry = (label: string) => rail(page).locator("[data-state]", { has: page.locator("[data-label]", { hasText: new RegExp(`^${label}$`) }) });
    const step = (label: string, within = entry("Implementation 2")) => within.locator("[data-plan-step]", { has: page.locator("[data-plan-step-label]", { hasText: label }) });
    const implementation1 = entry("Implementation 1");
    const implementation2 = entry("Implementation 2");
    // The run waits in its second execution: the stop of the first foresaw the second iteration, so every phase is numbered.
    await expect(step(planStepLabel(2, "The store"))).toHaveAttribute("data-plan-step", "current");
    // Issue #50: the indicator is on the step that runs, not under the phase.
    await expect(step(planStepLabel(2, "The store")).getByRole("progressbar")).toBeVisible();
    await expect(implementation2.locator(".entry > .mark [role=progressbar], .entry > button > .mark [role=progressbar]")).toHaveCount(0);
    await expect(rail(page).locator("[data-plan-step] [role=progressbar]")).toHaveCount(1);
    // Issue #63: the stage no step of this phase has reached is collapsed; it is opened here.
    await implementation2.getByRole("button", { name: railToggleName(stageHeading(2, "the page"), RAIL_CONDITION_LABEL.notStarted, null, null), exact: true }).click();
    for (const phase of ["Planning 1", "Implementation 1", "Code review 1", "Planning 2", "Implementation 2", "Code review 2"]) await expect(rail(page).getByText(phase, { exact: true })).toBeVisible();
    // The revised plan hangs under Implementation 2 (Q5, Q9), with its new stage and step, without the step done before it.
    await expect(implementation2.getByText(stageHeading(2, "the page"), { exact: true })).toBeVisible();
    await expect(implementation2.locator("[data-plan-step]")).toHaveCount(2);
    await expect(step(planStepLabel(1, "The long step"))).toHaveAttribute("data-plan-step", "pending");
    // Issue #54: Implementation 1 keeps the steps it acted on after the revision: the one it finished and the one it left.
    await expect(implementation1.locator("[data-plan-step]")).toHaveCount(2);
    await expect(step(planStepLabel(1, "Structured user questions (Q1)"), implementation1).locator(".mark")).toHaveAttribute("aria-label", PLAN_STEP_STATE_LABEL.done);
    await expect(step(planStepLabel(2, "The store"), implementation1)).toHaveAttribute("data-plan-step", "unfinished");
    // The step's full text by keyboard.
    await step(planStepLabel(1, "Structured user questions (Q1)"), implementation1).locator("button").focus();
    await expect(rail(page).getByRole("tooltip")).toContainText("Add the schema of a question.");
    await page.keyboard.press("Escape");
    await expect(rail(page).getByRole("tooltip")).toHaveCount(0);
    await page.locator("button[name=stop]").click();
    await confirmEnd(page);
    await expect(page.locator("button[name=new]")).toBeVisible();
    // After the stop no execution runs: the started step is unfinished.
    await expect(step(planStepLabel(2, "The store"))).toHaveAttribute("data-plan-step", "unfinished");
  });

  // Issue #63: the rail's nodes are the run's shared state, as a decision's entries are (issue #87): opened and closed in
  // one tab, they open and close in the other, and a reload keeps them. A collapsed phase carries its condition and its bar.
  test("(25) two tabs agree on which nodes of the rail are open, and a reload keeps them", async ({ context, page }) => {
    await startTask(page, "planSteps", "Build the rail");
    const other = await context.newPage();
    await other.goto(url("planSteps"));
    const phase = (p: Page) => rail(p).getByRole("button", { name: /^Implementation 2, / });
    const stage = (p: Page) => rail(p).getByRole("button", { name: /^Stage 2: the page, / });
    const implementation2 = (p: Page) => rail(p).locator("li.entry", { has: p.locator("[data-label]", { hasText: /^Implementation 2$/ }) });
    for (const p of [page, other]) {
      await expect(phase(p)).toHaveAttribute("aria-expanded", "true");
      await expect(stage(p)).toHaveAttribute("aria-expanded", "false");
    }
    // The stage is opened before its phase is closed: a collapsed phase shows none of its stages.
    await stage(page).click();
    await expect(stage(other)).toHaveAttribute("aria-expanded", "true");
    await phase(page).click();
    await expect(phase(other)).toHaveAttribute("aria-expanded", "false");
    await expect(stage(other)).toHaveCount(0);
    // Issue #110: the collapsed phase's condition is in its name; its bar appears only once a step is complete (0 of 2 here).
    await expect(phase(other)).toHaveAccessibleName(new RegExp(`, ${RAIL_CONDITION_LABEL.partial}(,|$)`));
    await expect(implementation2(other).locator("[data-condition]")).toHaveCount(0);
    await expect(implementation2(other).locator("[data-collapsed] [data-tally]")).toHaveCount(0);
    await phase(other).click();
    await expect(phase(page)).toHaveAttribute("aria-expanded", "true");
    await expect(stage(other)).toHaveAttribute("aria-expanded", "true");
    await phase(page).click();
    await expect(phase(other)).toHaveAttribute("aria-expanded", "false");
    await other.reload();
    await expect(phase(other)).toHaveAttribute("aria-expanded", "false");
    await phase(other).click();
    await expect(stage(other)).toHaveAttribute("aria-expanded", "true");
    await page.locator("button[name=stop]").click();
    await confirmEnd(page);
    await expect(page.locator("button[name=new]")).toBeVisible();
  });
});

test.describe("the tests of the transportRetry server, in order", () => {
  test.describe.configure({ mode: "default" });

  test("(17) a Codex turn that loses its connection: the page shows the retry, and the run converges (issue #26)", async ({ page }) => {
    await startTask(page, "transportRetry", "Document the service");
    await expect(page.locator("[data-activity]")).toContainText("retry 1 of 3");
    // Issue #63: while the program waits to retry, the determinate indicator counts the known wait down.
    await expect(page.locator("[data-retry-wait] [role=progressbar]")).toHaveAttribute("aria-valuenow", /^\d+$/);
    await expect(left(page).getByText(transportRetryLine("codex", 1, 3, 2, "stream disconnected before completion"))).toBeVisible();
    await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
  });
});

test.describe("the tests of the unchangedPause server, in order", () => {
  test.describe.configure({ mode: "default" });

  test("(18) the pause of an accepted issue with the file unchanged: Proceed continues the review (issue #30)", async ({ page }) => {
    await startTask(page, "unchangedPause", "Document the service");
    await option(page, new RegExp(`^p\\. ${UNCHANGED_PROCEED}`)).click();
    await expect(left(page).locator("[data-author=user]").getByText(UNCHANGED_PROCEED)).toBeVisible();
    // Issue #19: the pause reached the user as prose; the transcript holds no JSON of the records.
    await expect(left(page).locator("article").filter({ hasText: /"duplicate_of"|\{\s*"/ })).toHaveCount(0);
    await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
  });
});

test.describe("the tests of the longQuestion server, in order", () => {
  test.describe.configure({ mode: "default" });

  // S28: a term of the question carries its explanation, reached by keyboard; Escape closes it.
  test("(19) a term's explanation is reached by keyboard in the question pane", async ({ page }) => {
    await startTask(page, "longQuestion", "Add a database");
    await expect(asking(page, DATABASE)).toBeVisible();
    const term = pane(page).locator(".question-text .term", { hasText: "service" });
    await term.focus();
    await expect(page.getByRole("tooltip")).toContainText("The service of this task, explained in ordinary words");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    // Shift+Tab reaches the term before it, "database", whose explanation opens in turn.
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("tooltip")).toContainText("The database of this task");
    // Issue #36: a plural with a capital, "Databases", refers to the same explanation; exact words never explained it.
    await page.keyboard.press("Escape");
    const plural = pane(page).locator(".context .term", { hasText: "Databases" });
    await plural.hover();
    await expect(page.getByRole("tooltip")).toContainText("The database of this task");
    await continueWithoutDeciding(page).click();
    await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
  });

  // S42 (W2-R1-5, P3-R1-3): Tab enters a term's tooltip, the keyboard scrolls it, the next Tab reaches the next term, and
  // Escape in the tooltip returns to its term.
  test("(21) a long explanation is entered, scrolled and left by keyboard", async ({ page }) => {
    await startTask(page, "longQuestion", "Add a database");
    await expect(asking(page, DATABASE)).toBeVisible();
    const database = pane(page).locator(".question-text .term", { hasText: "database" });
    const service = pane(page).locator(".question-text .term", { hasText: "service" });
    const tooltip = page.getByRole("tooltip");
    await database.focus();
    await expect(tooltip).toContainText("The database of this task");
    await page.keyboard.press("Tab");
    await expect(tooltip).toBeFocused();
    expect(await tooltip.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await page.keyboard.press("PageDown");
    await expect.poll(() => tooltip.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await page.keyboard.press("Tab");
    await expect(service).toBeFocused();
    await expect(tooltip).toContainText("The service of this task");
    await expect(tooltip).not.toContainText("The database of this task");
    await page.keyboard.press("Shift+Tab");
    await expect(database).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(tooltip).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(database).toBeFocused();
    await expect(tooltip).toHaveCount(0);
  });

  // S44 (W3-R1-1): a click in the explanation of a term in an option card answers nothing.
  test("(22) a click in a term's explanation inside an option card leaves the question pending", async ({ page }) => {
    await startTask(page, "longQuestion", "Add a database");
    await expect(asking(page, DATABASE)).toBeVisible();
    const term = option(page, /^1\. SQLite/).locator(".term").first();
    await term.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    await tooltip.click();
    await expect(asking(page, DATABASE)).toBeVisible();
    await expect(page.locator("[data-author=user]")).toHaveCount(0);
    await continueWithoutDeciding(page).click();
    await expect(left(page).getByText(/finished after 1 implementation phase/)).toBeVisible();
  });
});

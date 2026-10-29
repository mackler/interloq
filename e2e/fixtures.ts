// The fixture of every end-to-end test (finding 10 of docs/gui-review.md): an uncaught page error or a console error
// in any page of the test's context fails the test, the second tab of a scenario included.

import { test as base, expect, type Page } from "@playwright/test";
import { endedOutcome, REFINEMENT_LIST_TAB, RUN_TABS_LABEL, TAB_TEXTS } from "../src/prompts.ts";
import type { RunMode } from "../src/runMode.ts";

export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: async ({}, use) => {
    await use([]);
  },
  context: async ({ context, pageErrors }, use) => {
    const watch = (page: Page) => {
      page.on("pageerror", (error) => void pageErrors.push(`uncaught: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error") pageErrors.push(`console: ${message.text()}`);
      });
    };
    context.pages().forEach(watch);
    context.on("page", watch);
    await use(context);
    expect(pageErrors, "errors in the pages of this test").toEqual([]);
  },
});
export { expect };

// Issue #22: the "You and Interloq" panel is a dashboard, and a run's end is its ended line.
/** The dashboard, the region named "You and Interloq"; its compact form under a question has a name of its own. */
export const dashboard = (page: Page) => page.locator(`section[aria-label="You and Interloq"]`);
/** Waits for the run's ended line, `This task has ended (<outcome>).`, with the outcome of its exit code. */
export const toHaveEnded = (page: Page, code: number) => expect(page.getByText(`This task has ended (${endedOutcome(code)}).`, { exact: true })).toBeVisible();

// Issue #120: a run is started from an item of a tab's list; there is no form.
/** The label of a mode's tab, whose radio input m3-svelte's Tabs hides. */
export const tabOf = (page: Page, mode: RunMode) => page.locator("nav.tabs label", { hasText: TAB_TEXTS[mode].tab });
/** Issue #191: the Refinement tab's second row, one tab per refinement run after the items' tab. */
export const runTabsOf = (page: Page) => page.locator(`nav[aria-label="${RUN_TABS_LABEL}"]`);
/** The second row's tab of the run of that item, whose name begins with the item's headline (a waiting mark before it). */
export const runTabOf = (page: Page, item: string) => runTabsOf(page).locator("label", { hasText: `#${item} ` });
/** The second row's tab of the Refinement items. */
export const listTabOf = (page: Page) => runTabsOf(page).locator("label", { hasText: REFINEMENT_LIST_TAB });
/** A mode's list of items, shown in its tab when it has no run to show. */
export const listOf = (page: Page) => page.locator("section.items");

/**
 * From the page as it is to a mode's list: the tab selected, a run of the mode left running stopped and confirmed, an
 * ended one left behind with Back to the list.
 */
export const toTheList = async (page: Page, mode: RunMode) => {
  const stop = page.locator("button[name=stop]");
  const back = page.locator("button[name=new]");
  // Retried as a whole: the left run can end between the check and the click (it did on a loaded machine), after
  // which Stop stays disabled and a plain click would wait for the test's whole timeout.
  await expect(async () => {
    // S34: a confirmation an earlier attempt opened and did not confirm stays open and intercepts every click on the
    // page, the tab's and Stop's included; it is confirmed first, not reopened.
    const dialog = page.locator("dialog[open]");
    if (await dialog.isVisible()) {
      await dialog.locator("button[name=confirm-end]").click({ timeout: 5_000 }).catch(() => undefined);
      await expect(dialog).toHaveCount(0, { timeout: 5_000 });
    }
    await tabOf(page, mode).click({ timeout: 5_000 });
    if (await listOf(page).isVisible()) return;
    if (!(await dialog.isVisible()) && (await stop.isEnabled({ timeout: 1_000 }).catch(() => false))) await stop.click({ timeout: 2_000 });
    if (await dialog.isVisible()) {
      // S38: the confirmation closes without acting if the run ends before it is confirmed, which the check covers.
      await dialog.locator("button[name=confirm-end]").click({ timeout: 5_000 }).catch(() => undefined);
      await expect(dialog).toHaveCount(0, { timeout: 5_000 });
    }
    await back.click({ timeout: 5_000 });
    await expect(listOf(page)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
};

/**
 * Opens the page, goes to the mode's list and starts its run from the first item listed, or from the item with that
 * title; returns the item's id.
 */
export const startFromTab = async (page: Page, url: string, mode: RunMode, title?: string): Promise<string> => {
  await page.goto(url);
  await expect(page.getByText("connected", { exact: true })).toBeVisible();
  await toTheList(page, mode);
  const item = title === undefined ? listOf(page).locator("li").first() : listOf(page).locator("li", { hasText: title });
  const start = item.locator("button[name=start]:not([disabled])");
  await expect(start).toBeVisible();
  const id = (await start.getAttribute("data-item")) ?? "";
  await start.click();
  return id;
};

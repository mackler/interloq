// The two tabs of the page (issue #120): the frames a tab sends. Pure; the one place the page builds a start or an items
// frame, so that the mode and the item the page sends are the ones the server starts (the seam tested in
// test/webServer.test.ts).
import type { ChainFrameSettings, ClientMessage, ListedItem } from "../../src/protocol.ts";
import type { RunMode } from "../../src/runMode.ts";
import type { TermsMode } from "../../src/schema.ts";

/** What a tab starts (issue #142): a refinement with the choice of terms its control shows, an implementation with none. */
export type TabStart = Readonly<{ mode: "refinement"; item: ListedItem; terms: TermsMode }> | Readonly<{ mode: "implementation"; item: ListedItem }>;
/** The frame that starts a run of the tab's mode from a listed item. */
export const startFrame = (start: TabStart): ClientMessage =>
  start.mode === "refinement" ? { type: "start", mode: start.mode, item: start.item.id, terms: start.terms } : { type: "start", mode: start.mode, item: start.item.id };
/** The frame that asks the server for a tab's items; the server, never the page, calls the tracker. */
export const itemsFrame = (mode: RunMode): ClientMessage => ({ type: "items", mode });
/** The frame that sets the chain's settings (issue #147): the mode on or off and its two optional limits. */
export const chainFrame = (settings: ChainFrameSettings): ClientMessage => ({ type: "chain", settings });
/** Issue #185: the frame that says the developer is working on a prompt, so its countdown stops. */
export const holdFrame = (incarnation: string, run: number, prompt: number): ClientMessage => ({ type: "hold", incarnation, run, prompt });
/** Issue #131: the frame that turns the preparation of the marked items' questions on or off. */
export const preparationFrame = (enabled: boolean): ClientMessage => ({ type: "preparation", enabled });

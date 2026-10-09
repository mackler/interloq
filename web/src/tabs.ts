// The two tabs of the page (issue #120): the frames a tab sends. Pure; the one place the page builds a start or an items
// frame, so that the mode and the item the page sends are the ones the server starts (the seam tested in
// test/webServer.test.ts).
import type { ClientMessage, ListedItem } from "../../src/protocol.ts";
import type { RunMode } from "../../src/runMode.ts";

/** The frame that starts a run of the tab's mode from a listed item. */
export const startFrame = (mode: RunMode, item: ListedItem): ClientMessage => ({ type: "start", mode, item: item.id });
/** The frame that asks the server for a tab's items; the server, never the page, calls the tracker. */
export const itemsFrame = (mode: RunMode): ClientMessage => ({ type: "items", mode });

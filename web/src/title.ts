// The browser tab's title (issue #29; pure): the project's own name, then Interloq, so that two windows of two servers
// are told apart in a narrow tab strip (decision Q1 of the interview of 8 Oct 2026: no full path in the title).
import { ownName } from "../../src/hostDir.ts";

/** The tab's title for the server's identification of its project; `Interloq` alone before the first hello. */
export const tabTitle = (location: string | null): string => (location === null ? "Interloq" : `${ownName(location)} — Interloq`);

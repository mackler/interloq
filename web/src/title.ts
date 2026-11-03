// The browser tab's title (issue #29; pure): the project's own name, then Interloq, so that two windows of two servers
// are told apart in a narrow tab strip (decision Q1 of the interview of 8 Oct 2026: no full path in the title).
import { ownName } from "../../src/hostDir.ts";
import { type Mark, markGlyph } from "./notify.ts";

/**
 * The tab's title for the server's identification of its project; `Interloq` alone before the first hello. Issue #16:
 * a pause or an unseen end puts its marker in front, keeping the project; issue #209: an end's marker is ✓ for a
 * finished run and ✕ for any other end (`endMarkOf`); issue #139: the glyph is `markGlyph`'s, the one the mode tabs show.
 */
export const tabTitle = (location: string | null, mark: Mark = { _tag: "Clear" }): string => {
  const title = location === null ? "Interloq" : `${ownName(location)} — Interloq`;
  const glyph = markGlyph(mark);
  return glyph === null ? title : `${glyph} ${title}`;
};

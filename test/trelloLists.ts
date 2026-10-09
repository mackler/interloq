// The board and the five lists of the Trello adapter's tests: each a 24-character hexadecimal id, as Trello's are.
import type { TrelloLists } from "../src/schema.ts";

export const BOARD = "5f0000000000000000000b0a";
export const LISTS: TrelloLists = {
  unrefined: "5f00000000000000000000a1",
  refined: "5f00000000000000000000a2",
  implementing: "5f00000000000000000000a3",
  implemented: "5f00000000000000000000a4",
  deployed: "5f00000000000000000000a5",
};

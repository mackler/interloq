// The project's issue tracker as Interloq sees it (issue #120, part 1): the items and their states, common to every
// tracker. Pure; the port is `Tracker` in src/services.ts, the GitHub adapter src/github.ts.
import { type Brand, Result, Schema } from "effect";

/** Interloq's own vocabulary of states, in their order (developer's decision, issue #120). The config maps each to a tracker's own. */
export const ITEM_STATES = ["unrefined", "refining", "refined", "implementing", "implemented", "deployed"] as const;
export const ItemState = Schema.Literals(ITEM_STATES);
export type ItemState = typeof ItemState.Type;

/**
 * An item's id in its tracker: a text with a character other than whitespace, built by itemIdOf alone. The port's id is
 * a string and each adapter owns its own format: a GitHub issue number is an integer, a Trello card id an opaque
 * string, so the common type cannot be a number. An adapter checks and parses its own format, and an id outside it is
 * an item that does not exist there.
 */
export type ItemId = Brand.Branded<string, "ItemId">;
/** Why a text is not an item id: it is blank. */
export type InvalidItemId = Readonly<{ _tag: "InvalidItemId"; text: string }>;
export const itemIdOf = (text: string): Result.Result<ItemId, InvalidItemId> =>
  text.trim() === "" ? Result.fail({ _tag: "InvalidItemId", text }) : Result.succeed(text as ItemId);

/** What every tracker's item has in common: its id, title, body (a GitHub body of null is "") and state. */
export type TrackerItem = Readonly<{ id: ItemId; title: string; body: string; state: ItemState }>;

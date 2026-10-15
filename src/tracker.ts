// The project's issue tracker as Interloq sees it (issue #120, part 1): the items and their states, common to every
// tracker. Pure; the port is `Tracker` in src/services.ts, the GitHub adapter src/github.ts.
import { type Brand, Option, Result, Schema } from "effect";

/** Interloq's own vocabulary of states, in their order (developer's decision, issue #120; refining removed by his decision of 9 Oct 2026: an item is refined or unrefined). The config maps each to a tracker's own. */
export const ITEM_STATES = ["unrefined", "refined", "implementing", "implemented", "deployed"] as const;
export const ItemState = Schema.Literals(ITEM_STATES);
export type ItemState = typeof ItemState.Type;

/**
 * An item's id in its tracker: a text with a character other than whitespace, built by itemIdOf alone. The port's id is
 * a string and each adapter owns its own format: a GitHub issue number, a GitLab issue's number within its project
 * (iid). An adapter checks and parses its own format, and an id outside it is an item that does not exist there.
 */
export type ItemId = Brand.Branded<string, "ItemId">;
/** Why a text is not an item id: it is blank. */
export type InvalidItemId = Readonly<{ _tag: "InvalidItemId"; text: string }>;
export const itemIdOf = (text: string): Result.Result<ItemId, InvalidItemId> =>
  text.trim() === "" ? Result.fail({ _tag: "InvalidItemId", text }) : Result.succeed(text as ItemId);

/**
 * The address of an item's own page in its tracker (issue #125): an absolute https address, built by itemUrlOf alone.
 * The page puts it in a link's href, so no other scheme (javascript:, data:, http:) is a value of the type. Both
 * trackers serve their pages over https.
 */
export type ItemUrl = Brand.Branded<string, "ItemUrl">;
/** Why a text is not an item's address: it is not an absolute https address. */
export type InvalidItemUrl = Readonly<{ _tag: "InvalidItemUrl"; text: string }>;
/** The text as given, never the URL's normalized href, so the page links to exactly what the tracker sent. */
export const itemUrlOf = (text: string): Result.Result<ItemUrl, InvalidItemUrl> =>
  URL.canParse(text) && new URL(text).protocol === "https:" ? Result.succeed(text as ItemUrl) : Result.fail({ _tag: "InvalidItemUrl", text });
/** An item's address from the optional field of a tracker's response: none where it is absent or not an https address. */
export const itemUrlFrom = (text: string | undefined): Option.Option<ItemUrl> => (text === undefined ? Option.none() : Result.getSuccess(itemUrlOf(text)));

/**
 * What every tracker's item has in common: its id, title, body (a GitHub body of null is ""), state, and url, the item's
 * own page in its tracker as the tracker's response gives it (issue #125), none where the response has none or it is
 * not an https address.
 */
export type TrackerItem = Readonly<{ id: ItemId; title: string; body: string; state: ItemState; url: Option.Option<ItemUrl> }>;

/**
 * A positive decimal integer without leading zeros that is a safe integer, or none: the one rule of a GitHub issue
 * number, a GitLab issue number (iid) and GitLab's next page.
 */
export const positiveDecimalOf = (text: string): Option.Option<number> => (/^[1-9][0-9]*$/u.test(text) && Number.isSafeInteger(Number(text)) ? Option.some(Number(text)) : Option.none());

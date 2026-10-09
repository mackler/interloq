// What the Trello adapter decides without I/O: a card's id, its state and its item, the body of a move, the paging of a
// listing, the description's limit, the Authorization header and what a status means. Pure; the edge is src/trello.ts.
//
// A card sits on exactly one list (its `idList`), and the configured lists are distinct (TrelloLists in src/schema.ts),
// so at most one state matches a card: TrackerStateAmbiguous, a member of the port's error union, is never produced by
// this adapter. It is not a case to handle.
import { Option, Result, Schema } from "effect";
import { TrackerAuthRefused, TrackerItemNotFound, TrackerUnreachable } from "./errors.ts";
import { type Refinement, type SectionMalformed, withRefinement } from "./refinement.ts";
import { TrelloId, type TrelloLists, type TrelloTrackerConfig } from "./schema.ts";
import type { TrackerError } from "./services.ts";
import { ITEM_STATES, type ItemId, type ItemState, type TrackerItem } from "./tracker.ts";
import type { TrelloCredential } from "./trackerConfig.ts";

const TRACKER = "Trello";

/** The fields of Trello's card the adapter reads; the many others are ignored. The id is Trello's, so never blank. */
export const TrelloCard = Schema.Struct({ id: TrelloId, name: Schema.String, desc: Schema.String, idList: Schema.String, idBoard: Schema.String, closed: Schema.Boolean });
export type TrelloCard = typeof TrelloCard.Type;
/** Trello's `fields` parameter: the keys of TrelloCard, from the one source, so the request and the schema agree. */
export const CARD_FIELDS = Object.keys(TrelloCard.fields).join(",");

const TRELLO_ID = /^[0-9a-f]{24}$/u;
/** The card id an item id names: 24 lowercase hexadecimal characters; anything else is not a Trello id and is never sent. */
export const cardIdOf = (id: ItemId): Option.Option<string> => (TRELLO_ID.test(id) ? Option.some(id) : Option.none());

/**
 * Why a card has no state: it belongs to another board (so it is no item of this project), it is archived (by the
 * developer's rule an archived card is in no list, as a closed GitHub issue is in no state), or it is on a list the
 * configuration maps to no state.
 */
export type NoCardState = Readonly<{ _tag: "OtherBoard" }> | Readonly<{ _tag: "Archived" }> | Readonly<{ _tag: "UnmappedList"; list: string }>;

/** A card's state: the state whose list it is on, checked in the order other board, archived, unmapped list. */
export const stateOfCard = (config: TrelloTrackerConfig, card: Pick<TrelloCard, "idList" | "idBoard" | "closed">): Result.Result<ItemState, NoCardState> => {
  if (card.idBoard !== config.board) return Result.fail({ _tag: "OtherBoard" });
  if (card.closed) return Result.fail({ _tag: "Archived" });
  const state = ITEM_STATES.find((s) => config.lists[s] === card.idList);
  return state === undefined ? Result.fail({ _tag: "UnmappedList", list: card.idList }) : Result.succeed(state);
};

/** The item of a card: its id, its name as the title, its description as the body, and its state. */
export const itemOfCard = (config: TrelloTrackerConfig, card: TrelloCard): Result.Result<TrackerItem, NoCardState> =>
  // A TrelloId is 24 hexadecimal characters, never blank, which is all itemIdOf requires.
  Result.map(stateOfCard(config, card), (state) => ({ id: card.id as string as ItemId, title: card.name, body: card.desc, state }));

/** The body of a state change: the state's list, so one request moves the card and cannot stop half done. */
export const moveBody = (lists: TrelloLists, to: ItemState): Readonly<{ idList: string }> => ({ idList: lists[to] });

/** The largest `limit` Trello documents for the cards nested under a list. */
export const TRELLO_PAGE_SIZE = 1000;

/**
 * The cursor of the next page of a listing sorted newest first, none after a page that is not full. A Trello id begins
 * with its creation time in hexadecimal and all ids have one length, so the smallest id as a string is the oldest card
 * of the page, sent as `before`.
 */
export const nextCursor = (page: readonly Pick<TrelloCard, "id">[], size: number = TRELLO_PAGE_SIZE): Option.Option<string> =>
  page.length < size || page.length === 0 ? Option.none() : Option.some(page.map((card) => card.id).reduce((a, b) => (b < a ? b : a)));

/**
 * What is wrong with a page, or null: a card already seen, or after a cursor a card not older than it. Either means
 * Trello did not follow `before`, and the listing would loop or repeat cards.
 */
export const pageProblem = (cursor: string | null, seen: ReadonlySet<string>, page: readonly Pick<TrelloCard, "id">[]): string | null => {
  const ids = page.map((card) => card.id);
  const repeated = ids.find((id, i) => seen.has(id) || ids.indexOf(id) < i);
  if (repeated !== undefined) return `the card ${repeated} came twice`;
  const late = cursor === null ? undefined : ids.find((id) => id >= cursor);
  return late === undefined ? null : `the card ${late} is not older than the cursor ${cursor}`;
};

/**
 * Trello's limit on a card's description, by its published API documentation; unproven by a real call. Interloq
 * measures a text in UTF-16 code units, never fewer than its characters, so a text it passes is never too long.
 */
export const TRELLO_DESC_LIMIT = 16384;
/** A refinement that would make the description longer than Trello's limit: refused before any request, never truncated. */
export type DescTooLong = Readonly<{ _tag: "DescTooLong"; limit: number; length: number }>;

/** The card's description with the refinement through withRefinement, unchanged, refused over the limit. */
export const refinedDesc = (desc: string, refinement: Refinement): Result.Result<string, SectionMalformed | DescTooLong> =>
  Result.flatMap(withRefinement(desc, refinement), (text): Result.Result<string, DescTooLong> =>
    text.length > TRELLO_DESC_LIMIT ? Result.fail({ _tag: "DescTooLong", limit: TRELLO_DESC_LIMIT, length: text.length }) : Result.succeed(text),
  );

export const descTooLongText = (failure: DescTooLong): string =>
  `the refinement would make the card's description ${failure.length} characters long, more than Trello's limit of ${failure.limit}`;

/** Trello's Authorization header, which keeps the credential out of every URL. */
export const authorizationOf = (credential: TrelloCredential): string => `OAuth oauth_consumer_key="${credential.key}", oauth_token="${credential.token}"`;

/** What a request is for, which decides what a 404 means and what a body that does not decode names. */
export type TrelloTarget = Readonly<{ kind: "listing"; what: string }> | Readonly<{ kind: "item"; id: ItemId }>;
export const targetName = (target: TrelloTarget): string => (target.kind === "item" ? target.id : target.what);

/**
 * What a status of Trello's answer means, or null for a 2xx: the one mapping. A 404 on a listing is a configured list
 * that does not exist, a fault of the configuration, not a missing item.
 */
export const trelloStatusFailure = (status: number, method: string, target: TrelloTarget): TrackerError | null => {
  if (status >= 200 && status <= 299) return null;
  if (status === 401 || status === 403) return new TrackerAuthRefused({ tracker: TRACKER, status });
  if (status === 404 && target.kind === "item") return new TrackerItemNotFound({ id: target.id });
  return new TrackerUnreachable({ tracker: TRACKER, message: `Trello answered ${method} ${targetName(target)} with status ${status}` });
};

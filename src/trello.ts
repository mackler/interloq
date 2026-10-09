// The Trello tracker: the Tracker port over a Trello board, an edge. A state is a list of the board, by the developer's
// decision, and an archived card is in no state. The HTTP client is injected as a service and the credential is a
// parameter: this module never mentions process.env. Errors are built from statuses and the adapter's own words,
// never from an HttpClientError or its request, which carry the Authorization header. What it decides without I/O is
// in src/trelloCards.ts. TrackerShape is implemented as it stands: its four operations map onto three endpoints, and
// nothing of Trello's shape asked for a change of the port.
//
// Three facts this adapter rests on, taken from Trello's published API documentation, since neither the planning nor
// the implementation could reach the network; each is unproven by a real call until the developer's first run:
// - The credential: Trello documents the query parameters `key` and `token`, and also the header
//   `Authorization: OAuth oauth_consumer_key="{key}", oauth_token="{token}"`. The header is used, so that the
//   credential is in no URL, which reaches error messages, logs and anything that records a request.
// - Pagination: Trello sends no Link header. Cards nested under a list take `limit` (1 to 1,000), `sort`, `before` and
//   `since`. A listing asks for 1,000 cards sorted newest first (`sort=-id`), and for each following page `before` the
//   oldest card of the previous one, until a page is not full, so a long column never loses its tail. Each page is
//   checked against the cards already seen, so a Trello that ignored the cursor fails the listing, never loops.
//   A listing therefore comes back newest card first, not in the column's order.
// - The description: Trello limits a card's `desc` to 16,384 characters (TRELLO_DESC_LIMIT in src/trelloCards.ts); a
//   refinement that would pass it is refused before the request, never truncated.
import { Effect, Layer, Option, Result, Schema } from "effect";
import { HttpClient, type HttpClientError, HttpClientRequest, type HttpClientResponse } from "effect/http";
import { TrackerBodyInvalid, TrackerItemNotFound, TrackerUnreachable } from "./errors.ts";
import type { TrelloTrackerConfig } from "./schema.ts";
import { Tracker, type TrackerError, type TrackerShape } from "./services.ts";
import type { ItemId, ItemState, TrackerItem } from "./tracker.ts";
import type { TrelloCredential } from "./trackerConfig.ts";
import type { Refinement } from "./refinement.ts";
import { authorizationOf, CARD_FIELDS, cardIdOf, itemOfCard, nextCursor, type NoCardState, pageProblem, TRELLO_PAGE_SIZE, TrelloCard, type TrelloTarget, targetName, trelloStatusFailure } from "./trelloCards.ts";

const TRACKER = "Trello";
const API = "https://api.trello.com/1";

const decodeCard = Schema.decodeUnknownResult(TrelloCard);
const decodeCards = Schema.decodeUnknownResult(Schema.Array(TrelloCard));

/** A failure of the client as the tracker's error. Of the HttpClientError only a StatusCodeError's status is read, since every reason holds the request. */
const clientFailure = (error: HttpClientError.HttpClientError, method: string, target: TrelloTarget): TrackerError => {
  const reason = error.reason;
  switch (reason._tag) {
    case "StatusCodeError":
      return trelloStatusFailure(reason.response.status, method, target) ?? new TrackerUnreachable({ tracker: TRACKER, message: `the client refused Trello's answer to ${method} ${targetName(target)} with status ${reason.response.status}` });
    case "DecodeError":
    case "EmptyBodyError":
      return new TrackerBodyInvalid({ id: targetName(target), message: "Trello's answer could not be decoded" });
    case "TransportError":
    case "EncodeError":
    case "InvalidUrlError":
      return new TrackerUnreachable({ tracker: TRACKER, message: `the request ${method} ${targetName(target)} reached no answer from Trello` });
  }
};

/** A card with no state as the tracker's error: another board's card does not exist for this project. */
const noStateFailure = (failure: NoCardState, id: string): TrackerError => {
  switch (failure._tag) {
    case "OtherBoard":
      return new TrackerItemNotFound({ id });
    case "Archived":
      return new TrackerBodyInvalid({ id, message: "the card is archived, so it is in no state" });
    case "UnmappedList":
      return new TrackerBodyInvalid({ id, message: `the card is on list ${failure.list}, which the configuration maps to no state` });
  }
};

/** A card read with the item it is. */
type CardItem = Readonly<{ card: TrelloCard; item: TrackerItem }>;

export const trelloTracker = (config: TrelloTrackerConfig, credential: TrelloCredential): Effect.Effect<TrackerShape, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const authorized = (request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest =>
      request.pipe(HttpClientRequest.setHeader("authorization", authorizationOf(credential)), HttpClientRequest.setHeader("accept", "application/json"));

    /**
     * Sends a request and maps every failure once. A non-2xx is mapped by its status before the body is read, so the
     * plain text Trello answers some errors with is never decoded; plain text on a 2xx is TrackerBodyInvalid.
     */
    const send = (request: HttpClientRequest.HttpClientRequest, target: TrelloTarget): Effect.Effect<unknown, TrackerError> =>
      Effect.gen(function* () {
        const response: HttpClientResponse.HttpClientResponse = yield* Effect.mapError(client.execute(authorized(request)), (error) => clientFailure(error, request.method, target));
        const refused = trelloStatusFailure(response.status, request.method, target);
        if (refused !== null) return yield* Effect.fail(refused);
        return yield* Effect.mapError(response.json, () => new TrackerBodyInvalid({ id: targetName(target), message: "Trello's answer is not JSON" }));
      });

    /** Every page of a listing, newest first, each after the oldest card of the one before, until a page is not full. */
    const pages = (url: string, target: TrelloTarget, cursor: string | null, before: readonly TrelloCard[]): Effect.Effect<readonly TrelloCard[], TrackerError> => {
      const params = { filter: "open", fields: CARD_FIELDS, limit: String(TRELLO_PAGE_SIZE), sort: "-id", ...(cursor === null ? {} : { before: cursor }) };
      return Effect.flatMap(send(HttpClientRequest.get(url).pipe(HttpClientRequest.setUrlParams(params)), target), (json): Effect.Effect<readonly TrelloCard[], TrackerError> => {
        const cards = decodeCards(json);
        if (Result.isFailure(cards)) return Effect.fail(new TrackerBodyInvalid({ id: targetName(target), message: `Trello's answer is not a list of cards: ${cards.failure.message}` }));
        const problem = pageProblem(cursor, new Set(before.map((card) => card.id)), cards.success);
        if (problem !== null) return Effect.fail(new TrackerBodyInvalid({ id: targetName(target), message: `Trello's answer did not follow the paging cursor: ${problem}` }));
        const all = [...before, ...cards.success];
        return Option.match(nextCursor(cards.success), { onNone: () => Effect.succeed(all), onSome: (next) => pages(url, target, next, all) });
      });
    };

    const list = (state: ItemState): Effect.Effect<readonly TrackerItem[], TrackerError> => {
      const listId = config.lists[state];
      const target: TrelloTarget = { kind: "listing", what: `the ${state} cards of list ${listId}` };
      return Effect.flatMap(pages(`${API}/lists/${listId}/cards`, target, null, []), (cards): Effect.Effect<readonly TrackerItem[], TrackerError> => {
        // A list whose cards belong to another board is a list id copied from the wrong board: the configuration is wrong.
        if (cards.some((card) => card.idBoard !== config.board)) return Effect.fail(new TrackerBodyInvalid({ id: targetName(target), message: `the list ${listId} of ${state} is not on the configured board ${config.board}` }));
        return Effect.succeed(cards.filter((card) => !card.closed).flatMap((card) => Result.match(itemOfCard(config, card), { onFailure: () => [], onSuccess: (item) => (item.state === state ? [item] : []) })));
      });
    };

    /** The card an id names with the item it is: a card read refuses is refused here too, so that no write reaches it. */
    const itemCardOf = (id: ItemId): Effect.Effect<CardItem, TrackerError> =>
      Option.match(cardIdOf(id), {
        onNone: () => Effect.fail(new TrackerItemNotFound({ id })),
        onSome: (cardId) =>
          Effect.flatMap(send(HttpClientRequest.get(`${API}/cards/${cardId}`).pipe(HttpClientRequest.setUrlParams({ fields: CARD_FIELDS })), { kind: "item", id }), (json): Effect.Effect<CardItem, TrackerError> => {
            const card = decodeCard(json);
            if (Result.isFailure(card)) return Effect.fail(new TrackerBodyInvalid({ id, message: `Trello's answer is not a card: ${card.failure.message}` }));
            return Result.match(itemOfCard(config, card.success), { onFailure: (failure) => Effect.fail(noStateFailure(failure, id)), onSuccess: (item) => Effect.succeed({ card: card.success, item }) });
          }),
      });

    const read = (id: ItemId): Effect.Effect<TrackerItem, TrackerError> => Effect.map(itemCardOf(id), ({ item }) => item);

    const writeRefinement = (id: ItemId, _refinement: Refinement): Effect.Effect<void, TrackerError> => Effect.fail(new TrackerUnreachable({ tracker: TRACKER, message: `not built: ${id}` }));
    const setState = (id: ItemId, _state: ItemState): Effect.Effect<void, TrackerError> => Effect.fail(new TrackerUnreachable({ tracker: TRACKER, message: `not built: ${id}` }));

    const tracker: TrackerShape = { list, read, writeRefinement, setState };
    return tracker;
  });

export const trelloTrackerLayer = (config: TrelloTrackerConfig, credential: TrelloCredential): Layer.Layer<Tracker, never, HttpClient.HttpClient> => Layer.effect(Tracker, trelloTracker(config, credential));

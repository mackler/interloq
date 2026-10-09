// The pure part of the Trello adapter: a card's id, its state, its item, the paging of a listing, the description's
// limit, the Authorization header and the meaning of a status.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Option, Result } from "effect";
import { refinementOf, type Refinement, withRefinement } from "../src/refinement.ts";
import { ITEM_STATES, type ItemId } from "../src/tracker.ts";
import type { TrelloCredential } from "../src/trackerConfig.ts";
import { authorizationOf, CARD_FIELDS, cardIdOf, descTooLongText, itemOfCard, moveBody, nextCursor, pageProblem, refinedDesc, stateOfCard, TRELLO_DESC_LIMIT, TRELLO_PAGE_SIZE, trelloStatusFailure, type TrelloCard } from "../src/trelloCards.ts";
import { BOARD, LISTS } from "./trelloLists.ts";

const CONFIG = { kind: "trello" as const, board: BOARD, lists: LISTS };
const CARD_ID = "5f00000000000000000000c1";
const card = (over: Partial<TrelloCard> = {}): TrelloCard => ({ id: CARD_ID, name: "Title", desc: "Body", idList: LISTS.refined, idBoard: BOARD, closed: false, ...over }) as TrelloCard;
const refinement = (text: string): Refinement => Result.getOrThrow(refinementOf(text));
const hexId = (n: number): string => n.toString(16).padStart(24, "0");

test("CARD_FIELDS names exactly the fields of a card the adapter reads", () => {
  assert.deepEqual(CARD_FIELDS.split(","), Object.keys(card()));
});

test("cardIdOf accepts a 24-character lowercase hexadecimal id and nothing else", () => {
  assert.deepEqual(cardIdOf(CARD_ID as ItemId), Option.some(CARD_ID));
  for (const id of ["12", "5F00000000000000000000C1", CARD_ID.slice(1), `${CARD_ID}0`, "126", ` ${CARD_ID}`]) assert.ok(Option.isNone(cardIdOf(id as ItemId)), id);
});

test("stateOfCard: each state for its list", () => {
  for (const state of ITEM_STATES) assert.deepEqual(stateOfCard(CONFIG, card({ idList: LISTS[state] })), Result.succeed(state));
});

test("stateOfCard: another board before archived before an unmapped list", () => {
  const unmapped = "5f00000000000000000000ff";
  assert.deepEqual(stateOfCard(CONFIG, card({ idBoard: hexId(1), closed: true, idList: unmapped })), Result.fail({ _tag: "OtherBoard" }));
  assert.deepEqual(stateOfCard(CONFIG, card({ closed: true, idList: unmapped })), Result.fail({ _tag: "Archived" }));
  assert.deepEqual(stateOfCard(CONFIG, card({ closed: true })), Result.fail({ _tag: "Archived" }));
  assert.deepEqual(stateOfCard(CONFIG, card({ idList: unmapped })), Result.fail({ _tag: "UnmappedList", list: unmapped }));
});

test("itemOfCard maps the id, name, description and list", () => {
  assert.deepEqual(itemOfCard(CONFIG, card({ idList: LISTS.implementing })), Result.succeed({ id: CARD_ID, title: "Title", body: "Body", state: "implementing" }));
});

test("moveBody is the state's list id alone", () => {
  for (const state of ITEM_STATES) assert.deepEqual(moveBody(LISTS, state), { idList: LISTS[state] });
});

test("nextCursor: a short or empty page is the last, a full one gives its smallest id", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: hexId(5000 - i) }));
  assert.equal(TRELLO_PAGE_SIZE, 1000);
  assert.ok(Option.isNone(nextCursor(ids(999))));
  assert.ok(Option.isNone(nextCursor([])));
  assert.deepEqual(nextCursor(ids(1000)), Option.some(hexId(4001)));
  assert.deepEqual(nextCursor([{ id: hexId(3) }, { id: hexId(1) }, { id: hexId(2) }], 3), Option.some(hexId(1)));
});

test("pageProblem: a repeated card or one not below the cursor is a problem", () => {
  assert.equal(pageProblem(null, new Set(), [{ id: hexId(2) }, { id: hexId(1) }]), null);
  assert.equal(pageProblem(hexId(5), new Set([hexId(5)]), [{ id: hexId(4) }, { id: hexId(3) }]), null);
  assert.ok(pageProblem(null, new Set([hexId(2)]), [{ id: hexId(2) }]) !== null);
  assert.ok(pageProblem(null, new Set(), [{ id: hexId(2) }, { id: hexId(2) }]) !== null);
  assert.ok(pageProblem(hexId(5), new Set(), [{ id: hexId(5) }]) !== null);
  assert.ok(pageProblem(hexId(5), new Set(), [{ id: hexId(6) }]) !== null);
});

test("refinedDesc: exactly the limit passes, one more fails naming both numbers, a malformed section fails", () => {
  assert.equal(TRELLO_DESC_LIMIT, 16384);
  const r = refinement("Requirements.");
  // A developer text of one "x" or more is followed by the separator and the section, whatever its length.
  const fill = "x".repeat(TRELLO_DESC_LIMIT - (Result.getOrThrow(withRefinement("x", r)).length - 1));
  const exact = refinedDesc(fill, r);
  assert.ok(Result.isSuccess(exact));
  assert.equal(exact.success.length, TRELLO_DESC_LIMIT);
  const over = refinedDesc(`${fill}x`, r);
  assert.ok(Result.isFailure(over));
  assert.deepEqual(over.failure, { _tag: "DescTooLong", limit: 16384, length: 16385 });
  if (over.failure._tag === "DescTooLong") {
    const text = descTooLongText(over.failure);
    assert.match(text, /16384/u);
    assert.match(text, /16385/u);
  }
  const malformed = refinedDesc("## Refined using Interloq\nno closing line", r);
  assert.ok(Result.isFailure(malformed));
  assert.equal(malformed.failure._tag, "SectionMalformed");
});

test("authorizationOf is Trello's OAuth header with the key and the token", () => {
  assert.equal(authorizationOf({ key: "K", token: "T" } as TrelloCredential), 'OAuth oauth_consumer_key="K", oauth_token="T"');
});

test("trelloStatusFailure: success, a refused credential, a missing card, and anything else unreachable", () => {
  const item = { kind: "item", id: CARD_ID as ItemId } as const;
  const listing = { kind: "listing", what: "the refined cards" } as const;
  assert.equal(trelloStatusFailure(200, "GET", item), null);
  for (const status of [401, 403]) {
    const failure = trelloStatusFailure(status, "GET", item);
    assert.equal(failure?._tag, "TrackerAuthRefused");
    assert.equal(failure._tag === "TrackerAuthRefused" && failure.status, status);
  }
  assert.equal(trelloStatusFailure(404, "GET", item)?._tag, "TrackerItemNotFound");
  for (const [status, target] of [[404, listing], [429, item], [500, item]] as const) {
    const failure = trelloStatusFailure(status, "GET", target);
    assert.equal(failure?._tag, "TrackerUnreachable", String(status));
    assert.match(failure._tag === "TrackerUnreachable" ? failure.message : "", new RegExp(String(status), "u"));
  }
});

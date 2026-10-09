// The Trello tracker's configuration: the board's id and each of the five states mapped to a distinct Trello list id.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result, Schema } from "effect";
import { TrelloTrackerConfig } from "../src/schema.ts";
import { BOARD, LISTS } from "./trelloLists.ts";

const decode = Schema.decodeUnknownResult(TrelloTrackerConfig, { onExcessProperty: "error" });
const TRELLO = { kind: "trello", board: BOARD, lists: LISTS };

test("a Trello tracker with its board and five distinct list ids decodes", () => {
  const decoded = decode(TRELLO);
  assert.ok(Result.isSuccess(decoded));
  assert.deepEqual(decoded.success, TRELLO);
});

test("a Trello tracker with a missing, blank or malformed id, a shared list or an unknown key is refused", () => {
  const { board: _board, ...noBoard } = TRELLO;
  const missing = Object.keys(LISTS).map((state): [string, unknown] => {
    const { [state as keyof typeof LISTS]: _gone, ...rest } = LISTS;
    return [`the list of ${state} missing`, { ...TRELLO, lists: rest }];
  });
  const cases: ReadonlyArray<[string, unknown]> = [
    ...missing,
    ["a blank list id", { ...TRELLO, lists: { ...LISTS, refined: " " } }],
    ["an empty list id", { ...TRELLO, lists: { ...LISTS, refined: "" } }],
    ["a list id of 23 characters", { ...TRELLO, lists: { ...LISTS, refined: LISTS.refined.slice(1) } }],
    ["a list id in uppercase", { ...TRELLO, lists: { ...LISTS, refined: LISTS.refined.toUpperCase() } }],
    ["a list name for an id", { ...TRELLO, lists: { ...LISTS, refined: "Refined" } }],
    ["the board missing", noBoard],
    ["the board blank", { ...TRELLO, board: "" }],
    ["an unknown key", { ...TRELLO, key: "secret" }],
    ["an unknown state", { ...TRELLO, lists: { ...LISTS, refining: LISTS.refined } }],
  ];
  for (const [what, tracker] of cases) assert.ok(Result.isFailure(decode(tracker)), `${what} was accepted`);
});

test("two states sharing a list are refused on the later state's path, naming the list", () => {
  const decoded = decode({ ...TRELLO, lists: { ...LISTS, implementing: LISTS.refined } });
  assert.ok(Result.isFailure(decoded));
  assert.match(decoded.failure.message, /implementing/u);
  assert.match(decoded.failure.message, /the list "5f00000000000000000000a2" of implementing is another state's too: each state needs a list of its own/u);
});

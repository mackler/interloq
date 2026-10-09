import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Layer, Option, Result } from "effect";
import { readRefinement, type Refinement, refinementOf, withoutRefinement, withRefinement } from "../src/refinement.ts";
import { Tracker } from "../src/services.ts";
import type { TrelloTrackerConfig } from "../src/schema.ts";
import type { TrackerError, TrackerShape } from "../src/services.ts";
import { type ItemId, itemIdOf } from "../src/tracker.ts";
import { type TrelloCredential, trelloCredential } from "../src/trackerConfig.ts";
import { trelloTracker, trelloTrackerLayer } from "../src/trello.ts";
import { CARD_FIELDS, TRELLO_DESC_LIMIT } from "../src/trelloCards.ts";
import { BOARD, LISTS } from "./trelloLists.ts";
import { type Answer, json, makeStub, type SentRequest, type Stub } from "./stubHttp.ts";

// The Trello adapter over a stub HTTP client. The key and the token carry markers, so that the last test can look for
// them in every error the adapter produced.
const ENV = { INTERLOQ_TRELLO_KEY: "KEYSECRET", INTERLOQ_TRELLO_TOKEN: "TOKENSECRET" };
const CREDENTIAL: TrelloCredential = Result.getOrThrow(trelloCredential(ENV));
const AUTHORIZATION = 'OAuth oauth_consumer_key="KEYSECRET", oauth_token="TOKENSECRET"';
const CONFIG: TrelloTrackerConfig = { kind: "trello", board: BOARD, lists: LISTS };
const API = "https://api.trello.com/1";
const UNMAPPED = "5f00000000000000000000ff";
const OTHER_BOARD = "5f0000000000000000000b0b";
const id = (text: string): ItemId => Result.getOrThrow(itemIdOf(text));
const hexId = (n: number): string => n.toString(16).padStart(24, "0");

/** A Trello card with the fields the adapter asks for and a few more Trello sends. */
export const card = (cardId: string, list: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({ id: cardId, name: `card ${cardId.slice(-4)}`, desc: `desc ${cardId.slice(-4)}`, idList: list, idBoard: BOARD, closed: false, shortLink: "abc", labels: [], ...more });
const C1 = hexId(0xc1);

const errors: TrackerError[] = [];
const withTracker = <A, E>(stub: Stub, use: (tracker: TrackerShape) => Effect.Effect<A, E>): Promise<A> => Effect.runPromise(Effect.flatMap(trelloTracker(CONFIG, CREDENTIAL), use).pipe(Effect.provide(stub.layer)));
const failure = async (stub: Stub, use: (tracker: TrackerShape) => Effect.Effect<unknown, TrackerError>): Promise<TrackerError> => {
  const error: TrackerError = await withTracker(stub, (t) => Effect.flip(use(t)));
  errors.push(error);
  return error;
};
/** Answers each request from a table; a Response is cloned, so that a route answers more than once. */
const route = (table: Readonly<Record<string, Answer>>) => (r: SentRequest): Answer => {
  const answer = table[`${r.method} ${r.url.origin}${r.url.pathname}`] ?? new Response("The requested resource was not found.", { status: 404 });
  return answer instanceof Response ? answer.clone() : answer;
};
const ids = (items: readonly { id: string }[]): string[] => items.map((i) => i.id);
const cardsOf = (state: keyof typeof LISTS): string => `GET ${API}/lists/${LISTS[state]}/cards`;
const descending = (from: number, count: number): Record<string, unknown>[] => Array.from({ length: count }, (_, i) => card(hexId(from - i), LISTS.unrefined));

test("a listing asks for the open cards of the state's list, newest first, and returns them as items", async () => {
  const stub = makeStub(route({ [cardsOf("refined")]: json([card(hexId(3), LISTS.refined), card(hexId(2), LISTS.refined, { closed: true }), card(hexId(1), LISTS.refined)]) }));
  const items = await withTracker(stub, (t) => t.list("refined"));
  assert.deepEqual(items, [
    { id: hexId(3), title: "card 0003", body: "desc 0003", state: "refined" },
    { id: hexId(1), title: "card 0001", body: "desc 0001", state: "refined" },
  ]);
  const [request] = stub.sent();
  assert.equal(stub.sent().length, 1);
  assert.equal(request.method, "GET");
  assert.equal(`${request.url.origin}${request.url.pathname}`, `${API}/lists/${LISTS.refined}/cards`);
  const params = request.url.searchParams;
  assert.equal(params.get("filter"), "open");
  assert.equal(params.get("fields"), CARD_FIELDS);
  assert.equal(params.get("limit"), "1000");
  assert.equal(params.get("sort"), "-id");
  assert.equal(params.get("before"), null);
  assert.equal(params.get("key"), null);
  assert.equal(params.get("token"), null);
});

test("a listing of two pages asks for the second before the oldest card of the first, and returns all in order", async () => {
  const first = descending(5000, 1000);
  const second = descending(4000, 3);
  const stub = makeStub((r) => (r.url.searchParams.get("before") === null ? json(first) : json(second)));
  const items = await withTracker(stub, (t) => t.list("unrefined"));
  assert.equal(items.length, 1003);
  assert.deepEqual(ids(items), [...first, ...second].map((c) => c.id));
  assert.equal(stub.sent().length, 2);
  assert.equal(stub.sent()[1].url.searchParams.get("before"), hexId(4001));
  assert.equal(stub.sent()[1].url.searchParams.get("limit"), "1000");
});

test("a listing of 999 cards sends one request", async () => {
  const stub = makeStub(() => json(descending(5000, 999)));
  assert.equal((await withTracker(stub, (t) => t.list("unrefined"))).length, 999);
  assert.equal(stub.sent().length, 1);
});

test("a Trello that ignores the cursor fails the listing after two requests rather than looping", async () => {
  const page = descending(5000, 1000);
  const stub = makeStub(() => json(page));
  assert.equal((await failure(stub, (t) => t.list("unrefined")))._tag, "TrackerBodyInvalid");
  assert.equal(stub.sent().length, 2);
});

test("a listing with a card of another board fails, naming the state's list", async () => {
  const stub = makeStub(route({ [cardsOf("implemented")]: json([card(hexId(2), LISTS.implemented), card(hexId(1), LISTS.implemented, { idBoard: OTHER_BOARD })]) }));
  const error = await failure(stub, (t) => t.list("implemented"));
  assert.equal(error._tag, "TrackerBodyInvalid");
  assert.match(error.message, new RegExp(LISTS.implemented, "u"));
});

test("read asks for one card with its fields and gives the item", async () => {
  const stub = makeStub(route({ [`GET ${API}/cards/${C1}`]: json(card(C1, LISTS.implementing)) }));
  assert.deepEqual(await withTracker(stub, (t) => t.read(id(C1))), { id: C1, title: "card 00c1", body: "desc 00c1", state: "implementing" });
  const [request] = stub.sent();
  assert.equal(request.method, "GET");
  assert.equal(request.url.searchParams.get("fields"), CARD_FIELDS);
});

test("read of an archived card or one on an unmapped list is TrackerBodyInvalid, of another board's card TrackerItemNotFound", async () => {
  for (const [more, tag] of [[{ closed: true }, "TrackerBodyInvalid"], [{ idList: UNMAPPED }, "TrackerBodyInvalid"], [{ idBoard: OTHER_BOARD }, "TrackerItemNotFound"]] as const) {
    const stub = makeStub(route({ [`GET ${API}/cards/${C1}`]: json(card(C1, LISTS.refined, more)) }));
    assert.equal((await failure(stub, (t) => t.read(id(C1))))._tag, tag, JSON.stringify(more));
  }
});

test("an id outside Trello's format is TrackerItemNotFound with no request", async () => {
  for (const text of ["126", C1.toUpperCase(), `${C1}0`, "../boards/x"]) {
    const stub = makeStub(() => json({}));
    assert.equal((await failure(stub, (t) => t.read(id(text))))._tag, "TrackerItemNotFound", text);
    assert.equal(stub.sent().length, 0);
  }
});

for (const filtered of [false, true]) {
  const options = { filtered };
  test(`statuses${filtered ? " over a client that filters them" : ""}: 401 and 403 refused, 404 a missing card, otherwise unreachable`, async () => {
    for (const status of [401, 403]) {
      for (const body of [json({ message: "invalid token" }, status), new Response("invalid key", { status })]) {
        const error = await failure(makeStub(() => body.clone(), options), (t) => t.list("unrefined"));
        assert.deepEqual(error._tag === "TrackerAuthRefused" && error.status, status);
      }
    }
    assert.equal((await failure(makeStub(() => new Response("The requested resource was not found.", { status: 404 }), options), (t) => t.read(id(C1))))._tag, "TrackerItemNotFound");
    assert.equal((await failure(makeStub(() => new Response("invalid id", { status: 404 }), options), (t) => t.list("refined")))._tag, "TrackerUnreachable");
    assert.equal((await failure(makeStub(() => new Response("oops", { status: 500 }), options), (t) => t.read(id(C1))))._tag, "TrackerUnreachable");
  });
}

test("a transport failure is TrackerUnreachable", async () => {
  assert.equal((await failure(makeStub(() => "transport"), (t) => t.list("unrefined")))._tag, "TrackerUnreachable");
  assert.equal((await failure(makeStub(() => "transport"), (t) => t.read(id(C1))))._tag, "TrackerUnreachable");
});

test("a 200 of plain text, JSON that is no card, or a client's decode or empty-body failure is TrackerBodyInvalid", async () => {
  const answers: Answer[] = [new Response("unauthorized card permission requested", { status: 200 }), json({ id: "x" }), json([{ id: 1 }]), "decode", "emptyBody"];
  for (const answer of answers) {
    const make = () => makeStub(() => (answer instanceof Response ? answer.clone() : answer));
    assert.equal((await failure(make(), (t) => t.list("unrefined")))._tag, "TrackerBodyInvalid", String(answer));
    assert.equal((await failure(make(), (t) => t.read(id(C1))))._tag, "TrackerBodyInvalid", String(answer));
  }
});

test("every request carries the credential in the Authorization header and in no URL", async () => {
  const stub = makeStub(route({ [cardsOf("unrefined")]: json([]), [`GET ${API}/cards/${C1}`]: json(card(C1, LISTS.unrefined)) }));
  await withTracker(stub, (t) => Effect.zip(t.list("unrefined"), t.read(id(C1))));
  assert.equal(stub.sent().length, 2);
  for (const r of stub.sent()) {
    assert.equal(r.headers.authorization, AUTHORIZATION);
    assert.ok(!r.url.toString().includes("KEYSECRET") && !r.url.toString().includes("TOKENSECRET"), r.url.toString());
  }
});

const refinement = (text: string): Refinement => Result.getOrThrow(refinementOf(text));
const puts = (stub: Stub): readonly SentRequest[] => stub.sent().filter((r) => r.method === "PUT");
const putBody = (r: SentRequest): Record<string, unknown> => JSON.parse(r.body ?? "null") as Record<string, unknown>;
const C2 = hexId(0xc2);
const cardRoute = (cardId: string, value: Record<string, unknown>, put: Answer = json({})): Record<string, Answer> => ({ [`GET ${API}/cards/${cardId}`]: json(value), [`PUT ${API}/cards/${cardId}`]: put });

test("a refinement is PUT as the card's description after the developer's text, which stays intact, and reads back", async () => {
  const developer = "What the developer wrote.\r\n\r\nTrailing spaces   ";
  const stub = makeStub(route(cardRoute(C1, card(C1, LISTS.unrefined, { desc: developer }))));
  const r = refinement("## Plan\n\n- one\n- two");
  await withTracker(stub, (t) => t.writeRefinement(id(C1), r));
  const [put] = puts(stub);
  assert.equal(puts(stub).length, 1);
  assert.equal(put.url.toString(), `${API}/cards/${C1}`);
  assert.equal(put.headers.authorization, AUTHORIZATION);
  assert.deepEqual(Object.keys(putBody(put)), ["desc"]);
  const desc = String(putBody(put).desc);
  assert.deepEqual(Result.getOrThrow(readRefinement(desc)), Option.some(r));
  assert.equal(Result.getOrThrow(withoutRefinement(desc)), developer);
});

test("a second refinement replaces the first", async () => {
  const first = Result.getOrThrow(withRefinement("text", refinement("first")));
  const stub = makeStub(route(cardRoute(C1, card(C1, LISTS.unrefined, { desc: first }))));
  await withTracker(stub, (t) => t.writeRefinement(id(C1), refinement("second")));
  const desc = String(putBody(puts(stub)[0]).desc);
  assert.deepEqual(Result.getOrThrow(readRefinement(desc)), Option.some(refinement("second")));
  assert.equal(Result.getOrThrow(withoutRefinement(desc)), "text");
});

test("a description with a malformed section is TrackerBodyInvalid and nothing is PUT", async () => {
  const stub = makeStub(route(cardRoute(C1, card(C1, LISTS.unrefined, { desc: "x\n\n## Refined using Interloq\nno end" }))));
  assert.equal((await failure(stub, (t) => t.writeRefinement(id(C1), refinement("r"))))._tag, "TrackerBodyInvalid");
  assert.equal(puts(stub).length, 0);
});

test("a refinement that would make the description longer than Trello's limit is TrackerBodyInvalid naming the limit, and nothing is PUT", async () => {
  const stub = makeStub(route(cardRoute(C1, card(C1, LISTS.unrefined, { desc: "d".repeat(TRELLO_DESC_LIMIT - 10) }))));
  const error = await failure(stub, (t) => t.writeRefinement(id(C1), refinement("Requirements of some length.")));
  assert.equal(error._tag, "TrackerBodyInvalid");
  assert.match(error.message, /16384/u);
  assert.equal(puts(stub).length, 0);
});

test("a state change PUTs the new state's list id and nothing else", async () => {
  const stub = makeStub(route({ ...cardRoute(C1, card(C1, LISTS.unrefined)), ...cardRoute(C2, card(C2, LISTS.refined)) }));
  await withTracker(stub, (t) => Effect.andThen(t.setState(id(C1), "refined"), t.setState(id(C2), "implementing")));
  assert.deepEqual(puts(stub).map((r) => r.url.toString()), [`${API}/cards/${C1}`, `${API}/cards/${C2}`]);
  assert.deepEqual(puts(stub).map(putBody), [{ idList: LISTS.refined }, { idList: LISTS.implementing }]);
  for (const r of puts(stub)) assert.equal(r.headers.authorization, AUTHORIZATION);
});

test("a refinement or a state change of an archived card, a card on an unmapped list or another board's card PUTs nothing", async () => {
  for (const [more, tag] of [[{ closed: true }, "TrackerBodyInvalid"], [{ idList: UNMAPPED }, "TrackerBodyInvalid"], [{ idBoard: OTHER_BOARD }, "TrackerItemNotFound"]] as const) {
    const stub = makeStub(route(cardRoute(C1, card(C1, LISTS.refined, more))));
    assert.equal((await failure(stub, (t) => t.writeRefinement(id(C1), refinement("r"))))._tag, tag, JSON.stringify(more));
    assert.equal((await failure(stub, (t) => t.setState(id(C1), "implementing")))._tag, tag, JSON.stringify(more));
    assert.equal(puts(stub).length, 0);
  }
});

test("a PUT refused for the credential is TrackerAuthRefused", async () => {
  const stub = makeStub(route(cardRoute(C1, card(C1, LISTS.unrefined), new Response("unauthorized card permission requested", { status: 401 }))));
  assert.equal((await failure(stub, (t) => t.setState(id(C1), "implementing")))._tag, "TrackerAuthRefused");
  assert.equal((await failure(stub, (t) => t.writeRefinement(id(C1), refinement("r"))))._tag, "TrackerAuthRefused");
});

test("the four operations in sequence through Tracker, over one stub Trello", async () => {
  const cards = new Map<string, Record<string, unknown>>([[C1, card(C1, LISTS.unrefined, { desc: "Do it." })], [C2, card(C2, LISTS.refined)]]);
  const stub = makeStub((r) => {
    const parts = r.url.pathname.split("/");
    if (r.method === "GET" && parts.at(-1) === "cards") return json([...cards.values()].filter((c) => c.idList === parts.at(-2)).sort((a, b) => (String(b.id) < String(a.id) ? -1 : 1)));
    const cardId = String(parts.at(-1));
    if (!cards.has(cardId)) return new Response("The requested resource was not found.", { status: 404 });
    if (r.method === "PUT") cards.set(cardId, { ...cards.get(cardId), ...putBody(r) });
    return json(cards.get(cardId));
  });
  const layer = Layer.provide(trelloTrackerLayer(CONFIG, CREDENTIAL), stub.layer);
  const program = Effect.gen(function* () {
    const tracker = yield* Tracker;
    const before = yield* tracker.list("unrefined");
    const item = yield* tracker.read(before[0].id);
    yield* tracker.writeRefinement(item.id, refinement("Refined."));
    yield* tracker.setState(item.id, "refined");
    return { before, after: yield* tracker.list("refined"), unrefined: yield* tracker.list("unrefined") };
  });
  const { before, after, unrefined } = await Effect.runPromise(Effect.provide(program, layer));
  assert.deepEqual(ids(before), [C1]);
  assert.deepEqual(ids(after), [C2, C1]);
  assert.deepEqual(unrefined, []);
  const refined = after.find((item) => item.id === C1);
  assert.ok(refined !== undefined);
  assert.deepEqual(Result.getOrThrow(readRefinement(refined.body)), Option.some(refinement("Refined.")));
  assert.ok(refined.body.startsWith("Do it."));
  for (const r of stub.sent()) assert.equal(r.headers.authorization, AUTHORIZATION);
});

test("neither credential is in any error the adapter produced", () => {
  assert.ok(errors.length >= 10, String(errors.length));
  for (const error of errors) {
    const text = `${JSON.stringify(error)} ${String(error)} ${error.message}`;
    assert.ok(!text.includes("KEYSECRET") && !text.includes("TOKENSECRET"), text);
  }
});

// Issue #13: the page's notices, a condition of the connection ended by the next hello, or a message kept until dismissed.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import * as prompts from "../../src/prompts.ts";
import { added, afterHello, type ConnectionCondition, connectionNotices, connectionText, dismissed, EMPTY_NOTICES, endsAt, messages, type NoticeKind, type Notices } from "./notices.ts";

const RUNS = { numRuns: 100, seed: 20261104 };
const message = (text: string): NoticeKind => ({ _tag: "Message", text });
const connection = (condition: ConnectionCondition): NoticeKind => ({ _tag: "Connection", condition });
const CLOSED = connection({ _tag: "ServerClosed" });
const BEHIND = connection({ _tag: "FellBehind" });
const textsOf = (n: Notices) => messages(n).map((m) => (m.kind._tag === "Message" ? m.kind.text : ""));

describe("notices by example", () => {
  test("added gives the next id and keeps arrival order", () => {
    const n = added(added(EMPTY_NOTICES, message("a")), CLOSED);
    expect(n.held.map((x) => x.id)).toEqual([1, 2]);
    expect(n.next).toBe(3);
    expect(textsOf(n)).toEqual(["a"]);
    expect(connectionNotices(n).map((x) => x.kind)).toEqual([CLOSED]);
  });

  test("a connection condition replaces its earlier notice; messages are never deduplicated", () => {
    const n = [CLOSED, message("a"), message("a"), connection({ _tag: "Unreadable", reason: "r1" }), CLOSED, connection({ _tag: "Unreadable", reason: "r2" })].reduce(added, EMPTY_NOTICES);
    expect(connectionNotices(n).map((x) => x.kind)).toEqual([CLOSED, connection({ _tag: "Unreadable", reason: "r2" })]);
    expect(textsOf(n)).toEqual(["a", "a"]);
    expect(n.held.map((x) => x.id)).toEqual([2, 3, 5, 6]);
  });

  test("endsAt: a connection notice at the hello, a message at its dismissal", () => {
    expect(endsAt(CLOSED)).toBe("hello");
    expect(endsAt(message("x"))).toBe("dismissal");
  });

  test("afterHello keeps the messages alone, ids, order and next unchanged", () => {
    const n = [message("a"), CLOSED, BEHIND, message("b")].reduce(added, EMPTY_NOTICES);
    const after = afterHello(n);
    expect(after.held.map((x) => x.id)).toEqual([1, 4]);
    expect(after.next).toBe(n.next);
    expect(textsOf(after)).toEqual(["a", "b"]);
  });

  test("dismissed removes that message alone; an unknown id or a connection notice's id changes nothing", () => {
    const n = [message("a"), CLOSED, message("b")].reduce(added, EMPTY_NOTICES);
    expect(textsOf(dismissed(n, 1))).toEqual(["b"]);
    expect(dismissed(n, 2)).toEqual(n);
    expect(dismissed(n, 99)).toEqual(n);
  });

  test("connectionText derives each condition's words from src/prompts.ts", () => {
    expect(connectionText({ _tag: "ServerClosed" })).toBe(prompts.SERVER_CLOSED_NOTICE);
    expect(connectionText({ _tag: "FellBehind" })).toBe(prompts.FELL_BEHIND_NOTICE);
    expect(connectionText({ _tag: "Unreadable", reason: "bad" })).toBe(prompts.protocolErrorNotice("bad"));
  });
});

type Op = Readonly<{ _tag: "Add"; kind: NoticeKind }> | Readonly<{ _tag: "Hello" }> | Readonly<{ _tag: "Dismiss"; pick: number }>;
const arbCondition: fc.Arbitrary<ConnectionCondition> = fc.oneof(
  fc.constant<ConnectionCondition>({ _tag: "ServerClosed" }),
  fc.constant<ConnectionCondition>({ _tag: "FellBehind" }),
  fc.string().map((reason): ConnectionCondition => ({ _tag: "Unreadable", reason })),
);
// A message's text may equal a connection notice's words: no text is matched.
const arbText = fc.oneof(fc.string(), fc.constantFrom(prompts.SERVER_CLOSED_NOTICE, prompts.FELL_BEHIND_NOTICE));
const arbOp: fc.Arbitrary<Op> = fc.oneof(
  arbCondition.map((condition): Op => ({ _tag: "Add", kind: connection(condition) })),
  arbText.map((text): Op => ({ _tag: "Add", kind: message(text) })),
  fc.constant<Op>({ _tag: "Hello" }),
  fc.nat(20).map((pick): Op => ({ _tag: "Dismiss", pick })),
);

/** Applies the operations, with the model of the messages expected: each added and not dismissed, in order. */
const run = (ops: readonly Op[]) =>
  ops.reduce(
    (acc, op) => {
      switch (op._tag) {
        case "Add": {
          const notices = added(acc.notices, op.kind);
          const id = acc.notices.next;
          return { notices, model: op.kind._tag === "Message" ? [...acc.model, { id, text: op.kind.text }] : acc.model, connectionSinceHello: op.kind._tag === "Connection" || acc.connectionSinceHello };
        }
        case "Hello":
          return { ...acc, notices: afterHello(acc.notices), connectionSinceHello: false };
        case "Dismiss": {
          // Half the picks name a held id, the rest an id that may be absent.
          const ids = acc.notices.held.map((x) => x.id);
          const id = op.pick % 2 === 0 && ids.length > 0 ? ids[op.pick % ids.length] : op.pick;
          const notices = dismissed(acc.notices, id);
          expect(acc.notices.held.length - notices.held.length).toBeLessThanOrEqual(1);
          return { ...acc, notices, model: acc.model.filter((m) => m.id !== id) };
        }
      }
    },
    { notices: EMPTY_NOTICES, model: [] as readonly { id: number; text: string }[], connectionSinceHello: false },
  );

describe("notices by property", () => {
  test("ids unique and increasing; one connection notice per tag; none after a hello; every message kept until dismissed", () => {
    fc.assert(
      fc.property(fc.array(arbOp, { maxLength: 40 }), (ops) => {
        const { notices, model, connectionSinceHello } = run(ops);
        const ids = notices.held.map((x) => x.id);
        ids.forEach((id, i) => expect(i === 0 || id > ids[i - 1]).toBe(true));
        const tags = connectionNotices(notices).map((x) => (x.kind._tag === "Connection" ? x.kind.condition._tag : ""));
        expect(new Set(tags).size).toBe(tags.length);
        if (!connectionSinceHello) expect(connectionNotices(notices)).toEqual([]);
        expect(messages(notices).map((m) => ({ id: m.id, text: m.kind._tag === "Message" ? m.kind.text : null }))).toEqual(model);
        expect(connectionNotices(afterHello(notices))).toEqual([]);
      }),
      RUNS,
    );
  });
});

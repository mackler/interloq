import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as prompts from "../../src/prompts.ts";
import type { ClientMessage, ServerMessage } from "../../src/protocol.ts";
import { backoff, connect, type Environment, type SocketLike } from "./socket.ts";

// Plan step 4.3: reconnection with backoff, replay on reconnect, and the queue of actions while disconnected.
class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    // A browser fires the close event later; with deferClose the test fires it itself with drop() (W1-R1-1).
    if (!deferClose) this.onclose?.({});
  }
  // The server's side.
  open() {
    this.onopen?.({});
  }
  receive(m: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop() {
    this.onclose?.({});
  }
  /** A frame that does not decode (defect B of docs/page-question-phase-defects.md). */
  receiveRaw(text: string) {
    this.onmessage?.({ data: text });
  }
}

let sockets: FakeSocket[] = [];
let logged: string[] = [];
let deferClose = false;
const env = (): Environment => ({
  logError: (text) => void logged.push(text),
  open: () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  },
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});
const handlers = () => ({ messages: [] as ServerMessage[], states: [] as string[], notices: [] as string[], errors: [] as [string, number][], unsent: [] as ClientMessage[] });
const wire = (h: ReturnType<typeof handlers>) => ({
  onMessage: (m: ServerMessage) => void h.messages.push(m),
  onState: (s: string) => void h.states.push(s),
  onNotice: (t: string) => void h.notices.push(t),
  onProtocolError: (reason: string, count: number) => void h.errors.push([reason, count]),
  onUnsent: (m: ClientMessage) => void h.unsent.push(m),
});

beforeEach(() => {
  sockets = [];
  logged = [];
  deferClose = false;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("socket", () => {
  test("a dropped connection is reopened after 1 s, 2 s, 4 s …, at most 30 s; a hello and a decoded replay reset the backoff", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(backoff)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    const h = handlers();
    connect("ws://x/ws", wire(h), env());
    sockets[0].drop();
    expect(h.states.at(-1)).toBe("reconnecting");
    vi.advanceTimersByTime(999);
    expect(sockets.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(sockets.length).toBe(2);
    sockets[1].drop();
    vi.advanceTimersByTime(1999);
    expect(sockets.length).toBe(2);
    vi.advanceTimersByTime(1);
    expect(sockets.length).toBe(3);
    sockets[2].open();
    sockets[2].receive({ type: "hello", location: "/", current: { refinement: null, implementation: null }, incarnation: "a" });
    expect(h.states.at(-1)).toBe("open");
    // A hello alone does not reset the backoff (Q1): the replay that follows it may be the frame that cannot be read.
    sockets[2].drop();
    vi.advanceTimersByTime(3999);
    expect(sockets.length).toBe(3);
    vi.advanceTimersByTime(1);
    expect(sockets.length).toBe(4);
    sockets[3].receive({ type: "hello", location: "/", current: { refinement: null, implementation: null }, incarnation: "a" });
    sockets[3].receive({ type: "replay", ui: [], runs: [] });
    sockets[3].drop();
    vi.advanceTimersByTime(1000);
    expect(sockets.length).toBe(5);
  });

  test("the replay after a reconnection reaches the page", () => {
    const h = handlers();
    connect("ws://x/ws", wire(h), env());
    sockets[0].drop();
    vi.advanceTimersByTime(1000);
    sockets[1].open();
    sockets[1].receive({ type: "hello", location: "/", current: { refinement: null, implementation: 1 }, incarnation: "a" });
    sockets[1].receive({ type: "replay", ui: [], runs: [{ id: 1, events: [] }] });
    expect(h.messages.map((m) => m.type)).toEqual(["hello", "replay"]);
  });

  test("an answer queued while disconnected is sent after the hello when its run is still current", () => {
    const h = handlers();
    const c = connect("ws://x/ws", wire(h), env());
    c.send({ type: "answer", incarnation: "a", run: 1, prompt: 3, text: "y" });
    expect(sockets[0].sent).toEqual([]);
    sockets[0].open();
    expect(sockets[0].sent, "flushed before the hello").toEqual([]);
    sockets[0].receive({ type: "hello", location: "/", current: { refinement: null, implementation: 1 }, incarnation: "a" });
    expect(sockets[0].sent.map((s) => JSON.parse(s))).toEqual([{ type: "answer", incarnation: "a", run: 1, prompt: 3, text: "y" }]);
    c.send({ type: "items", mode: "refinement" });
    expect(sockets[0].sent.length).toBe(2);
  });

  test("a stop queued for a run that has ended by the reconnection is discarded with a notice", () => {
    const h = handlers();
    const c = connect("ws://x/ws", wire(h), env());
    sockets[0].open();
    sockets[0].receive({ type: "hello", location: "/", current: { refinement: null, implementation: 1 }, incarnation: "a" });
    sockets[0].drop();
    c.send({ type: "stop", incarnation: "a", run: 1 });
    c.send({ type: "start", mode: "implementation", item: "1" });
    vi.advanceTimersByTime(1000);
    sockets[1].open();
    sockets[1].receive({ type: "hello", location: "/", current: { refinement: null, implementation: null }, incarnation: "a" });
    expect(sockets[1].sent.map((s) => JSON.parse(s).type)).toEqual(["start"]);
    expect(h.notices).toEqual([prompts.notSentNotice("stop", "ended")]);
  });
});

// Finding 12 of docs/gui-review.md: run and prompt numbers restart with the server, so an action is bound to the
// incarnation it was made in; one from an earlier start of the server is discarded even when the numbers match.
describe("socket across a server restart", () => {
  test("a stop and an answer queued for run 1, prompt 1 of incarnation a are discarded when the hello is incarnation b with current 1", () => {
    const h = handlers();
    const c = connect("ws://x/ws", wire(h), env());
    sockets[0].receive({ type: "hello", location: "/w", current: { refinement: null, implementation: 1 }, incarnation: "a" });
    sockets[0].drop();
    c.send({ type: "stop", incarnation: "a", run: 1 });
    c.send({ type: "answer", incarnation: "a", run: 1, prompt: 1, text: "yes" });
    vi.advanceTimersByTime(1000);
    sockets[1].receive({ type: "hello", location: "/w", current: { refinement: null, implementation: 1 }, incarnation: "b" });
    expect(sockets[1].sent).toEqual([]);
    expect(h.notices).toEqual([prompts.notSentNotice("stop", "restarted"), prompts.notSentNotice("answer", "restarted")]);
  });
});

// Defect B of docs/page-question-phase-defects.md: a frame that does not decode is never dropped in silence. It is
// logged, reported with its reason, and the page reconnects with backoff (Q1); after three in a row the page stops
// reconnecting (Q5), and no action is queued or sent any more: each is handed back to the page (G-R1-1).
describe("socket and a frame that does not decode", () => {
  const hello: ServerMessage = { type: "hello", location: "/", current: { refinement: null, implementation: 1 }, incarnation: "a" };
  const failOnce = (i: number) => {
    sockets[i].receive(hello);
    sockets[i].receiveRaw("{\"type\":\"replay\",\"runs\":7}");
  };

  test("the reason is reported and logged, the socket is closed, and the page reconnects after 1 s, not at once", () => {
    const h = handlers();
    connect("ws://x/ws", wire(h), env());
    failOnce(0);
    expect(h.errors.length).toBe(1);
    expect(h.errors[0][1]).toBe(1);
    expect(h.errors[0][0]).toMatch(/runs/);
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain(h.errors[0][0]);
    expect(sockets[0].closed).toBe(true);
    expect(sockets.length).toBe(1);
    expect(h.states.at(-1)).toBe("reconnecting");
    vi.advanceTimersByTime(999);
    expect(sockets.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(sockets.length).toBe(2);
  });

  test("three in a row: the page fails and opens no socket again", () => {
    const h = handlers();
    connect("ws://x/ws", wire(h), env());
    failOnce(0);
    vi.advanceTimersByTime(1000);
    failOnce(1);
    vi.advanceTimersByTime(2000);
    failOnce(2);
    expect(h.errors.map(([, n]) => n)).toEqual([1, 2, 3]);
    expect(h.states.at(-1)).toBe("failed");
    expect(sockets[2].closed).toBe(true);
    vi.advanceTimersByTime(600_000);
    expect(sockets.length).toBe(3);
  });

  test("a decoded replay ends the run of failures: the count starts again at 1", () => {
    const h = handlers();
    connect("ws://x/ws", wire(h), env());
    failOnce(0);
    vi.advanceTimersByTime(1000);
    failOnce(1);
    vi.advanceTimersByTime(2000);
    sockets[2].receive(hello);
    sockets[2].receive({ type: "replay", ui: [], runs: [] });
    sockets[2].receiveRaw("not json");
    expect(h.errors.map(([, n]) => n)).toEqual([1, 2, 1]);
    vi.advanceTimersByTime(1000);
    expect(sockets.length).toBe(4);
  });

  test("the actions queued when the page fails are handed back, and none reaches a socket", () => {
    const h = handlers();
    const c = connect("ws://x/ws", wire(h), env());
    failOnce(0);
    const queued: ClientMessage[] = [
      { type: "answer", incarnation: "a", run: 1, prompt: 2, text: "A" },
      { type: "stop", incarnation: "a", run: 1 },
      { type: "start", mode: "implementation", item: "1" },
      { type: "items", mode: "refinement" },
    ];
    for (const m of queued) c.send(m);
    // A hello would flush the queue; the frames that fail here arrive before any hello, so the actions stay queued.
    vi.advanceTimersByTime(1000);
    sockets[1].receiveRaw("not json");
    vi.advanceTimersByTime(2000);
    expect(h.unsent).toEqual([]);
    sockets[2].receiveRaw("not json");
    expect(h.unsent).toEqual(queued);
    expect(sockets.flatMap((s) => s.sent)).toEqual([]);
  });

  test("an action sent after the page has failed is handed back at once and sent nowhere", () => {
    const h = handlers();
    const c = connect("ws://x/ws", wire(h), env());
    failOnce(0);
    vi.advanceTimersByTime(1000);
    failOnce(1);
    vi.advanceTimersByTime(2000);
    failOnce(2);
    const m: ClientMessage = { type: "answer", incarnation: "a", run: 1, prompt: 2, text: "B" };
    c.send(m);
    expect(h.unsent).toEqual([m]);
    expect(sockets.flatMap((s) => s.sent)).toEqual([]);
  });

  test("a plain drop keeps retrying beyond three attempts", () => {
    const h = handlers();
    connect("ws://x/ws", wire(h), env());
    for (let i = 0; i < 5; i++) {
      sockets[i].drop();
      vi.advanceTimersByTime(30_000);
    }
    expect(sockets.length).toBe(6);
    expect(h.states).not.toContain("failed");
  });
});

// W1-R1-1: a browser's close event arrives after close() returns; in that interval the page must not send to the
// closing socket, which would discard the answer in silence.
describe("socket while a protocol error's close is pending", () => {
  const hello: ServerMessage = { type: "hello", location: "/", current: { refinement: null, implementation: 1 }, incarnation: "a" };
  const answer: ClientMessage = { type: "answer", incarnation: "a", run: 1, prompt: 2, text: "A" };

  test("after a frame that does not decode, an action is queued, not sent to the closing socket", () => {
    deferClose = true;
    const h = handlers();
    const c = connect("ws://x/ws", wire(h), env());
    sockets[0].receive(hello);
    sockets[0].receiveRaw("not json");
    expect(h.states.at(-1)).toBe("reconnecting");
    c.send(answer);
    expect(sockets[0].sent).toEqual([]);
    sockets[0].drop();
    vi.advanceTimersByTime(1000);
    expect(sockets.length).toBe(2);
    vi.advanceTimersByTime(60_000);
    expect(sockets.length).toBe(2);
    sockets[1].receive(hello);
    sockets[1].receive({ type: "replay", ui: [], runs: [] });
    expect(sockets[1].sent.map((x) => JSON.parse(x))).toEqual([answer]);
  });

  test("with the close pending, three frames in a row hand the queued answer back", () => {
    deferClose = true;
    const h = handlers();
    const c = connect("ws://x/ws", wire(h), env());
    sockets[0].receiveRaw("not json");
    c.send(answer);
    vi.advanceTimersByTime(1000);
    sockets[1].receiveRaw("not json");
    vi.advanceTimersByTime(2000);
    sockets[2].receiveRaw("not json");
    expect(h.states.at(-1)).toBe("failed");
    expect(h.unsent).toEqual([answer]);
    expect(sockets.flatMap((x) => x.sent)).toEqual([]);
  });
});

// Issue #87: the page's shared state is changed by an action like an answer: queued until the hello, discarded when
// the server has restarted, but kept for the last run, whose state the server holds too.
describe("socket and the shared state's action", () => {
  const flag = { scope: { _tag: "DecisionEntry" as const, decision: 1, entry: "e1" }, open: true };
  test("a ui action queued before the hello is sent after it, also for a run that has ended", () => {
    const h = handlers();
    const c = connect("ws://x/ws", wire(h), env());
    c.send({ type: "ui", incarnation: "a", run: 1, flag });
    sockets[0].open();
    sockets[0].receive({ type: "hello", location: "/", current: { refinement: null, implementation: null }, incarnation: "a" });
    expect(sockets[0].sent.map((s) => JSON.parse(s))).toEqual([{ type: "ui", incarnation: "a", run: 1, flag }]);
    expect(h.notices).toEqual([]);
  });
  test("a ui action of an earlier incarnation is discarded with a notice", () => {
    const h = handlers();
    const c = connect("ws://x/ws", wire(h), env());
    sockets[0].receive({ type: "hello", location: "/", current: { refinement: null, implementation: 1 }, incarnation: "a" });
    sockets[0].drop();
    c.send({ type: "ui", incarnation: "a", run: 1, flag });
    vi.advanceTimersByTime(1000);
    sockets[1].receive({ type: "hello", location: "/", current: { refinement: null, implementation: 1 }, incarnation: "b" });
    expect(sockets[1].sent).toEqual([]);
    expect(h.notices).toEqual([prompts.notSentNotice("ui", "restarted")]);
  });
});

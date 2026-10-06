// The page's connection to the server (plan step 4.3): one WebSocket, reconnected with exponential backoff
// (1 s to 30 s), and a queue of the page's actions while it is not connected. This module is an edge of the page:
// it holds the socket and the timers; what the messages mean is the reducer's (state.ts).

import { notSentNotice } from "../../src/prompts.ts";
import { type ClientMessage, decodeServer, type ServerMessage } from "../../src/protocol.ts";

/** The part of the browser's WebSocket this module uses; a test injects a fake. */
export type SocketLike = {
  send: (data: string) => void;
  close: () => void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
};
export type Environment = {
  open: (url: string) => SocketLike;
  setTimeout: (f: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** The console of the page, for the full reason of a frame that could not be read. */
  logError: (text: string) => void;
};
export type Handlers = {
  onMessage: (message: ServerMessage) => void;
  onState: (state: "open" | "reconnecting" | "failed") => void;
  /** An action of the page that was not sent, explained for the user. */
  onNotice: (text: string) => void;
  /** A frame of the server that did not decode: its reason and how many in a row. */
  onProtocolError: (reason: string, count: number) => void;
  /** An action that will never be sent, because the page has stopped reconnecting. */
  onUnsent: (message: ClientMessage) => void;
};
export type Connection = { send: (message: ClientMessage) => void; reconnect: () => void; close: () => void };

/** The delay before the n-th reconnection attempt (from 1): 1 s, 2 s, 4 s, … at most 30 s. */
export const backoff = (attempt: number): number => Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));

export const browserEnvironment = (): Environment => ({
  open: (url) => new WebSocket(url) as unknown as SocketLike,
  setTimeout: (f, ms) => globalThis.setTimeout(f, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
  logError: (text) => console.error(text),
});


/** Frames in a row that do not decode before the page stops reconnecting (decision Q5 of the defects' requirements). */
export const PROTOCOL_ERROR_LIMIT = 3;

export const connect = (url: string, handlers: Handlers, env: Environment = browserEnvironment()): Connection => {
  let socket: SocketLike | null = null;
  // Actions are sent only after the server's hello, so that one made for an ended run is not delivered to the next.
  let ready = false;
  let queue: ClientMessage[] = [];
  let attempt = 0;
  let timer: unknown = null;
  let closed = false;
  // Frames in a row that did not decode (defect B of docs/page-question-phase-defects.md); a decoded replay ends the run.
  let protocolErrors = 0;
  // After PROTOCOL_ERROR_LIMIT of them the page stops reconnecting, and every action is handed back unsent.
  let failed = false;

  /**
   * The queued actions after a hello: an answer, a stop or a change of the shared state (issue #87) of another
   * incarnation is discarded with a notice (finding 12), and so is an answer or a stop of an ended run; a change of the
   * shared state of an ended run is sent, because the server keeps the last run's state too.
   */
  const flush = (hello: Readonly<{ current: number | null; incarnation: string }>) => {
    const pending = queue;
    queue = [];
    for (const m of pending) {
      if ((m.type === "answer" || m.type === "stop" || m.type === "ui") && m.incarnation !== hello.incarnation) handlers.onNotice(notSentNotice(m.type, "restarted"));
      else if ((m.type === "answer" || m.type === "stop") && m.run !== hello.current) handlers.onNotice(notSentNotice(m.type, "ended"));
      else socket?.send(JSON.stringify(m));
    }
  };
  const schedule = () => {
    if (closed || failed || timer !== null) return;
    attempt += 1;
    handlers.onState("reconnecting");
    timer = env.setTimeout(() => {
      timer = null;
      open();
    }, backoff(attempt));
  };
  /** The page stops reconnecting; the queued actions are handed back, in order. */
  const fail = (s: SocketLike) => {
    failed = true;
    socket = null;
    ready = false;
    s.close();
    handlers.onState("failed");
    const pending = queue;
    queue = [];
    for (const m of pending) handlers.onUnsent(m);
  };
  /** A frame that did not decode is never dropped in silence: logged, reported, and the connection renewed with backoff. */
  const protocolError = (s: SocketLike, reason: string) => {
    protocolErrors += 1;
    env.logError(`Interloq: a message from the server could not be read (${protocolErrors} in a row): ${reason}`);
    handlers.onProtocolError(reason, protocolErrors);
    if (protocolErrors >= PROTOCOL_ERROR_LIMIT) return fail(s);
    // Detached before it closes (W1-R1-1): a browser's close event comes later, and an action sent meanwhile would
    // reach a closing socket and be discarded in silence; now it is queued. The late close event is ignored by onclose.
    socket = null;
    ready = false;
    s.close();
    schedule();
  };
  const open = () => {
    if (failed) return;
    ready = false;
    const s = env.open(url);
    socket = s;
    s.onmessage = (event) => {
      const decoded = decodeServer(String(event.data));
      if (decoded._tag !== "Success") return protocolError(s, decoded.failure);
      if (decoded.success.type === "hello") {
        ready = true;
        handlers.onState("open");
        handlers.onMessage(decoded.success);
        flush(decoded.success);
        return;
      }
      // The replay decoded: the connection is sound, so the backoff and the run of failures start again.
      if (decoded.success.type === "replay") {
        attempt = 0;
        protocolErrors = 0;
      }
      handlers.onMessage(decoded.success);
    };
    s.onclose = () => {
      if (socket !== s) return;
      socket = null;
      ready = false;
      schedule();
    };
    s.onerror = () => s.close();
  };
  open();

  return {
    send: (m) => {
      if (failed) handlers.onUnsent(m);
      else if (ready && socket !== null) socket.send(JSON.stringify(m));
      else queue = [...queue, m];
    },
    /** A gap in the events: a new connection gives a fresh replay. */
    reconnect: () => {
      if (failed) return;
      const s = socket;
      socket = null;
      ready = false;
      s?.close();
      open();
    },
    close: () => {
      closed = true;
      if (timer !== null) env.clearTimeout(timer);
      const s = socket;
      socket = null;
      s?.close();
    },
  };
};

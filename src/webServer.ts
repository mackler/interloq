// The web server (plan step 3.4): the built page from web/dist, and one WebSocket per tab: on connect the hello
// and the replay, then the live events; from the page start, answer, stop and list.

import { Deferred, Effect, Exit, FileSystem, Path, Queue, Ref, Result, type Scope } from "effect";
import { HttpPlatform, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";
import { type ClientMessage, decodeClient, inSnapshot, type ServerMessage } from "./protocol.ts";
import type { Broadcast, Refusal, RunManager } from "./runManager.ts";

/** What the server's handler needs besides the request. */
export type WebServerServices = HttpServerRequest.HttpServerRequest | Scope.Scope | HttpPlatform.HttpPlatform | FileSystem.FileSystem | Path.Path;

const notFound = HttpServerResponse.text("not found", { status: 404 });

/** The decoded path of a request target, or "malformed" when the URL or its percent-encoding is invalid (finding 2). */
export const requestTarget = (url: string): Result.Result<string, "malformed"> =>
  Result.try({ try: () => decodeURIComponent(new URL(url, "http://localhost").pathname), catch: (): "malformed" => "malformed" });

/**
 * The server: the handler of every request, and `closeAll`, which tells every open tab that the server is ending and
 * closes its socket (finding 15 of docs/gui-review.md). The wiring registers `closeAll` as a finalizer *after*
 * `HttpServer.serveEffect`, so that it runs before the HTTP shutdown, which would otherwise wait for the tabs.
 */
export type WebServer = Readonly<{ handler: Effect.Effect<HttpServerResponse.HttpServerResponse, never, WebServerServices>; closeAll: Effect.Effect<void> }>;
/** One open tab: the signal that the server is closing, and the signal that the tab's session has ended. */
type Open = Readonly<{ closing: Deferred.Deferred<void>; done: Deferred.Deferred<void> }>;

export const makeWebServer = (manager: RunManager, distDir: string, queueBound: number = QUEUE_BOUND): Effect.Effect<WebServer> =>
  Effect.gen(function* () {
    const open = yield* Ref.make<ReadonlySet<Open>>(new Set());
    const closeAll = Ref.get(open).pipe(
      Effect.flatMap((sessions) =>
        Effect.forEach([...sessions], (o) => Deferred.succeed(o.closing, undefined), { discard: true }).pipe(
          Effect.andThen(Effect.forEach([...sessions], (o) => Deferred.await(o.done), { discard: true })),
          // A session that does not end in time does not hold the server; the HTTP shutdown follows.
          Effect.timeout("2 seconds"),
          Effect.ignore,
        ),
      ),
    );
    return { handler: handlerOf(manager, distDir, open, queueBound), closeAll };
  });

/** The bound of a tab's forwarding queue (finding 13 of docs/gui-review.md; requirements, open point 1). */
export const QUEUE_BOUND = 1000;

/**
 * A tab's subscription to the broadcast (finding 13): events go to a queue of at most `bound`; `overflowed` is
 * completed when the tab has fallen that far behind, so that the session closes it and the tab recovers by replay.
 */
export const subscribeBounded = (manager: Pick<RunManager, "subscribe">, bound: number): Effect.Effect<Readonly<{ queue: Queue.Queue<Broadcast>; overflowed: Deferred.Deferred<void> }>, never, Scope.Scope> =>
  Effect.gen(function* () {
    // A dropping queue: its offer never suspends, so the run and the other tabs never wait for a slow tab.
    const queue = yield* Queue.dropping<Broadcast>(bound);
    const overflowed = yield* Deferred.make<void>();
    yield* manager.subscribe((event) => Queue.offer(queue, event).pipe(Effect.flatMap((taken) => (taken ? Effect.void : Deferred.succeed(overflowed, undefined).pipe(Effect.asVoid)))));
    return { queue, overflowed };
  });

/** The handler of every request. */
const handlerOf = (manager: RunManager, distDir: string, open: Ref.Ref<ReadonlySet<Open>>, queueBound: number): Effect.Effect<HttpServerResponse.HttpServerResponse, never, WebServerServices> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (request.method !== "GET") return notFound;
    const target = requestTarget(request.url);
    if (Result.isFailure(target)) return HttpServerResponse.text("bad request", { status: 400 });
    const pathname = target.success;
    if (pathname === "/ws") {
      const socket = yield* request.upgrade.pipe(Effect.option);
      if (socket._tag === "None") return HttpServerResponse.text("a WebSocket upgrade was expected", { status: 400 });
      yield* session(manager, socket.value, fs, path, open, queueBound);
      return HttpServerResponse.empty();
    }
    // The page: index.html at /, and the build's files; a path that leaves the build is not found.
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const root = path.resolve(distDir);
    const file = path.resolve(root, relative);
    if (file !== root && !file.startsWith(root + path.sep)) return notFound;
    const info = yield* Effect.exit(fs.stat(file));
    if (Exit.isFailure(info) || info.value.type !== "File") return notFound;
    return yield* HttpServerResponse.file(file).pipe(Effect.catch(() => Effect.succeed(notFound)));
  });

/**
 * One tab's connection. The listener is registered first and buffers into a queue; then the snapshot is taken;
 * then hello and replay are written, and every buffered and later event except those the snapshot holds
 * (inSnapshot, a boundary per replayed run). The frames of the page are handled in order until the socket closes.
 */
const session = (manager: RunManager, socket: Socket.Socket, fs: FileSystem.FileSystem, path: Path.Path, open: Ref.Ref<ReadonlySet<Open>>, queueBound: number): Effect.Effect<void, never, Scope.Scope> =>
  Effect.scoped(
    Effect.gen(function* () {
      // Registered for closeAll; `done` is completed however the session ends.
      const me: Open = { closing: yield* Deferred.make<void>(), done: yield* Deferred.make<void>() };
      yield* Effect.acquireRelease(
        Ref.update(open, (set): ReadonlySet<Open> => new Set([...set, me])),
        () => Ref.update(open, (set): ReadonlySet<Open> => new Set([...set].filter((o) => o !== me))).pipe(Effect.andThen(Deferred.succeed(me.done, undefined))),
      );
      // The upgrade is accepted when the reader is acquired, and a write waits for that (Socket.fromWebSocket):
      // the reader comes first.
      const reader = yield* socket.reader.pipe(Effect.option);
      if (reader._tag === "None") return;
      const writer = yield* socket.writer;
      const send = (message: ServerMessage) => writer.write(JSON.stringify(message)).pipe(Effect.ignore);
      const { queue: buffered, overflowed } = yield* subscribeBounded(manager, queueBound);
      const { runs, ui } = yield* manager.replay;
      yield* send({ type: "hello", location: manager.location, current: yield* manager.current, incarnation: manager.incarnation });
      yield* send({ type: "replay", runs, ui });
      const forward = Effect.gen(function* () {
        for (;;) {
          const event = yield* Queue.take(buffered);
          // Issue #87: a shared state is sent whatever the snapshot holds; the page keeps the higher version.
          if (event._tag === "ui") yield* send({ type: "ui", run: event.run, state: event.state });
          else if (!inSnapshot(runs, event)) yield* send({ type: "event", run: event.run, seq: event.seq, time: event.time, event: event.event });
        }
      });
      yield* Effect.forkScoped(forward);

      // Issue #120: a refusal names the mode of the tab whose action it was, or none.
      const refuse = (r: Refusal | null) => (r === null ? Effect.void : send({ type: "refused", mode: r.mode, reason: r.refused }));
      const dispatch = (message: ClientMessage): Effect.Effect<void, never, Scope.Scope> => {
        switch (message.type) {
          case "start":
            return manager.start(message.mode, message.item).pipe(Effect.flatMap((r) => (typeof r === "number" ? Effect.void : refuse(r))));
          case "items":
            // Issue #120: the server makes the tracker call; the page receives ids, titles and excerpts alone.
            return manager.listItems(message.mode).pipe(Effect.flatMap((result) => send({ type: "items", mode: message.mode, result })));
          case "answer":
            return manager.answer(message.incarnation, message.run, message.prompt, message.text).pipe(Effect.flatMap(refuse));
          case "stop":
            // The interruption waits for the run's finalizers; the connection keeps reading meanwhile.
            return Effect.forkScoped(manager.stop(message.incarnation, message.run).pipe(Effect.flatMap(refuse))).pipe(Effect.asVoid);
          case "ui":
            return manager.setUi(message.incarnation, message.run, message.flag).pipe(Effect.flatMap(refuse));
        }
      };
      // Every termination of the socket is a SocketError (Socket.d.ts); it ends the loop.
      const read = Effect.gen(function* () {
        for (;;) {
          for (const chunk of yield* reader.value.pull) {
            const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
            const decoded = decodeClient(text);
            yield* decoded._tag === "Success" ? dispatch(decoded.success) : send({ type: "refused", mode: null, reason: `not a message: ${decoded.failure}` });
          }
        }
      }).pipe(Effect.ignore);
      // The server's end (closeAll): the tab is told, then its socket is closed ("going away").
      const closed = Deferred.await(me.closing).pipe(
        Effect.andThen(send({ type: "closing" })),
        Effect.andThen(writer.write(new Socket.CloseEvent(1001, "the server is shutting down")).pipe(Effect.ignore)),
      );
      // A tab too far behind (finding 13): told, then closed; its reconnection gets the whole run from the replay.
      const behind = Deferred.await(overflowed).pipe(
        Effect.andThen(send({ type: "refused", mode: null, reason: "this tab fell too far behind the run; reconnecting to receive it again" })),
        Effect.andThen(writer.write(new Socket.CloseEvent(1013, "too far behind")).pipe(Effect.ignore)),
      );
      yield* Effect.raceAll([read, closed, behind]);
    }),
  );


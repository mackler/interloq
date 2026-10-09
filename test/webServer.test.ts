import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Deferred, Effect, Exit, Fiber, Result, Schema } from "effect";
import { HttpServer } from "effect/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { identify, type MountTable } from "../src/hostDir.ts";
import { platformLayer } from "../src/platform.ts";
import { ServerMessageSchema } from "../src/protocol.ts";
import type { ClientMessage, RunEvent, ServerMessage, Stamped } from "../src/protocol.ts";
import { type Broadcast, makeRunManager, type RunManager } from "../src/runManager.ts";
import { makeWebServer, requestTarget } from "../src/webServer.ts";
import { finished, type TestOptions, tempDir, tempRepo, testWiring, questionOf, runDirOf } from "./helpers.ts";
import { initialState, reduce } from "../web/src/state.ts";
import { choiceOf, isOpen } from "../src/uiState.ts";

const run = Effect.runPromise;
// Plan step 3.4: the server over NodeHttpServer.layerTest, with Node's WebSocket as the scripted client.
const noQuestions = { questions_for_user: [] };
const converging: TestOptions = { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] };
const withQuestion: TestOptions = { steps: [{ output: { questions_for_user: [questionOf({ context: "c", question: "Which?", terms: [], options: [] })] }, plan: "v1" }, { output: noQuestions }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] };

const managerOf = async (repo: string, scripts: TestOptions[], mounts: MountTable = []): Promise<RunManager> => {
  const queue = [...scripts];
  return Effect.runPromise(makeRunManager((ui) => ({ ...testWiring(repo, queue.shift() ?? {}).wiring, ui: Effect.succeed(ui) }), repo, mounts, "test").pipe(Effect.provide(platformLayer)));
};
const dist = (): string => {
  const d = tempDir("pr-dist-");
  fs.writeFileSync(path.join(d, "index.html"), "<!doctype html><title>Interloq</title>");
  fs.mkdirSync(path.join(d, "assets"));
  fs.writeFileSync(path.join(d, "assets", "app.js"), "console.log(1)");
  return d;
};
/**
 * The server as src/web.ts wires it (finding 15 of docs/gui-review.md): the handler, then serveEffect, then the
 * finalizer that closes the tabs, so that it runs before the HTTP shutdown. `closingFirst` registers that finalizer
 * before serveEffect instead, to show that the order matters.
 */
const server = (manager: RunManager, distDir: string, body: (port: number) => Effect.Effect<void>, closingFirst = false) =>
  Effect.scoped(
    Effect.gen(function* () {
      const web = yield* makeWebServer(manager, distDir);
      if (closingFirst) yield* Effect.addFinalizer(() => web.closeAll);
      yield* HttpServer.serveEffect(web.handler);
      if (!closingFirst) yield* Effect.addFinalizer(() => web.closeAll);
      const address = (yield* HttpServer.HttpServer).address;
      yield* body(address._tag === "UnixPathAddress" ? 0 : address.port);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest));
/** Serves the handler on an ephemeral port for the duration of `body`. */
const serve = (manager: RunManager, distDir: string, body: (port: number) => Promise<void>): Promise<void> =>
  Effect.runPromise(server(manager, distDir, (port) => Effect.promise(() => body(port))));

type Client = { messages: ServerMessage[]; send: (m: ClientMessage) => void; close: () => void };
const connect = (port: number): Promise<Client> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: ServerMessage[] = [];
    ws.onmessage = (e) => void messages.push(JSON.parse(String(e.data)));
    ws.onerror = () => reject(new Error("the WebSocket failed"));
    ws.onopen = () => resolve({ messages, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() });
  });
const until = async (what: string, condition: () => boolean, ms = 30_000): Promise<void> => {
  for (let waited = 0; waited < ms; waited += 5) {
    if (condition()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
};
/** The events a client has of each run, from the replay and the live messages, as (seq, time, event) in arrival order. */
const perRun = (c: Client): Map<number, { seq: number; time: string; event: RunEvent }[]> => {
  const runs = new Map<number, { seq: number; time: string; event: RunEvent }[]>();
  const add = (run: number, seq: number, time: string, event: RunEvent) => runs.set(run, [...(runs.get(run) ?? []), { seq, time, event }]);
  for (const m of c.messages) {
    if (m.type === "replay") for (const r of m.runs) r.events.forEach((e, seq) => add(r.id, seq, e.time, e.event));
    if (m.type === "event") add(m.run, m.seq, m.time, m.event);
  }
  return runs;
};
/** Every run's events are exactly 0, 1, 2, … : no gap and no duplicate. */
const contiguous = (c: Client): void => {
  for (const [run, events] of perRun(c)) assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i), `run ${run} has a gap or a duplicate`);
};
const hasEnded = (c: Client, run: number) => (perRun(c).get(run) ?? []).some((e) => e.event._tag === "Ended");
const pending = (c: Client, run: number) => {
  const events = perRun(c).get(run) ?? [];
  const last = [...events].reverse().find((e) => e.event._tag === "Asked" || e.event._tag === "Answered");
  return last?.event._tag === "Asked" ? last.event : null;
};
const refusals = (c: Client) => c.messages.flatMap((m) => (m.type === "refused" ? [m.reason] : []));

test("on connect: hello and an empty replay", async () => {
  const repo = tempRepo();
  await serve(await managerOf(repo, []), dist(), async (port) => {
    const c = await connect(port);
    await until("two messages", () => c.messages.length >= 2);
    assert.deepEqual(c.messages.slice(0, 2), [{ type: "hello", cwd: repo, location: repo, current: null, incarnation: "test" }, { type: "replay", runs: [], ui: [] }]);
    c.close();
  });
});

test("the page and its assets are served; any other path, and a path out of the build, is 404", async () => {
  const repo = tempRepo();
  await serve(await managerOf(repo, []), dist(), async (port) => {
    const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`);
    const page = await get("/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Interloq/);
    assert.equal((await get("/assets/app.js")).status, 200);
    assert.equal((await get("/nope")).status, 404);
    assert.equal((await get("/assets/..%2F..%2Fetc%2Fpasswd")).status, 404);
  });
});

// Finding 2 of docs/gui-review.md: a malformed target is a deliberate 400, not a defect (500).
test("a malformed percent escape or invalid UTF-8 escape is 400; traversal stays 404", async () => {
  const repo = tempRepo();
  await serve(await managerOf(repo, []), dist(), async (port) => {
    const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`);
    assert.equal((await get("/%ZZ")).status, 400);
    assert.equal((await get("/%C0%AF")).status, 400);
    assert.equal((await get("/../x")).status, 404);
    assert.equal((await get("/%2e%2e/x")).status, 404);
    assert.equal((await get("/assets/app.js")).status, 200);
  });
});

test("requestTarget decodes the path of a request target and reports a malformed one", () => {
  assert.deepEqual(requestTarget("/assets/a%20b.js"), Result.succeed("/assets/a b.js"));
  assert.deepEqual(requestTarget("/%ZZ"), Result.fail("malformed"));
  assert.deepEqual(requestTarget("/%C0%AF"), Result.fail("malformed"));
  assert.deepEqual(requestTarget("//["), Result.fail("malformed"));
});

test("a started run's events reach two clients in the same order with increasing seq", async () => {
  const repo = tempRepo();
  await serve(await managerOf(repo, [converging]), dist(), async (port) => {
    const a = await connect(port);
    const b = await connect(port);
    await until("the replays", () => a.messages.length >= 2 && b.messages.length >= 2);
    a.send({ type: "start", project: repo, task: "task" });
    await until("the end of run 1", () => hasEnded(a, 1) && hasEnded(b, 1));
    const events = (c: Client) => c.messages.filter((m) => m.type === "event");
    assert.deepEqual(events(a), events(b));
    contiguous(a);
    assert.equal(perRun(a).get(1)?.[0].event._tag, "Started");
    a.close();
    b.close();
  });
});

test("a client that connects mid-run gets the replay with the pending prompt and can answer; a second answer is ignored", async () => {
  const repo = tempRepo();
  await serve(await managerOf(repo, [withQuestion]), dist(), async (port) => {
    const a = await connect(port);
    a.send({ type: "start", project: repo, task: "task" });
    await until("the prompt", () => pending(a, 1) !== null);
    const late = await connect(port);
    await until("the replay", () => late.messages.some((m) => m.type === "replay"));
    const asked = pending(late, 1);
    assert.ok(asked !== null && asked._tag === "Asked" && asked.kind === "decision");
    assert.equal((late.messages[0] as { current: number | null }).current, 1);
    late.send({ type: "answer", incarnation: "test", run: 1, prompt: asked.prompt, text: "PostgreSQL" });
    a.send({ type: "answer", incarnation: "test", run: 1, prompt: asked.prompt, text: "SQLite" });
    await until("the end", () => hasEnded(a, 1));
    await until("the refusal of the second answer", () => refusals(a).length > 0);
    assert.match(refusals(a)[0], /already been answered/);
    assert.match(fs.readFileSync(path.join(runDirOf(repo), "user-decisions.md"), "utf8"), /Decision: PostgreSQL/);
    contiguous(a);
    contiguous(late);
    a.close();
    late.close();
  });
});

test("an event appended between the subscription and the snapshot reaches the client exactly once", async () => {
  const repo = tempRepo();
  const real = await managerOf(repo, [withQuestion]);
  let hook: Effect.Effect<void> = Effect.void;
  // The handler subscribes first, then reads the replay: the hook runs in between.
  const manager: RunManager = { ...real, replay: Effect.suspend(() => hook).pipe(Effect.andThen(real.replay)) };
  await serve(manager, dist(), async (port) => {
    const a = await connect(port);
    a.send({ type: "start", project: repo, task: "task" });
    await until("the prompt", () => pending(a, 1) !== null);
    const asked = pending(a, 1)!;
    hook = real.answer("test", 1, (asked as { prompt: number }).prompt, "PostgreSQL").pipe(Effect.andThen(Effect.sleep("20 millis")), Effect.asVoid);
    const b = await connect(port);
    hook = Effect.void;
    await until("the end on b", () => hasEnded(b, 1));
    contiguous(b);
    assert.equal((perRun(b).get(1) ?? []).filter((e) => e.event._tag === "Answered").length, 1);
    a.close();
    b.close();
  });
});

test("a run that ends between the subscription and the snapshot is received once, in the replay", async () => {
  const repo = tempRepo();
  const real = await managerOf(repo, [withQuestion]);
  let hook: Effect.Effect<void> = Effect.void;
  const manager: RunManager = { ...real, replay: Effect.suspend(() => hook).pipe(Effect.andThen(real.replay)) };
  await serve(manager, dist(), async (port) => {
    const a = await connect(port);
    a.send({ type: "start", project: repo, task: "task" });
    await until("the prompt", () => pending(a, 1) !== null);
    hook = real.stop("test", 1).pipe(Effect.asVoid);
    const b = await connect(port);
    hook = Effect.void;
    await until("b's replay", () => b.messages.some((m) => m.type === "replay"));
    await sleep(50);
    const replay = b.messages.find((m) => m.type === "replay");
    assert.ok(replay?.type === "replay" && replay.runs.length === 1 && replay.runs[0].events.at(-1)?.event._tag === "Ended");
    assert.equal(b.messages.filter((m) => m.type === "event").length, 0, "buffered events of the ended run were sent again");
    contiguous(b);
    a.close();
    b.close();
  });
});

test("a connection kept open across two runs receives run 2 from its Started, with no gap in either run", async () => {
  const repo = tempRepo();
  await serve(await managerOf(repo, [withQuestion, converging]), dist(), async (port) => {
    const a = await connect(port);
    a.send({ type: "start", project: repo, task: "first" });
    await until("the prompt", () => pending(a, 1) !== null);
    // A connection made well into run 1.
    const late = await connect(port);
    await until("the replay", () => late.messages.some((m) => m.type === "replay"));
    const replay = late.messages.find((m) => m.type === "replay");
    const atConnect = replay?.type === "replay" ? (replay.runs[0]?.events.length ?? 0) : 0;
    assert.ok(atConnect >= 5, `run 1 had only ${atConnect} events at the connection`);
    a.send({ type: "stop", incarnation: "test", run: 1 });
    await until("the end of run 1", () => hasEnded(late, 1));
    assert.equal((perRun(late).get(1) ?? []).find((e) => e.event._tag === "Ended")?.event._tag, "Ended");
    a.send({ type: "start", project: repo, task: "second" });
    await until("the end of run 2", () => hasEnded(late, 2) && hasEnded(a, 2));
    for (const c of [a, late]) {
      contiguous(c);
      assert.equal(perRun(c).get(2)?.[0].seq, 0);
      assert.equal(perRun(c).get(2)?.[0].event._tag, "Started");
    }
    // Issue #1: every event carries its publication time, live and replayed, and the tab that joined late has, for each
    // event of run 1, the time the tab that saw it live has.
    for (const c of [a, late]) for (const [run, events] of perRun(c)) for (const e of events) assert.ok(!Number.isNaN(Date.parse(e.time)), `run ${run} seq ${e.seq} has no time`);
    const timesOf = (c: Client) => (perRun(c).get(1) ?? []).map((e) => e.time);
    assert.deepEqual(timesOf(late), timesOf(a));
    assert.ok(atConnect > 0 && timesOf(late).length > atConnect, "run 1 reached the late tab both by replay and live");
    const ended1 = (perRun(a).get(1) ?? []).find((e) => e.event._tag === "Ended")?.event;
    assert.deepEqual(ended1, { _tag: "Ended", code: 130 });
    a.close();
    late.close();
  });
});

test("an answer or a stop naming an ended run is refused; a frame that is not a message is refused", async () => {
  const repo = tempRepo();
  await serve(await managerOf(repo, [converging]), dist(), async (port) => {
    const a = await connect(port);
    a.send({ type: "start", project: repo, task: "task" });
    await until("the end", () => hasEnded(a, 1));
    a.send({ type: "answer", incarnation: "test", run: 1, prompt: 1, text: "late" });
    a.send({ type: "stop", incarnation: "test", run: 1 });
    await until("two refusals", () => refusals(a).length >= 2);
    assert.deepEqual(refusals(a).slice(0, 2).map((r) => /that run has ended/.test(r)), [true, true]);
    (a as unknown as { send: (m: unknown) => void }).send("not a message" as never);
    await until("the frame's refusal", () => refusals(a).length >= 3);
    assert.match(refusals(a)[2], /not a message|not JSON|Expected/);
    a.close();
  });
});

test("start with a bad path is refused with the reason; list gives the subdirectories", async () => {
  const repo = tempRepo();
  fs.mkdirSync(path.join(repo, "src"));
  fs.mkdirSync(path.join(repo, "docs"));
  await serve(await managerOf(repo, []), dist(), async (port) => {
    const a = await connect(port);
    a.send({ type: "start", project: path.join(repo, "missing"), task: "t" });
    await until("the refusal", () => refusals(a).length > 0);
    assert.match(refusals(a)[0], /does not exist/);
    a.send({ type: "list", path: repo });
    await until("the listing", () => a.messages.some((m) => m.type === "listing"));
    const listing = a.messages.find((m) => m.type === "listing");
    assert.deepEqual(listing, { type: "listing", path: repo, parent: path.dirname(repo), dirs: [".git", "docs", "src"], error: null });
    a.send({ type: "list", path: path.join(repo, "missing") });
    await until("the second listing", () => a.messages.filter((m) => m.type === "listing").length >= 2);
    assert.notEqual((a.messages.filter((m) => m.type === "listing")[1] as { error: string | null }).error, null);
    a.close();
  });
});

// Finding 11 of docs/gui-review.md, connection cancellation: a start whose connection closes at once leaves either no
// run or a run that the next tab sees, can stop, and after which it can start another.
test("a client that sends start and closes at once leaves the server in a state the next client can recover from", async () => {
  const repo = tempRepo();
  const hanging: TestOptions = { steps: [{ hang: true }] };
  await serve(await managerOf(repo, [hanging, hanging, hanging, converging]), dist(), async (port) => {
    for (let i = 0; i < 3; i++) {
      const quick = await connect(port);
      quick.send({ type: "start", project: repo, task: `quick ${i}` });
      quick.close();
      await sleep(20 * i);
      const next = await connect(port);
      await until("hello", () => next.messages.some((m) => m.type === "hello"));
      const hello = next.messages.find((m) => m.type === "hello");
      const current = hello?.type === "hello" ? hello.current : null;
      if (current !== null) {
        next.send({ type: "stop", incarnation: "test", run: current });
        await until(`the end of run ${current}`, () => hasEnded(next, current));
      }
      assert.deepEqual(refusals(next), []);
      next.close();
    }
    // A quick start may reach the server after the next tab's hello (on a loaded machine it does): its run then begins
    // later, and the last tab sees it live, stops it, and starts its own, as finding 11 requires of a recovering tab.
    const last = await connect(port);
    await until("hello", () => last.messages.some((m) => m.type === "hello"));
    const hello = last.messages.find((m) => m.type === "hello");
    const running = (): number[] => [
      ...new Set([...(hello?.type === "hello" && hello.current !== null ? [hello.current] : []), ...perRun(last).keys()]),
    ].filter((run) => !hasEnded(last, run));
    const afterStarted = () => [...perRun(last).values()].some((events) => events[0]?.event._tag === "Started" && (events[0].event as { task: string }).task === "after");
    for (let attempt = 0; attempt < 5 && !afterStarted(); attempt++) {
      for (const run of running()) {
        last.send({ type: "stop", incarnation: "test", run });
        await until(`the end of run ${run}`, () => hasEnded(last, run));
      }
      const before = refusals(last).length;
      last.send({ type: "start", project: repo, task: "after" });
      await until("the start's outcome", () => afterStarted() || refusals(last).length > before);
    }
    assert.ok(afterStarted(), `no run 'after' started; refusals: ${JSON.stringify(refusals(last))}`);
    assert.deepEqual(
      refusals(last).filter((r) => r !== "a run is in progress; stop it or wait for its end"),
      [],
      "a start was refused for another reason than a late run in progress",
    );
    last.close();
  });
});

// Finding 15 of docs/gui-review.md: the server can be stopped while a tab holds its WebSocket.
type Watched = Client & { closedAt: () => number | null };
const watch = (port: number): Promise<Watched> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: ServerMessage[] = [];
    let closedAt: number | null = null;
    ws.onmessage = (e) => void messages.push(JSON.parse(String(e.data)));
    ws.onclose = () => void (closedAt = messages.length);
    ws.onerror = () => reject(new Error("the WebSocket failed"));
    ws.onopen = () => resolve({ messages, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close(), closedAt: () => closedAt });
  });
const serving = async (closingFirst: boolean) => {
  const repo = tempRepo();
  const portOf = await run(Deferred.make<number>());
  const fiber = Effect.runFork(server(await managerOf(repo, []), dist(), (port) => Deferred.succeed(portOf, port).pipe(Effect.andThen(Effect.never)), closingFirst));
  const client = await watch(await run(Deferred.await(portOf)));
  await until("hello", () => client.messages.some((m) => m.type === "hello"));
  const interruption = Effect.runFork(Fiber.interrupt(fiber));
  return { client, done: run(Fiber.await(interruption).pipe(Effect.timeout("2 seconds"), Effect.exit)) };
};

test("interrupting the server with a tab connected completes at once, and the tab is told before its socket closes", async () => {
  const { client, done } = await serving(false);
  assert.ok(Exit.isSuccess(await done), "the server did not finish within 2 s with a tab connected");
  await until("the close", () => client.closedAt() !== null);
  const closing = client.messages.findIndex((m) => m.type === "closing");
  assert.ok(closing >= 0, "the tab was not told that the server is closing");
  assert.ok(closing < client.closedAt()!, "the notice came after the close");
});

test("the closing finalizer registered before serveEffect runs after the HTTP shutdown, which waits for the tab", async () => {
  const { client, done } = await serving(true);
  assert.ok(Exit.isFailure(await done), "the server finished although the finalizer order was wrong");
  client.close();
});

// Finding 13 of docs/gui-review.md: a tab that falls behind by the bound is told, disconnected and recovers by replay.
test("a tab that falls behind by its queue's bound is told, its socket is closed, and a reconnect gets the whole replay", async () => {
  const listeners: ((b: Broadcast) => Effect.Effect<void>)[] = [];
  const time = "2026-09-27T14:00:00.000Z";
  const events: Stamped[] = [{ time, event: { _tag: "Started", project: "/p", location: "/p", task: "t" } }, ...Array.from({ length: 20 }, (_, i): Stamped => ({ time, event: { _tag: "Said", text: `line ${i}` } }))];
  const fake: RunManager = {
    cwd: "/p",
    location: "/p",
    incarnation: "test",
    subscribe: (listener) => Effect.acquireRelease(Effect.sync(() => void listeners.push(listener)), () => Effect.sync(() => void listeners.splice(listeners.indexOf(listener), 1))).pipe(Effect.asVoid),
    replay: Effect.succeed({ runs: [{ id: 1, events }], ui: [] }),
    current: Effect.succeed(1),
    start: () => Effect.succeed({ refused: "not in this test" }),
    stop: () => Effect.succeed(null),
    answer: () => Effect.succeed(null),
    setUi: () => Effect.succeed(null),
  };
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        const web = yield* makeWebServer(fake, dist(), 3);
        yield* HttpServer.serveEffect(web.handler);
        yield* Effect.addFinalizer(() => web.closeAll);
        const address = (yield* HttpServer.HttpServer).address;
        const port = address._tag === "UnixPathAddress" ? 0 : address.port;
        yield* Effect.promise(async () => {
          const slow = await watch(port);
          await until("the subscription", () => listeners.length === 1);
          // A burst of events, faster than the tab's forwarding: its queue holds 3. The session may end during it.
          const listener = listeners[0];
          await run(Effect.forEach(Array.from({ length: 20 }, (_, i) => i + 21), (seq) => listener({ _tag: "event", run: 1, seq, time, event: { _tag: "Said", text: `later ${seq}` } }), { discard: true }));
          await until("the close", () => slow.closedAt() !== null);
          assert.ok(refusals(slow).some((r) => /too far behind/.test(r)), `refusals: ${refusals(slow)}`);
          await until("the listener's removal", () => listeners.length === 0);
          const again = await connect(port);
          await until("the replay", () => again.messages.some((m) => m.type === "replay"));
          const replay = again.messages.find((m) => m.type === "replay");
          assert.equal(replay?.type === "replay" ? replay.runs[0].events.length : 0, events.length);
          again.close();
        });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});

// Issue #87 (decision G-R1-1): the seam of the shared state. Two tabs of one run, and a third that connects later, fold
// the server's frames with the page's own reducer and agree on which entries are open; an entry of one decision is a
// different entry from one of another decision with the same id. The state is the server's, held beside the run, so the
// run here waits in its first call and reaches no decision: the state's key, not the run's events, is what is tested.
test("tabs of one run agree on the open entries, live and from the replay, keyed by decision and entry", async () => {
  const repo = tempRepo();
  await serve(await managerOf(repo, [{ steps: [{ hang: true }] }]), dist(), async (port) => {
    const a = await connect(port);
    const b = await connect(port);
    await until("the replays", () => a.messages.length >= 2 && b.messages.length >= 2);
    a.send({ type: "start", project: repo, task: "task" });
    await until("the run's start in both tabs", () => (perRun(a).get(1)?.length ?? 0) > 1 && (perRun(b).get(1)?.length ?? 0) > 1);
    const incarnation = (a.messages[0] as Extract<ServerMessage, { type: "hello" }>).incarnation;
    const view = (c: Client) => c.messages.reduce(reduce, initialState).run;
    const e1 = (decision: number) => ({ _tag: "DecisionEntry" as const, decision, entry: "e1" });
    a.send({ type: "ui", incarnation, run: 1, flag: { scope: e1(1), open: true } });
    await until("the state in both tabs", () => view(a)?.ui.version === 1 && view(b)?.ui.version === 1);
    for (const c of [a, b]) {
      assert.equal(isOpen(view(c)!.ui, e1(1)), true);
      assert.equal(isOpen(view(c)!.ui, e1(2)), false, "decision 2's entry e1 is another entry");
    }
    // A change interleaved with the run's events: every tab ends with the same view.
    b.send({ type: "ui", incarnation, run: 1, flag: { scope: e1(2), open: true } });
    b.send({ type: "ui", incarnation, run: 1, flag: { scope: e1(1), open: false } });
    await until("the second state in both tabs", () => view(a)?.ui.version === 3 && view(b)?.ui.version === 3);
    const c = await connect(port);
    await until("the third tab's replay", () => c.messages.length >= 2);
    assert.deepEqual(view(c)!.ui, view(a)!.ui);
    assert.deepEqual(view(b)!.ui, view(a)!.ui);
    assert.deepEqual([isOpen(view(c)!.ui, e1(1)), isOpen(view(c)!.ui, e1(2))], [false, true]);
    contiguous(a);
    a.send({ type: "stop", incarnation, run: 1 });
    await until("the end of run 1", () => hasEnded(a, 1));
    for (const x of [a, b, c]) x.close();
  });
});

// Issue #63: a rail phase the user closed reaches every tab, live and from the replay, as closed, beside an open entry
// of a decision of the same run; a phase nobody touched stays untouched.
test("tabs of one run agree that a rail phase is closed, live and from the replay, beside an open decision entry", async () => {
  const repo = tempRepo();
  await serve(await managerOf(repo, [{ steps: [{ hang: true }] }]), dist(), async (port) => {
    const a = await connect(port);
    const b = await connect(port);
    await until("the replays", () => a.messages.length >= 2 && b.messages.length >= 2);
    a.send({ type: "start", project: repo, task: "task" });
    await until("the run's start in both tabs", () => (perRun(a).get(1)?.length ?? 0) > 1 && (perRun(b).get(1)?.length ?? 0) > 1);
    const incarnation = (a.messages[0] as Extract<ServerMessage, { type: "hello" }>).incarnation;
    const view = (c: Client) => c.messages.reduce(reduce, initialState).run;
    const phase = { _tag: "RailPhase" as const, phase: "planning-1" };
    const entry = { _tag: "DecisionEntry" as const, decision: 1, entry: "e1" };
    a.send({ type: "ui", incarnation, run: 1, flag: { scope: phase, open: false } });
    b.send({ type: "ui", incarnation, run: 1, flag: { scope: entry, open: true } });
    await until("both states in both tabs", () => view(a)?.ui.version === 2 && view(b)?.ui.version === 2);
    const c = await connect(port);
    await until("the third tab's replay", () => c.messages.length >= 2);
    for (const x of [a, b, c]) {
      assert.equal(choiceOf(view(x)!.ui, phase), "closed");
      assert.equal(choiceOf(view(x)!.ui, entry), "open");
      assert.equal(choiceOf(view(x)!.ui, { _tag: "RailPhase", phase: "execution-1" }), "untouched");
    }
    a.send({ type: "stop", incarnation, run: 1 });
    await until("the end of run 1", () => hasEnded(a, 1));
    for (const x of [a, b, c]) x.close();
  });
});

// Issue #87, work review 1 (W1-R1-2): the seam of the shared state over a run that reaches two real decisions whose
// analyses both contain the entry e1, with a change of the shared state sent while the run's events of an answer are
// being published. Every tab, a late one included, folds the server's frames into the same whole view.
test("two real decisions sharing entry e1: interleaved with run events, every tab reduces to the same whole view", async () => {
  const repo = tempRepo();
  const el = (text: string) => ({ text, counterarguments: [] });
  const entry = (id: string, title: string) => ({ id, title, comparative_condition: el(`c ${title}`), starting_cause: el("s"), intermediate_steps: el("i"), threshold: el("t"), effect_on_persons: el("e"), reason_the_effect_matters: el("r"), extent: { per_person: el("p"), persons_affected: el("a"), likelihood: el("l"), timing: el("w") } });
  const analysis = (decision: string, x: string, y: string, title: string) => ({
    decision,
    columns: [
      { kind: "argued", option: x, advantages: [entry("e1", title)], disadvantages: [] },
      { kind: "argued", option: y, advantages: [], disadvantages: [entry("e2", `${title} costs.`)] },
    ],
    recommendation: { option: "", reason: "" },
  });
  const options = (x: string, y: string) => [{ label: x, description: `${x} it is` }, { label: y, description: `${y} it is` }];
  const script: TestOptions = {
    steps: [
      { output: { questions_for_user: [questionOf({ context: "c", question: "Which database?", terms: [], options: options("SQLite", "PostgreSQL") }), questionOf({ context: "c", question: "Which cache?", terms: [], options: options("Redis", "Memcached") })] }, plan: "v1" },
      { output: analysis("Which database?", "SQLite", "PostgreSQL", "The first decision's advantage.") },
      { output: analysis("Which cache?", "Redis", "Memcached", "The second decision's advantage.") },
      { output: noQuestions },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  };
  const analyzed = (c: Client, decision: number) =>
    (perRun(c).get(1) ?? []).some((e) => e.event._tag === "Notified" && e.event.event._tag === "DecisionAnalyzed" && e.event.event.decision === decision);
  const askedAfter = (c: Client, decision: number) => {
    const events = perRun(c).get(1) ?? [];
    const at = events.findIndex((e) => e.event._tag === "Notified" && e.event.event._tag === "DecisionAnalyzed" && e.event.event.decision === decision);
    const asked = pending(c, 1);
    return at >= 0 && asked !== null && events.findIndex((e) => e.event === asked) > at ? asked : null;
  };
  await serve(await managerOf(repo, [script]), dist(), async (port) => {
    const a = await connect(port);
    const b = await connect(port);
    await until("the replays", () => a.messages.length >= 2 && b.messages.length >= 2);
    const incarnation = (a.messages[0] as Extract<ServerMessage, { type: "hello" }>).incarnation;
    const answer = (c: Client, text: string) => c.send({ type: "answer", incarnation, run: 1, prompt: pending(c, 1)!.prompt, text });
    const e1 = (decision: number) => ({ _tag: "DecisionEntry" as const, decision, entry: "e1" });
    const ui = (c: Client, decision: number, open: boolean) => c.send({ type: "ui", incarnation, run: 1, flag: { scope: e1(decision), open } });
    a.send({ type: "start", project: repo, task: "task" });
    await until("the first question", () => pending(a, 1) !== null);
    answer(a, "/decide");
    await until("decision 1's analysis and its question asked again", () => askedAfter(a, 1) !== null && askedAfter(b, 1) !== null);
    ui(a, 1, true);
    await until("the state in both tabs", () => [a, b].every((c) => c.messages.some((m) => m.type === "ui" && m.state.version === 1)));
    // B's answer publishes run events; A's changes are sent at once, so they interleave with them.
    const first = pending(b, 1)!.prompt;
    answer(b, "1");
    ui(a, 1, false);
    ui(a, 1, true);
    await until("the second question", () => (pending(a, 1)?.prompt ?? first) > first && !analyzed(a, 2));
    answer(a, "/decide");
    await until("decision 2's analysis and its question in both tabs", () => askedAfter(a, 2) !== null && askedAfter(b, 2) !== null);
    await until("the last state in both tabs", () => [a, b].every((c) => c.messages.some((m) => m.type === "ui" && m.state.version === 3)));
    const c = await connect(port);
    await until("the third tab's replay", () => c.messages.some((m) => m.type === "replay"));
    const view = (x: Client) => x.messages.reduce(reduce, initialState).run;
    const [va, vb, vc] = [view(a), view(b), view(c)];
    assert.deepEqual(vb, va, "tab B's view differs from tab A's");
    assert.deepEqual(vc, va, "the late tab's view differs from tab A's");
    for (const v of [va, vb, vc]) {
      assert.equal(v?.analysis?.event.decision, 2);
      assert.deepEqual([isOpen(v!.ui, e1(1)), isOpen(v!.ui, e1(2))], [true, false]);
    }
    contiguous(a);
    a.send({ type: "stop", incarnation, run: 1 });
    await until("the end of run 1", () => hasEnded(a, 1));
    for (const x of [a, b, c]) x.close();
  });
});

// Issue #29, the seam: the location the server puts in hello and on Started is the one the page's reducer folds.
test("the identification the server sends in hello and on Started, decoded and folded by the page, is the manager's", async () => {
  const repo = tempRepo();
  const mounts: MountTable = [{ root: "/host/proj", point: path.dirname(repo) }];
  const manager = await managerOf(repo, [converging], mounts);
  await serve(manager, dist(), async (port) => {
    const c = await connect(port);
    await until("hello and replay", () => c.messages.length >= 2);
    c.send({ type: "start", project: repo, task: "t" });
    await until("the run's end", () => hasEnded(c, 1));
    const decoded = c.messages.map((m) => Schema.decodeUnknownSync(ServerMessageSchema)(m));
    const state = decoded.reduce(reduce, initialState);
    assert.equal(state.location, manager.location);
    assert.equal(state.location, identify(mounts, repo));
    assert.equal(state.run?.location, identify(mounts, repo));
    assert.equal(state.run?.project, repo);
    c.close();
  });
});

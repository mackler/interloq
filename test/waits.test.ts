// Issue #215: the registry of the waits the developer may end early (src/waits.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Clock, Effect, Fiber } from "effect";
import { makeWaits, unendableWait, waitCounter, type WaitEnd } from "../src/waits.ts";
import { heldClock } from "./helpers.ts";

const run = <A>(effect: Effect.Effect<A>, clock: Clock.Clock): Promise<A> => Effect.runPromise(effect.pipe(Effect.provideService(Clock.Clock, clock)));

test("an open wait ended is ended, and its sleep ends early without the clock advancing", async () => {
  const held = heldClock(1000);
  const [result, end] = await run(
    Effect.gen(function* () {
      const waits = yield* makeWaits(yield* waitCounter);
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* waits.open;
          const fiber = yield* Effect.forkChild(handle.sleepUntil(61_000));
          yield* Effect.promise(() => held.sleepRegistered(60_000));
          const result = yield* waits.end(handle.id);
          const end: WaitEnd = yield* Fiber.join(fiber);
          return [result, end] as const;
        }),
      );
    }),
    held.clock,
  );
  assert.equal(result, "ended");
  assert.equal(end, "endedEarly");
});

test("a wait that ran out reports ranOut, and a later end is alreadyEnded", async () => {
  const held = heldClock(0);
  const [end, later] = await run(
    Effect.gen(function* () {
      const waits = yield* makeWaits(yield* waitCounter);
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* waits.open;
          const fiber = yield* Effect.forkChild(handle.sleepUntil(5000));
          yield* Effect.promise(() => held.sleepRegistered(5000));
          held.advance(5000);
          const end = yield* Fiber.join(fiber);
          return [end, yield* waits.end(handle.id)] as const;
        }),
      );
    }),
    held.clock,
  );
  assert.equal(end, "ranOut");
  assert.equal(later, "alreadyEnded");
});

test("an id never allocated is notWaiting", async () => {
  const held = heldClock(0);
  const result = await run(Effect.flatMap(Effect.flatMap(waitCounter, makeWaits), (waits) => waits.end(7)), held.clock);
  assert.equal(result, "notWaiting");
});

test("a wait whose scope closed is alreadyEnded", async () => {
  const held = heldClock(0);
  const result = await run(
    Effect.gen(function* () {
      const waits = yield* makeWaits(yield* waitCounter);
      const fiber = yield* Effect.forkChild(Effect.scoped(Effect.flatMap(waits.open, (h) => h.sleepUntil(5000))));
      yield* Effect.promise(() => held.sleepRegistered(5000));
      yield* Fiber.interrupt(fiber);
      return yield* waits.end(1);
    }),
    held.clock,
  );
  assert.equal(result, "alreadyEnded");
});

test("two registries over one counter allocate distinct ids, and neither ends the other's wait", async () => {
  const held = heldClock(0);
  const [a, b, crossed, endA, endB] = await run(
    Effect.gen(function* () {
      const counter = yield* waitCounter;
      const waitsA = yield* makeWaits(counter);
      const waitsB = yield* makeWaits(counter);
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const a = yield* waitsA.open;
          const b = yield* waitsB.open;
          const crossed = yield* waitsB.end(a.id);
          const fa = yield* Effect.forkChild(a.sleepUntil(1000));
          const fb = yield* Effect.forkChild(b.sleepUntil(1000));
          yield* Effect.promise(() => held.sleepRegistered(1000));
          held.advance(1000);
          return [a.id, b.id, crossed, yield* Fiber.join(fa), yield* Fiber.join(fb)] as const;
        }),
      );
    }),
    held.clock,
  );
  assert.notEqual(a, b);
  assert.equal(crossed, "notWaiting");
  assert.equal(endA, "ranOut");
  assert.equal(endB, "ranOut");
});

test("the unendable wait sleeps and runs out", async () => {
  const held = heldClock(0);
  const fiber = Effect.runFork(Effect.scoped(Effect.flatMap(unendableWait, (h) => h.sleepUntil(3000))).pipe(Effect.provideService(Clock.Clock, held.clock)));
  await held.sleepRegistered(3000);
  held.advance(3000);
  assert.equal(await Effect.runPromise(Fiber.join(fiber)), "ranOut");
});

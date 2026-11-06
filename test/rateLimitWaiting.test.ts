// Work review 1 of issue #219 (W1-R1-1): the operations of one wrapped tracker share one rate-limit wait.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Clock, Effect, Fiber } from "effect";
import { TrackerRateLimited } from "../src/errors.ts";
import { type RateLimitWait, rateLimitWaiting } from "../src/trackerRetry.ts";
import { makeWaits, waitCounter } from "../src/waits.ts";
import { fakeTrackerOf, heldClock, MANAGER_ITEMS } from "./helpers.ts";

const refused = new TrackerRateLimited({ tracker: "GitLab", status: 429, message: "GitLab answered GET 1 with status 429", reset: { _tag: "After", seconds: 30 } });
const [first, second] = [MANAGER_ITEMS[0]!.id, MANAGER_ITEMS[1]!.id];

const setup = async (refusals: number) => {
  const fake = fakeTrackerOf(MANAGER_ITEMS);
  for (let n = 0; n < refusals; n++) await Effect.runPromise(fake.failNext("comments", refused));
  const held = heldClock(0);
  const told: RateLimitWait[] = [];
  const wrapped = await Effect.runPromise(Effect.gen(function* () {
    const waits = yield* makeWaits(yield* waitCounter);
    return yield* rateLimitWaiting(fake.tracker, waits, (w) => Effect.sync(() => void told.push(w)));
  }));
  const fork = <A, E>(effect: Effect.Effect<A, E>) => Effect.runFork(effect.pipe(Effect.provideService(Clock.Clock, held.clock)));
  return { wrapped, held, told, fork };
};

test("two concurrent operations refused for the rate limit open one wait, and its end resumes both", async () => {
  const { wrapped, held, told, fork } = await setup(2);
  const a = fork(wrapped.comments(first));
  const b = fork(wrapped.comments(second));
  await held.sleepRegistered(31_000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(told.length, 1);
  assert.deepEqual(held.sleeps(), [31_000]);
  held.advance(31_000);
  assert.deepEqual(await Effect.runPromise(Fiber.join(a)), []);
  assert.deepEqual(await Effect.runPromise(Fiber.join(b)), []);
  assert.equal(told.length, 1);
});

test("the leader interrupted during the wait leaves its follower to try again rather than hang", async () => {
  const { wrapped, held, told, fork } = await setup(2);
  const leader = fork(wrapped.comments(first));
  await held.sleepRegistered(31_000);
  const follower = fork(wrapped.comments(second));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(told.length, 1);
  await Effect.runPromise(Fiber.interrupt(leader));
  const answered = await Promise.race([Effect.runPromise(Fiber.join(follower)), new Promise((resolve) => setTimeout(() => resolve("hung"), 5_000))]);
  assert.deepEqual(answered, []);
});

// Issue #215: over random sequences of opens, ends and run-outs across two registries sharing one counter, `end` answers
// `ended` exactly for an id open in that registry, and every wait reports `endedEarly` exactly when an end of it did.
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { Clock, Effect, Fiber, Scope } from "effect";
import { makeWaits, waitCounter, type EndWaitResult, type WaitEnd, type WaitHandle, type Waits } from "../src/waits.ts";
import { heldClock } from "./helpers.ts";

type Op = Readonly<{ kind: "open"; reg: 0 | 1 }> | Readonly<{ kind: "end"; reg: 0 | 1; pick: number }> | Readonly<{ kind: "runOut"; pick: number }>;
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("open" as const), reg: fc.constantFrom(0 as const, 1 as const) }),
  fc.record({ kind: fc.constant("end" as const), reg: fc.constantFrom(0 as const, 1 as const), pick: fc.nat(20) }),
  fc.record({ kind: fc.constant("runOut" as const), pick: fc.nat(20) }),
);

type Opened = { reg: 0 | 1; handle: WaitHandle; fiber: Fiber.Fiber<WaitEnd>; untilMs: number; open: boolean; ended: boolean };

test("end is ended exactly for an open wait of its registry, and a wait ends early exactly when ended", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(opArb, { maxLength: 25 }), async (ops) => {
      const held = heldClock(0);
      await Effect.runPromise(
        Effect.gen(function* () {
          const counter = yield* waitCounter;
          const regs: readonly Waits[] = [yield* makeWaits(counter), yield* makeWaits(counter)];
          const scope = yield* Scope.make();
          const opened: Opened[] = [];
          for (const op of ops) {
            if (op.kind === "open") {
              const handle = yield* Scope.provide(regs[op.reg].open, scope);
              const untilMs = (yield* Clock.currentTimeMillis) + 1000 + opened.length;
              const fiber = yield* Effect.forkChild(handle.sleepUntil(untilMs));
              yield* Effect.yieldNow;
              opened.push({ reg: op.reg, handle, fiber, untilMs, open: true, ended: false });
            } else if (op.kind === "end") {
              const ids = [...opened.map((o) => o.handle.id), 999];
              const id = ids[op.pick % ids.length];
              const target = opened.find((o) => o.handle.id === id);
              const result: EndWaitResult = yield* regs[op.reg].end(id);
              const expected: EndWaitResult = target === undefined || target.reg !== op.reg ? "notWaiting" : target.open ? "ended" : "alreadyEnded";
              assert.equal(result, expected);
              if (result === "ended" && target !== undefined) {
                target.open = false;
                target.ended = true;
              }
            } else {
              const live = opened.filter((o) => o.open);
              if (live.length === 0) continue;
              const target = live[op.pick % live.length];
              const now = yield* Clock.currentTimeMillis;
              held.advance(Math.max(target.untilMs - now, 0));
              for (const o of opened.filter((o) => o.open && o.untilMs <= target.untilMs)) {
                assert.equal(yield* Fiber.join(o.fiber), "ranOut");
                o.open = false;
              }
            }
          }
          for (const o of opened.filter((o) => o.ended)) assert.equal(yield* Fiber.join(o.fiber), "endedEarly");
          yield* Scope.close(scope, { _tag: "Success", value: undefined } as never);
        }).pipe(Effect.provideService(Clock.Clock, held.clock)),
      );
    }),
    { numRuns: 100 },
  );
});

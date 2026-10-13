import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import fc from "fast-check";
import { Effect } from "effect";
import { faultText, firstProcessFault } from "../src/processFault.ts";

// Issue #158: the process's first uncaught exception or unhandled rejection, from an emitter standing for `process`.

test("an uncaught exception completes firstProcessFault with its kind and a text naming the message", async () => {
  const target = new EventEmitter();
  const fault = Effect.runPromise(firstProcessFault(target));
  target.emit("uncaughtException", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  assert.deepEqual(await fault, { kind: "uncaughtException", text: "write EPIPE" });
});

test("the code is named where the message does not name it", () => {
  assert.equal(faultText(Object.assign(new Error("the socket failed"), { code: "EPIPE" })), "the socket failed (EPIPE)");
});

test("an unhandled rejection of a value that is no Error completes it with that value as text", async () => {
  const target = new EventEmitter();
  const fault = Effect.runPromise(firstProcessFault(target));
  target.emit("unhandledRejection", "lost", Promise.resolve());
  assert.deepEqual(await fault, { kind: "unhandledRejection", text: "lost" });
});

test("a second error after the first neither throws nor changes the result; the listeners stay", async () => {
  const target = new EventEmitter();
  const fault = Effect.runPromise(firstProcessFault(target));
  target.emit("uncaughtException", new Error("first"));
  assert.doesNotThrow(() => target.emit("uncaughtException", new Error("second")));
  assert.doesNotThrow(() => target.emit("unhandledRejection", new Error("third"), Promise.resolve()));
  assert.deepEqual(await fault, { kind: "uncaughtException", text: "first" });
  assert.equal(target.listenerCount("uncaughtException"), 1);
  assert.equal(target.listenerCount("unhandledRejection"), 1);
});

test("property: faultText never throws and always returns a non-empty string", () => {
  const hostile = fc.constantFrom<unknown>(
    Object.create(null),
    { get message(): string { throw new Error("getter"); } },
    { toString(): string { throw new Error("toString"); } },
    Symbol("s"),
  );
  fc.assert(
    fc.property(fc.oneof(fc.anything(), hostile, fc.string().map((m) => new Error(m))), (value) => {
      const text = faultText(value);
      assert.equal(typeof text, "string");
      assert.ok(text.length > 0);
    }),
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Result } from "effect";
import { itemUrlOf } from "../src/tracker.ts";

// Issue #125: an item's address is an absolute https address, kept as the tracker sent it; nothing else is one.
const RUNS = { numRuns: 200 };

const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/u);
const host = fc.array(label, { minLength: 1, maxLength: 3 }).map((ls) => [...ls, "com"].join("."));
const segment = fc.stringMatching(/^[A-Za-z0-9._~-]{1,12}$/u);
const httpsAddress = fc.tuple(host, fc.array(segment, { maxLength: 4 })).map(([h, ss]) => `https://${h}/${ss.join("/")}`);

test("every https address is an item's address, returned unchanged", () => {
  fc.assert(
    fc.property(httpsAddress, (text) => {
      assert.deepEqual(itemUrlOf(text), Result.succeed(text));
    }),
    RUNS,
  );
});

const notHttps = fc.oneof(
  httpsAddress.map((a) => a.replace(/^https:/u, "http:")),
  httpsAddress.map((a) => a.replace(/^https:/u, "ftp:")),
  fc.string().map((s) => `javascript:${s}`),
  fc.string().map((s) => `data:text/html,${s}`),
  fc.stringMatching(/^[a-z0-9 ./-]{0,20}$/u),
  fc.constant(""),
  fc.constant("/issues/1"),
);

test("a text that is not an absolute https address is refused with its text", () => {
  fc.assert(
    fc.property(notHttps, (text) => {
      assert.deepEqual(itemUrlOf(text), Result.fail({ _tag: "InvalidItemUrl", text }));
    }),
    RUNS,
  );
});

test("examples: a GitHub issue's page is accepted, a script is refused", () => {
  assert.deepEqual(itemUrlOf("https://github.com/mackler/interloq/issues/125"), Result.succeed("https://github.com/mackler/interloq/issues/125"));
  assert.equal(Result.isFailure(itemUrlOf("javascript:alert(1)")), true);
});

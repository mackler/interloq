// Issue #162: the settings checkCommands and suiteCommand, stored undecoded in the configuration and decoded by
// stepChecksOf only when an implementation run starts, so a malformed value never refuses a refinement run.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Result } from "effect";
import { decodeConfigText, originOf } from "../src/config.ts";
import { commandLineOf, defaultConfig, stepChecksOf } from "../src/schema.ts";

test("a config file accepts any JSON value for both keys", () => {
  for (const value of [[], null, "npm test", 3, { a: 1 }, [{ change: "", command: "" }]]) {
    const decoded = decodeConfigText("c.json", JSON.stringify({ checkCommands: value, suiteCommand: value }));
    assert.ok(Result.isSuccess(decoded), JSON.stringify(value));
  }
});

test("stepChecksOf decodes a list and a suite command", () => {
  const decoded = stepChecksOf({ checkCommands: [{ change: "the program's modules", command: "npm run test:unit" }], suiteCommand: "npm test" });
  assert.ok(Result.isSuccess(decoded));
  assert.deepEqual(decoded.success, { commands: [{ change: "the program's modules", command: "npm run test:unit" }], suite: "npm test" });
});

test("the defaults decode to no commands and no suite", () => {
  const decoded = stepChecksOf({ checkCommands: defaultConfig.checkCommands, suiteCommand: defaultConfig.suiteCommand });
  assert.ok(Result.isSuccess(decoded));
  assert.deepEqual(decoded.success, { commands: [], suite: null });
});

test("stepChecksOf refuses each malformed value, naming its key and path", () => {
  const cases: ReadonlyArray<[unknown, unknown, string, RegExp]> = [
    [[{ change: " ", command: "npm test" }], null, "checkCommands", /^\[0\]\.change$/u],
    [[{ change: "unit", command: "  " }], null, "checkCommands", /^\[0\]\.command$/u],
    [[{ change: "unit", command: "npm test\nnpm run check" }], null, "checkCommands", /^\[0\]\.command$/u],
    [[{ change: "unit", command: "npm test", extra: 1 }], null, "checkCommands", /^\[0\]/u],
    [[{ change: "x", command: "echo ok\u0000" }], null, "checkCommands", /^\[0\]\.command$/u],
    [[], "echo ok\u0000", "suiteCommand", /^$/u],
    [[], 3, "suiteCommand", /^$/u],
    [[], "", "suiteCommand", /^$/u],
    ["npm test", null, "checkCommands", /^$/u],
  ];
  for (const [checkCommands, suiteCommand, key, path] of cases) {
    const decoded = stepChecksOf({ checkCommands, suiteCommand });
    assert.ok(Result.isFailure(decoded), JSON.stringify({ checkCommands, suiteCommand }));
    assert.equal(decoded.failure.key, key);
    assert.match(decoded.failure.path, path);
    assert.notEqual(decoded.failure.message, "");
  }
});

test("originOf names the source whose value wins", () => {
  assert.equal(originOf("suiteCommand", {}, {}), "defaults");
  assert.equal(originOf("suiteCommand", { suiteCommand: "npm test" }, {}), "shared");
  assert.equal(originOf("suiteCommand", { suiteCommand: "npm test" }, { suiteCommand: null }), "own");
  assert.equal(originOf("checkCommands", {}, { suiteCommand: "x" }), "defaults");
});

test("property: commandLineOf succeeds exactly for one line with a character other than whitespace and no NUL", () => {
  const text = fc.string({ unit: fc.constantFrom("a", " ", "\t", "\n", "\r", "-", "'", " ", "\u0000") });
  fc.assert(
    fc.property(text, (t) => {
      const valid = /\S/u.test(t) && !/[\r\n\u0000]/u.test(t);
      assert.equal(Result.isSuccess(commandLineOf(t)), valid);
    }),
    { numRuns: 500 },
  );
});

// Issue #162: the settings checkCommands and suiteCommand, stored undecoded in the configuration and decoded by
// stepChecksOf only when an implementation run starts, so a malformed value never refuses a refinement run.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Result } from "effect";
import { decodeConfigText, originOf } from "../src/config.ts";
import { commandLineOf, defaultConfig, finalCommandsOf, stepChecksOf, type CommandLine } from "../src/schema.ts";

test("a config file accepts any JSON value for both keys", () => {
  for (const value of [[], null, "npm test", 3, { a: 1 }, [{ change: "", command: "" }]]) {
    const decoded = decodeConfigText("c.json", JSON.stringify({ checkCommands: value, suiteCommand: value, endToEndCommand: value }));
    assert.ok(Result.isSuccess(decoded), JSON.stringify(value));
  }
});

test("stepChecksOf decodes a list and a suite command", () => {
  const decoded = stepChecksOf({ checkCommands: [{ change: "the program's modules", command: "npm run test:unit" }], suiteCommand: "npm test", endToEndCommand: null });
  assert.ok(Result.isSuccess(decoded));
  assert.deepEqual(decoded.success, { commands: [{ change: "the program's modules", command: "npm run test:unit" }], suite: "npm test", endToEnd: null });
});

test("the defaults decode to no commands and no suite", () => {
  const decoded = stepChecksOf({ checkCommands: defaultConfig.checkCommands, suiteCommand: defaultConfig.suiteCommand, endToEndCommand: defaultConfig.endToEndCommand });
  assert.ok(Result.isSuccess(decoded));
  assert.deepEqual(decoded.success, { commands: [], suite: null, endToEnd: null });
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
    const decoded = stepChecksOf({ checkCommands, suiteCommand, endToEndCommand: null });
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

// Issue #199: the end-to-end command, decoded with the suite command's rules.
test("stepChecksOf decodes an end-to-end command alone and with a suite command", () => {
  const alone = stepChecksOf({ checkCommands: [], suiteCommand: null, endToEndCommand: "npm run test:e2e" });
  assert.ok(Result.isSuccess(alone));
  assert.deepEqual(alone.success, { commands: [], suite: null, endToEnd: "npm run test:e2e" });
  const both = stepChecksOf({ checkCommands: [], suiteCommand: "npm test", endToEndCommand: "npm run test:e2e" });
  assert.ok(Result.isSuccess(both));
  assert.deepEqual(both.success, { commands: [], suite: "npm test", endToEnd: "npm run test:e2e" });
});

test("stepChecksOf refuses each malformed end-to-end command, naming its key", () => {
  for (const endToEndCommand of ["", 3, "npm test\nnpm run check", "echo ok\u0000", "  "]) {
    const decoded = stepChecksOf({ checkCommands: [], suiteCommand: "npm test", endToEndCommand });
    assert.ok(Result.isFailure(decoded), JSON.stringify(endToEndCommand));
    assert.equal(decoded.failure.key, "endToEndCommand");
    assert.equal(decoded.failure.path, "");
    assert.notEqual(decoded.failure.message, "");
  }
});

test("originOf names the source of the end-to-end command", () => {
  assert.equal(originOf("endToEndCommand", {}, { endToEndCommand: "npm run test:e2e" }), "own");
});

test("property: finalCommandsOf returns the commands set, the suite command before the end-to-end command", () => {
  const command = fc.option(fc.constantFrom("npm test", "npm run test:e2e", "make check") as fc.Arbitrary<string>, { nil: null });
  fc.assert(
    fc.property(command, command, (suite, endToEnd) => {
      const finals = finalCommandsOf({ commands: [], suite: suite as CommandLine | null, endToEnd: endToEnd as CommandLine | null });
      const expected = [
        ...(suite === null ? [] : [{ key: "suiteCommand", command: suite }]),
        ...(endToEnd === null ? [] : [{ key: "endToEndCommand", command: endToEnd }]),
      ];
      assert.deepEqual(finals, expected);
    }),
    { numRuns: 100 },
  );
});

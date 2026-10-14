// Issue #162: the listed commands checked against package.json, and the seam with this repository's manifest and its
// own plan-review/config.json (in the shape of test/check.test.ts).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import fc from "fast-check";
import { Option, Result } from "effect";
import { decodeConfigText, mergeConfig } from "../src/config.ts";
import { listedCommands, manifestProblems, manifestScriptsOf, scriptOf } from "../src/manifestCheck.ts";
import { type CommandLine, commandLineOf, stepChecksOf } from "../src/schema.ts";

const line = (text: string): CommandLine => Result.getOrThrow(commandLineOf(text));
const root = path.resolve(import.meta.dirname, "..");

test("scriptOf recognizes npm run, run-script, test and t, with assignments and flags", () => {
  const cases: ReadonlyArray<[string, string | null]> = [
    ["npm run check", "check"],
    ["npm run-script test:unit", "test:unit"],
    ["npm run --silent check", "check"],
    ["npm run check -- --watch", "check"],
    ["npm test", "test"],
    ["npm t", "test"],
    ["CI=1 npm test", "test"],
    ["E2E_SCENARIOS='tabs two' A=\"x y\" npm run test:e2e", "test:e2e"],
    ["npx playwright test e2e/run.spec.ts", null],
    ["script/test", null],
    ["node --test test/a.test.ts", null],
    ["npm run", null],
    ["npm ci", null],
  ];
  for (const [command, script] of cases) assert.deepEqual(scriptOf(line(command)), script === null ? Option.none() : Option.some(script), command);
});

test("manifestProblems: a missing script, no manifest, and commands that are not checked", () => {
  const scripts = Option.some({ test: "x", check: "y" });
  assert.deepEqual(manifestProblems([line("npm test"), line("npm run check"), line("npx vitest")], scripts), []);
  assert.deepEqual(manifestProblems([line("npm run test:missing")], scripts), [{ _tag: "MissingScript", command: "npm run test:missing", script: "test:missing" }]);
  assert.deepEqual(manifestProblems([line("npm test"), line("script/test")], Option.none()), [{ _tag: "NoManifest", command: "npm test" }]);
});

test("listedCommands: the check commands, then the suite", () => {
  const checks = Result.getOrThrow(stepChecksOf({ checkCommands: [{ change: "a", command: "npm run a" }, { change: "b", command: "npm run b" }], suiteCommand: "npm test" }));
  assert.deepEqual(listedCommands(checks), ["npm run a", "npm run b", "npm test"]);
});

test("manifestScriptsOf: a package.json's scripts, none for anything else", () => {
  assert.deepEqual(manifestScriptsOf(JSON.stringify({ scripts: { a: "b" } })), { a: "b" });
  for (const text of ["not json", "null", "[]", JSON.stringify({}), JSON.stringify({ scripts: [] }), JSON.stringify({ scripts: { a: 1 } })]) assert.deepEqual(manifestScriptsOf(text), {}, text);
});

test("property: npm run <name> is a problem exactly when the name is not a script", () => {
  const name = fc.stringMatching(/^[a-z][a-z:._-]{0,10}$/u);
  fc.assert(
    fc.property(fc.uniqueArray(name, { maxLength: 6 }), name, (names, candidate) => {
      const scripts = Option.some(Object.fromEntries(names.map((n) => [n, "x"])));
      assert.equal(manifestProblems([line(`npm run ${candidate}`)], scripts).length === 0, names.includes(candidate));
    }),
    { numRuns: 300 },
  );
});

test("the seam: every script of this repository's package.json is found, and a renamed one is not", () => {
  const scripts = manifestScriptsOf(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.ok(Object.keys(scripts).length > 0);
  for (const name of Object.keys(scripts)) {
    assert.deepEqual(manifestProblems([line(`npm run ${name}`)], Option.some(scripts)), [], name);
    assert.equal(manifestProblems([line(`npm run ${name}-renamed`)], Option.some(scripts))[0]?._tag, "MissingScript", name);
  }
  assert.deepEqual(manifestProblems([line("npm test")], Option.some(scripts)), []);
});

const ownConfig = path.join(root, "plan-review", "config.json");
test("the seam: this repository's own listed commands name scripts its package.json has", { skip: !existsSync(ownConfig) && "no plan-review/config.json (as in CI)" }, () => {
  const own = decodeConfigText(ownConfig, readFileSync(ownConfig, "utf8"));
  assert.ok(Result.isSuccess(own));
  const config = mergeConfig({}, own.success);
  const checks = stepChecksOf(config);
  assert.ok(Result.isSuccess(checks), JSON.stringify(Result.isFailure(checks) ? checks.failure : null));
  const scripts = manifestScriptsOf(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(manifestProblems(listedCommands(checks.success), Option.some(scripts)), []);
});

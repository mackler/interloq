// Issue #162: the listed commands checked against package.json, and the seam with this repository's manifest and its
// own plan-review/config.json (in the shape of test/check.test.ts).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import fc from "fast-check";
import { Option, Result } from "effect";
import { decodeConfigText, mergeConfig } from "../src/config.ts";
import { listedCommands, manifestProblems, manifestScriptsOf, NPM_FLAG_OPTIONS, NPM_VALUE_OPTIONS, scriptOf } from "../src/manifestCheck.ts";
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

// Issue #162 (W1-R1-2, P2-R1-1): an option's value is not the script, and a quoted word before the script is not checked.
test("scriptOf skips npm options' values, and leaves an unknown option or a quoted word unchecked", () => {
  const cases: ReadonlyArray<[string, string | null]> = [
    ["npm run --loglevel error check", "check"],
    ["npm run --loglevel=error check", "check"],
    ["npm run -w pkg check", "check"],
    ["npm run --silent check", "check"],
    ["npm run --unknown-option x check", null],
    ["npm run --cache \"/tmp/npm cache\" check", null],
    ["FOO='a b' npm run check", "check"],
  ];
  for (const [command, script] of cases) assert.deepEqual(scriptOf(line(command)), script === null ? Option.none() : Option.some(script), command);
  const scripts = Option.some({ check: "x" });
  for (const command of ["npm run --loglevel error check", "npm run --loglevel=error check", "npm run -w pkg check", "npm run --cache \"/tmp/npm cache\" check"]) {
    assert.deepEqual(manifestProblems([line(command)], scripts), [], command);
  }
});

const scriptName = fc.stringMatching(/^[a-z][a-z:._-]{0,10}$/u);
const valueWord = fc.stringMatching(/^[A-Za-z0-9/._:-]{1,12}$/u);

test("property: a value-taking option and its value before the script never change the script found", () => {
  fc.assert(
    fc.property(scriptName, fc.constantFrom(...NPM_VALUE_OPTIONS), valueWord, fc.boolean(), (script, option, value, joined) => {
      const options = joined && option.startsWith("--") ? `${option}=${value}` : `${option} ${value}`;
      assert.deepEqual(scriptOf(line(`npm run ${options} ${script}`)), Option.some(script));
    }),
    { numRuns: 300 },
  );
});

// Issue #162 (W3-R1-1): a shell metacharacter in a word up to the script makes the command unchecked, since the shell may
// cut, join, redirect or expand that word; an operator standing alone after the script does not affect it.
test("scriptOf leaves a command with shell syntax up to its script unchecked", () => {
  const cases: ReadonlyArray<[string, string | null]> = [
    ["npm run check>/dev/null", null],
    ["npm run check; echo done", null],
    ["npm run --loglevel err|x check", null],
    ["npm test>out", null],
    ["npm test;", null],
    ["npm run check > /dev/null", "check"],
    ["npm run check && echo done", "check"],
    ["npm run 'check'", null],
    ["npm run che\\ck", null],
  ];
  for (const [command, script] of cases) assert.deepEqual(scriptOf(line(command)), script === null ? Option.none() : Option.some(script), command);
  const scripts = Option.some({ check: "x" });
  for (const command of ["npm run check>/dev/null", "npm run check; echo done"]) assert.deepEqual(manifestProblems([line(command)], scripts), [], command);
});

const metacharacters = ["'", '"', "\\", ";", "&", "|", "<", ">", "(", ")", "$", "`", "*", "?", "[", "]", "{", "}", "~", "#", "!"];
const plainScript = fc.stringMatching(/^[A-Za-z0-9:_][A-Za-z0-9:_-]{0,10}$/u);
const optionWords = fc.array(
  fc.oneof(fc.constantFrom(...NPM_FLAG_OPTIONS).map((flag) => [flag]), fc.tuple(fc.constantFrom(...NPM_VALUE_OPTIONS), valueWord).map(([option, value]) => [option, value])),
  { maxLength: 3 },
);

test("property: a shell metacharacter in any word between run and the script makes the command unchecked", () => {
  fc.assert(
    fc.property(plainScript, optionWords, fc.constantFrom(...metacharacters), fc.nat(), fc.nat(12), (script, options, meta, which, at) => {
      const words = [...options.flat(), script];
      assert.deepEqual(scriptOf(line(`npm run ${words.join(" ")}`)), Option.some(script));
      const index = which % words.length;
      const word = words[index];
      const i = Math.min(at, word.length);
      words[index] = word.slice(0, i) + meta + word.slice(i);
      assert.deepEqual(scriptOf(line(`npm run ${words.join(" ")}`)), Option.none(), words.join(" "));
    }),
    { numRuns: 500 },
  );
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

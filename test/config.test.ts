import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Cause, Effect, Exit, Option, Result } from "effect";
import type { RunError } from "../src/errors.ts";
import { describe } from "../src/errors.ts";
import { defaultConfig } from "../src/schema.ts";
import { decodeConfigText, loadConfig } from "../src/config.ts";
import { platformLayer } from "../src/platform.ts";
import { tempRepo } from "./helpers.ts";

/** A project with a plan-review/ directory and a shared config file outside it. Neither file exists yet. */
const setup = (): { project: string; shared: string; projectFile: string } => {
  const project = tempRepo();
  fs.mkdirSync(path.join(project, "plan-review"), { recursive: true });
  const shared = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pr-shared-")), "config.json");
  return { project, shared, projectFile: path.join(project, "plan-review", "config.json") };
};

const load = (project: string, shared: string) => Effect.runPromise(loadConfig(project, shared).pipe(Effect.provide(platformLayer)));

const failsWith = async (project: string, shared: string, tag: RunError["_tag"], ...texts: RegExp[]): Promise<void> => {
  const exit = await Effect.runPromiseExit(loadConfig(project, shared).pipe(Effect.provide(platformLayer)));
  assert.ok(Exit.isFailure(exit), "the configuration was accepted");
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(error), `a defect, not a typed error: ${Cause.pretty(exit.cause)}`);
  assert.equal(error.value._tag, tag);
  for (const text of texts) assert.match(describe(error.value), text);
};

test("precedence: defaults, then shared, then project", async () => {
  const { project, shared, projectFile } = setup();
  fs.writeFileSync(shared, JSON.stringify({ maxRounds: 7, countMinor: false, ignorePaths: ["shared.txt"] }));
  fs.writeFileSync(projectFile, JSON.stringify({ maxRounds: 9, ignorePaths: ["project.txt"] }));
  const config = await load(project, shared);
  assert.equal(config.maxRounds, 9);
  assert.equal(config.countMinor, false);
  assert.equal(config.maxIdleRounds, defaultConfig.maxIdleRounds);
  assert.deepEqual(config.ignorePaths, ["project.txt"]);
});

test("missing config files give the defaults", async () => {
  const { project, shared } = setup();
  assert.deepEqual(await load(project, shared), defaultConfig);
});

for (const which of ["shared", "project"] as const) {
  const target = (files: ReturnType<typeof setup>): string => (which === "shared" ? files.shared : files.projectFile);

  test(`invalid JSON in the ${which} config fails with ConfigInvalid naming the file`, async () => {
    const files = setup();
    fs.writeFileSync(target(files), "{");
    await failsWith(files.project, files.shared, "ConfigInvalid", new RegExp(target(files).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  test(`a wrong type in the ${which} config fails with ConfigInvalid naming the field path`, async () => {
    const files = setup();
    fs.writeFileSync(target(files), JSON.stringify({ maxRounds: "5" }));
    await failsWith(files.project, files.shared, "ConfigInvalid", /maxRounds/, new RegExp(path.basename(target(files))));
  });

  test(`an unknown key in the ${which} config fails with ConfigInvalid naming the key`, async () => {
    const files = setup();
    fs.writeFileSync(target(files), JSON.stringify({ maxRound: 3 }));
    await failsWith(files.project, files.shared, "ConfigInvalid", /maxRound/);
  });
}

test("a wrong element type in a list names the element's path", async () => {
  const { project, shared, projectFile } = setup();
  fs.writeFileSync(projectFile, JSON.stringify({ ignorePaths: ["a.txt", 2] }));
  await failsWith(project, shared, "ConfigInvalid", /ignorePaths\[1\]/);
});

test("a round limit of 0 is reported with its field path", async () => {
  const { project, shared, projectFile } = setup();
  fs.writeFileSync(projectFile, JSON.stringify({ maxRounds: 0 }));
  await failsWith(project, shared, "ConfigInvalid", /maxRounds/);
});

// Finding 10: the config decoder returns a Result instead of throwing ConfigInvalid.
test("decodeConfigText returns a Result: ConfigInvalid for bad JSON or a wrong type, the partial config otherwise", () => {
  const badJson = decodeConfigText("/p/config.json", "{nope");
  assert.ok(Result.isFailure(badJson));
  assert.equal(badJson.failure._tag, "ConfigInvalid");
  assert.equal(badJson.failure.file, "/p/config.json");
  const wrongType = decodeConfigText("/p/config.json", '{"maxRounds": "5"}');
  assert.ok(Result.isFailure(wrongType));
  assert.equal(wrongType.failure.path, "maxRounds");
  const good = decodeConfigText("/p/config.json", '{"maxRounds": 3}');
  assert.ok(Result.isSuccess(good));
  assert.deepEqual(good.success, { maxRounds: 3 });
});

// Issue #26, Q1: the transport retry budget, validated under behavior 9.
import { retryDelays } from "../src/retry.ts";

test("the transport retry keys default to 3 retries and 5 s, and the project's file overrides the shared one", async () => {
  const { project, shared, projectFile } = setup();
  const defaults = await load(project, shared);
  assert.equal(defaults.maxTransportRetries, 3);
  assert.equal(defaults.transportRetryDelaySeconds, 5);
  fs.writeFileSync(shared, JSON.stringify({ maxTransportRetries: 4, transportRetryDelaySeconds: 2 }));
  fs.writeFileSync(projectFile, JSON.stringify({ maxTransportRetries: 6 }));
  const config = await load(project, shared);
  assert.equal(config.maxTransportRetries, 6);
  assert.equal(config.transportRetryDelaySeconds, 2);
});

test("maxTransportRetries of 0, \"3\" or -1, and a delay of 0, stop the program with ConfigInvalid", async () => {
  for (const value of [{ maxTransportRetries: 0 }, { maxTransportRetries: "3" }, { maxTransportRetries: -1 }, { maxTransportRetries: 1.5 }, { transportRetryDelaySeconds: 0 }, { transportRetryDelaySeconds: -2 }]) {
    const { project, shared, projectFile } = setup();
    fs.writeFileSync(projectFile, JSON.stringify(value));
    await failsWith(project, shared, "ConfigInvalid", new RegExp(Object.keys(value)[0]));
  }
});

test("retryDelays doubles the configured delay on each retry", () => {
  assert.deepEqual(retryDelays({ maxTransportRetries: 3, transportRetryDelaySeconds: 5 }), [5, 10, 20]);
  assert.deepEqual(retryDelays({ maxTransportRetries: 2, transportRetryDelaySeconds: 0.01 }), [0.01, 0.02]);
});

// Issue #120, part 1: the tracker key. GitHub's owner, repo and six stage labels; refused before any call when a
// coordinate is missing, a state is unknown or missing, or two states share a label. No credential is a config key.
const LABELS = { unrefined: "stage: unrefined", refining: "stage: refining", refined: "stage: refined", implementing: "stage: implementing", implemented: "stage: implemented", deployed: "stage: deployed" };
const GITHUB = { kind: "github", owner: "mackler", repo: "interloq", labels: LABELS };
const trackerText = (tracker: unknown): string => JSON.stringify({ tracker });

test("the tracker key defaults to null and accepts a GitHub tracker with its six labels", () => {
  assert.equal(defaultConfig.tracker, null);
  const decoded = decodeConfigText("/p/config.json", trackerText(GITHUB));
  assert.ok(Result.isSuccess(decoded));
  assert.deepEqual(decoded.success.tracker, GITHUB);
});

test("a tracker with a missing or blank coordinate, an unknown state, a missing state or a shared label is ConfigInvalid", () => {
  const { repo: _repo, ...noRepo } = GITHUB;
  const { deployed: _deployed, ...fiveLabels } = LABELS;
  const cases: ReadonlyArray<[string, unknown]> = [
    ["repo missing", noRepo],
    ["owner blank", { ...GITHUB, owner: " " }],
    ["an unknown state", { ...GITHUB, labels: { ...LABELS, reviewing: "stage: reviewing" } }],
    ["a missing state", { ...GITHUB, labels: fiveLabels }],
    ["a blank label", { ...GITHUB, labels: { ...LABELS, refined: "" } }],
    ["two states with one label", { ...GITHUB, labels: { ...LABELS, refined: LABELS.refining } }],
    ["an unknown kind", { ...GITHUB, kind: "jira" }],
    ["a token in the config", { ...GITHUB, token: "ghp_secret" }],
  ];
  for (const [what, tracker] of cases) {
    const decoded = decodeConfigText("/p/config.json", trackerText(tracker));
    assert.ok(Result.isFailure(decoded), `${what} was accepted`);
    assert.equal(decoded.failure._tag, "ConfigInvalid", what);
    assert.match(decoded.failure.path, /^tracker/u, what);
  }
});

test("the project's tracker replaces the shared one whole", async () => {
  const { project, shared, projectFile } = setup();
  fs.writeFileSync(shared, trackerText(GITHUB));
  fs.writeFileSync(projectFile, trackerText({ ...GITHUB, owner: "someone", repo: "else" }));
  assert.deepEqual((await load(project, shared)).tracker, { ...GITHUB, owner: "someone", repo: "else" });
});

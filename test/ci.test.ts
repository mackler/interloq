import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { test } from "node:test";

// A drift check between .github/workflows/ci.yml and the tools of this machine (the container image in development,
// the runner in CI), like test/deps.test.ts for the npm packages. It does not prove that the workflow runs on GitHub:
// that is the developer's check.
const root = new URL("../", import.meta.url);
const readText = (relative: string): string | undefined => {
  const file = new URL(relative, root);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
};
const workflow = (): string => readText(".github/workflows/ci.yml") ?? "(absent)";
const versionOf = (command: string, args: readonly string[]): string => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const match = /\d+\.\d+\.\d+/.exec(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  assert.ok(
    match !== null,
    `${command} ${args.join(" ")} printed no version: this container is older than container/Dockerfile, ` +
      `or was changed by hand. Rebuild it: bin/ilcli build, then down, then shell.`,
  );
  return match[0];
};
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const dockerfile = (): string => readText("container/Dockerfile") ?? "(absent)";
/** The value of an `ARG NAME=value` of the image, which is where its tools are pinned. */
const argOf = (name: string): string => {
  const match = new RegExp(`^ARG ${escape(name)}=(\\S+)$`, "m").exec(dockerfile());
  assert.ok(match !== null, `container/Dockerfile declares no ARG ${name}`);
  return match[1];
};

test("the workflow sets up Node from .node-version", () => {
  assert.match(workflow(), /node-version-file: \.node-version/, "the workflow does not read .node-version");
});

test("the workflow installs bats at the version this machine runs, from the bats-core tag", () => {
  const bats = versionOf("bats", ["--version"]);
  assert.match(workflow(), /bats-core\/bats-core/, "the workflow does not install bats from bats-core");
  assert.match(workflow(), new RegExp(`--branch v${escape(bats)}\\b`), `the workflow does not install bats ${bats}`);
});

test("the workflow sets up this machine's Ruby and installs this machine's bashly with it, not with sudo", () => {
  const ruby = versionOf("ruby", ["-e", "print RUBY_VERSION"]);
  const bashly = versionOf("bashly", ["--version"]);
  assert.match(workflow(), /uses: ruby\/setup-ruby@/, "the workflow does not set up Ruby");
  assert.match(workflow(), new RegExp(`ruby-version: ["']?${escape(ruby)}["']?\\s`), `the workflow does not set up Ruby ${ruby}`);
  assert.match(workflow(), new RegExp(`gem install bashly -v ${escape(bashly)}\\b`), `the workflow does not install bashly ${bashly}`);
  assert.doesNotMatch(workflow(), /sudo gem install/, "bashly is installed with sudo, so with the runner's system Ruby");
});

test("the release job pushes to release with the deploy key, and the test job has a time limit", () => {
  assert.match(workflow(), /refs\/heads\/release/, "the workflow does not push to refs/heads/release");
  assert.match(workflow(), /secrets\.RELEASE_DEPLOY_KEY/, "the workflow does not use the secret RELEASE_DEPLOY_KEY");
  assert.match(workflow(), /timeout-minutes: \d+/, "the test job has no timeout-minutes");
});

// The image is now part of the repository (container/Dockerfile), so the same drift check covers it: its pins are
// what this machine runs, and its Node is the one .node-version gives CI. A rebuild cannot move them apart silently.
test("the image builds on the Node of .node-version", () => {
  const node = (readText(".node-version") ?? "(absent)").trim();
  assert.match(
    dockerfile(),
    new RegExp(`^FROM node:${escape(node)}-`, "m"),
    `container/Dockerfile does not build on node:${node}, so a rebuild could drift from .node-version`,
  );
});

test("the image pins the bats and bashly this machine runs, and the Playwright the package pins", () => {
  assert.equal(argOf("BATS_VERSION"), versionOf("bats", ["--version"]), "the image's bats is not the one running here");
  assert.equal(argOf("BASHLY_VERSION"), versionOf("bashly", ["--version"]), "the image's bashly is not the one running here");
  const pinned = (JSON.parse(readText("package.json") ?? "{}") as { devDependencies?: Record<string, string> }).devDependencies?.["@playwright/test"];
  assert.equal(argOf("PLAYWRIGHT_VERSION"), pinned, "the image's Playwright is not the pin in package.json");
});

// Issue #75 (requirements Q3): the end-to-end tests run on half of each machine's cores. The one source of the worker
// count is playwright.config.ts, which this machine and the CI runner both read; nothing else may set it.
test("the end-to-end worker count is 50% of the cores, set in playwright.config.ts alone", async () => {
  const config = (await import("../playwright.config.ts")).default;
  assert.equal(config.workers, "50%", "playwright.config.ts does not set workers to 50%");
  assert.equal(config.fullyParallel, true, "playwright.config.ts does not run the tests in parallel");
  const scripts = (JSON.parse(readText("package.json") ?? "{}") as { scripts?: Record<string, string> }).scripts ?? {};
  for (const [where, text] of [[".github/workflows/ci.yml", workflow()], ["container/Dockerfile", dockerfile()], ["package.json's test:e2e", scripts["test:e2e"] ?? ""]] as const) {
    assert.doesNotMatch(text, /--workers|(^|\s)-j\s*\d|PLAYWRIGHT_WORKERS/m, `${where} overrides the worker count`);
  }
});

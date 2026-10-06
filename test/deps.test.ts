import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

// No static import of effect or @effect/platform-node, so that the type check does not need them.
const root = new URL("../", import.meta.url);
const readJson = (relative: string): Record<string, any> | undefined => {
  const file = new URL(relative, root);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
};
const dependencies = (): Record<string, string> => readJson("package.json")?.dependencies ?? {};

test("effect and @effect/platform-node are pinned to exact versions", () => {
  const deps = dependencies();
  for (const name of ["effect", "@effect/platform-node"]) {
    assert.match(deps[name] ?? "(absent)", /^\d+\.\d+\.\d+$/, `${name} is not pinned to an exact version`);
  }
  for (const [name, version] of Object.entries(deps)) {
    assert.doesNotMatch(version, /[\^~<>*x|]|latest/, `${name} has a version range: ${version}`);
  }
});

// The version of effect and @effect/platform-node, which move together (the platform's peerDependencies require it).
const EFFECT_VERSION = "4.0.1";

test(`effect and @effect/platform-node are pinned to ${EFFECT_VERSION} and installed at it`, () => {
  for (const name of ["effect", "@effect/platform-node"]) {
    assert.equal(dependencies()[name], EFFECT_VERSION, `${name} is not pinned to ${EFFECT_VERSION}`);
    assert.equal(readJson(`node_modules/${name}/package.json`)?.version, EFFECT_VERSION, `installed ${name} is not ${EFFECT_VERSION}`);
  }
});

test("the installed effect version is the pinned one", () => {
  for (const name of ["effect", "@effect/platform-node"]) {
    const pinned = dependencies()[name];
    assert.ok(pinned !== undefined, `${name} is not a dependency`);
    assert.equal(readJson(`node_modules/${name}/package.json`)?.version, pinned, `installed ${name} differs from the pinned version`);
  }
});

// The devDependencies, each pinned exactly: fast-check (property tests) and those the developer instructed for the web GUI.
const PINNED_DEV = ["fast-check", "svelte", "vite", "@sveltejs/vite-plugin-svelte", "vitest", "@playwright/test", "marked", "dompurify", "m3-svelte", "vite-plugin-functions-mixins", "jsdom", "svelte-check"] as const;

for (const name of PINNED_DEV) {
  test(`${name} is a devDependency pinned to an exact version and the installed version matches`, () => {
    const pinned: string | undefined = readJson("package.json")?.devDependencies?.[name];
    assert.match(pinned ?? "(absent)", /^\d+\.\d+\.\d+$/, `${name} is not a devDependency pinned to an exact version`);
    assert.equal(readJson(`node_modules/${name}/package.json`)?.version, pinned, `installed ${name} differs from the pinned version`);
  });
}

// Q1 and Q2 of the release pipeline: CI reads the container's exact Node from .node-version, and npm refuses an older Node.
const readText = (relative: string): string | undefined => {
  const file = new URL(relative, root);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
};

test(".node-version holds the exact Node version this machine runs", () => {
  const text = readText(".node-version") ?? "(absent)";
  assert.match(text, /^\d+\.\d+\.\d+\n?$/, ".node-version does not hold one exact version");
  assert.equal(text.trim(), process.versions.node, ".node-version differs from the running Node; update it when the image's Node changes");
});

test("package.json requires Node >=22.18 through engines", () => {
  assert.equal(readJson("package.json")?.engines?.node, ">=22.18", "package.json has no engines.node of >=22.18");
});

test(".npmrc makes npm refuse a Node outside engines", () => {
  assert.match(readText(".npmrc") ?? "(absent)", /^engine-strict=true$/m, ".npmrc does not set engine-strict=true");
});

// Issue #6 (Q2): the Agent SDK's tool() takes its input only as a zod shape, so zod is a dependency, permitted on the
// developer's instruction of 28 Sep 2026, pinned exactly, and imported by src/sdkLive.ts alone.
test("zod is a dependency pinned at 4.6.5 and the installed version matches", () => {
  assert.equal(dependencies().zod, "4.6.5", "zod is not pinned at 4.6.5 in dependencies");
  assert.equal(readJson("node_modules/zod/package.json")?.version, "4.6.5", "installed zod differs from the pinned version");
});

test("no module but src/sdkLive.ts imports zod", () => {
  const files = (dir: string): string[] =>
    fs.readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(`${dir}${e.name}/`) : /\.(ts|svelte)$/.test(e.name) ? [`${dir}${e.name}`] : []));
  const importing = ["src/", "web/src/", "test/", "e2e/"].flatMap(files).filter((file) => /from\s+["']zod(\/[^"']*)?["']|import\(\s*["']zod/.test(fs.readFileSync(new URL(file, root), "utf8")));
  assert.deepEqual(importing.filter((file) => file !== "src/sdkLive.ts"), []);
});

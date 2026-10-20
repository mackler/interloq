// Issue #147 (S9): plan-review/chain.json, the chain's state kept across a restart.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, type FileSystem, type Path } from "effect";
import { platformLayer } from "../src/platform.ts";
import { loadChain, removeChain, saveChain } from "../src/chainFile.ts";
import { begun, DEFAULT_SETTINGS, initialState, OFF_SETTINGS } from "../src/chain.ts";
import type { ItemId } from "../src/tracker.ts";

const go = <A, E>(e: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) => Effect.runPromise(e.pipe(Effect.provide(platformLayer)));
const temp = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pr-chain-"));
const file = (cwd: string) => path.join(cwd, "plan-review", "chain.json");

test("a saved state loads back unchanged, and the write leaves no temporary file", async () => {
  const cwd = temp();
  const state = begun(initialState(DEFAULT_SETTINGS), 3, "12" as ItemId, "twelve");
  await go(saveChain(cwd, state));
  assert.deepEqual(await go(loadChain(cwd, OFF_SETTINGS)), state);
  assert.deepEqual(fs.readdirSync(path.join(cwd, "plan-review")), ["chain.json"]);
  assert.equal(JSON.parse(fs.readFileSync(file(cwd), "utf8")).version, 2);
});

test("a missing file loads as an idle chain with the given defaults", async () => {
  assert.deepEqual(await go(loadChain(temp(), OFF_SETTINGS)), initialState(OFF_SETTINGS));
  assert.deepEqual(await go(loadChain(temp(), DEFAULT_SETTINGS)), initialState(DEFAULT_SETTINGS));
});

test("a malformed file loads as an idle chain saying it could not be read", async () => {
  for (const text of ["not json", JSON.stringify({ version: 1, state: {} })]) {
    const cwd = temp();
    fs.mkdirSync(path.join(cwd, "plan-review"));
    fs.writeFileSync(file(cwd), text);
    const state = await go(loadChain(cwd, DEFAULT_SETTINGS));
    assert.equal(state.chain._tag === "Idle" && state.chain.ended?._tag, "Unreadable");
    assert.deepEqual(state.settings, DEFAULT_SETTINGS);
  }
});

test("a removed file loads as initial, and removing a missing one is no failure", async () => {
  const cwd = temp();
  await go(saveChain(cwd, begun(initialState(DEFAULT_SETTINGS), 1, "1" as ItemId, "one")));
  await go(removeChain(cwd));
  await go(removeChain(cwd));
  assert.deepEqual(await go(loadChain(cwd, DEFAULT_SETTINGS)), initialState(DEFAULT_SETTINGS));
});

// Issue #210: the two values of bin/ilcli codex that must agree with the program, each tested against the program
// itself. The constants are read from the generated script, since that is what runs.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Effect, Result } from "effect";
import { HttpServer } from "effect/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { findCodexExecutable } from "../src/codexExec.ts";
import type { CurrentRuns } from "../src/protocol.ts";
import type { RunManager } from "../src/runManager.ts";
import { makeWebServer } from "../src/webServer.ts";
import { initialState as initialChain, OFF_SETTINGS } from "../src/chain.ts";
import { PREPARATION_OFF } from "../src/preparationSwitch.ts";
import { tempDir } from "./helpers.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A single-quoted assignment `NAME='…'` of the generated bin/ilcli, or null where it holds none. */
const constantOf = (name: string): string | null => {
  const text = fs.readFileSync(path.join(root, "bin", "ilcli"), "utf8");
  const found = new RegExp(`^${name}='(.*)'$`, "m").exec(text);
  return found === null ? null : found[1];
};

test("bin/ilcli's CODEX_RELATIVE_PATH is the binary the program starts for its reviews", () => {
  const executable = findCodexExecutable();
  assert.ok(Result.isSuccess(executable), "the Codex binary is installed");
  assert.equal(constantOf("CODEX_RELATIVE_PATH"), path.relative(root, executable.success.path));
});

const dist = (): string => {
  const d = tempDir("ilcli-codex-dist-");
  fs.writeFileSync(path.join(d, "index.html"), "<!doctype html><title>Interloq</title>");
  return d;
};

const managerOf = (current: CurrentRuns): RunManager => ({
  location: "/p",
  incarnation: "test",
  subscribe: () => Effect.void,
  replay: Effect.succeed({ runs: [], ui: [] }),
  current: Effect.succeed(current),
  start: () => Effect.succeed({ refused: "not in this test", mode: null }),
  listItems: () => Effect.succeed({ mode: "implementation", result: { _tag: "Unavailable", notice: "not in this test" } }),
  stop: () => Effect.succeed(null),
  answer: () => Effect.succeed(null),
  hold: () => Effect.succeed(null),
  endWait: () => Effect.succeed(null),
  setUi: () => Effect.succeed(null),
  haltAll: () => Effect.succeed({ halted: [], unconfirmed: [] }),
  chain: Effect.succeed(initialChain(OFF_SETTINGS)),
  setChain: () => Effect.succeed(initialChain(OFF_SETTINGS)),
  preparation: Effect.succeed({ settings: PREPARATION_OFF, status: { _tag: "Off" } }),
  setPreparation: () => Effect.succeed({ settings: PREPARATION_OFF, status: { _tag: "Off" } }),
});

type Checked = Readonly<{ stdout: string; code: number }>;
const check = (script: string, port: number): Promise<Checked> =>
  new Promise((resolve) => {
    execFile(process.execPath, ["-e", script, String(port)], { timeout: 5000 }, (error, stdout) => {
      resolve({ stdout, code: error === null ? 0 : typeof error.code === "number" ? error.code : -1 });
    });
  });

const checkAgainst = (current: CurrentRuns, script: string): Promise<Checked> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const web = yield* makeWebServer(managerOf(current), dist());
        yield* HttpServer.serveEffect(web.handler);
        yield* Effect.addFinalizer(() => web.closeAll);
        const address = (yield* HttpServer.HttpServer).address;
        const port = address._tag === "UnixPathAddress" ? 0 : address.port;
        return yield* Effect.promise(() => check(script, port));
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

test("bin/ilcli's RUN_CHECK_SCRIPT reads the real server's hello: an implementation run in progress, or none", async () => {
  const script = constantOf("RUN_CHECK_SCRIPT");
  assert.ok(script !== null, "bin/ilcli holds RUN_CHECK_SCRIPT");
  assert.deepEqual(await checkAgainst({ refinement: [], implementation: 7 }, script), { stdout: "implementation\n", code: 0 });
  assert.deepEqual(await checkAgainst({ refinement: [3], implementation: null }, script), { stdout: "", code: 0 });
  // A port nothing listens on: a server's own port, freed.
  const free = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const address = (yield* HttpServer.HttpServer).address;
        return address._tag === "UnixPathAddress" ? 1 : address.port;
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
  const started = Date.now();
  assert.deepEqual(await check(script, free), { stdout: "", code: 0 });
  assert.ok(Date.now() - started < 5000);
});

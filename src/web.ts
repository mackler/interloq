// Usage: node /opt/interloq/src/web.ts [port]   (default 8090)
// Untested wiring (plan step 3.5): the web server with the live wiring per run,
// under the platform runner. The page is served from web/dist (npm run build).

import { Effect, FileSystem, Layer } from "effect";
import { HttpServer } from "effect/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as fs from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { claudePlannerLayer } from "./claude.ts";
import { identify, parseMountinfo } from "./hostDir.ts";
import { codexReviewerLayer } from "./codex.ts";
import { platformLayer } from "./platform.ts";
import type { Wiring } from "./program.ts";
import { liveTracker } from "./trackerLive.ts";
import { makeRunManager } from "./runManager.ts";
import { liveSdk } from "./sdkLive.ts";
import { distMissingMessage, parsePort, WEB_USAGE } from "./webArgs.ts";
import { makeWebServer } from "./webServer.ts";
import type { WebUi } from "./webUi.ts";

const port = parsePort(process.argv.slice(2));
const distDir = fileURLToPath(new URL("../web/dist", import.meta.url));
const indexFile = `${distDir}/index.html`;
if (port === null) {
  process.stderr.write(WEB_USAGE + "\n");
  process.exit(2);
}
if (!fs.existsSync(indexFile)) {
  process.stderr.write(distMissingMessage(indexFile) + "\n");
  process.exit(1);
}

const sdk = liveSdk();
/** The live wiring of a run, with the run's web Ui. */
const wiringOf = (ui: WebUi): Wiring => ({
  ui: Effect.succeed(ui),
  platform: platformLayer,
  sdk,
  agents: Layer.mergeAll(claudePlannerLayer, codexReviewerLayer),
  sharedConfig: fileURLToPath(new URL("../config.json", import.meta.url)),
  tracker: liveTracker,
});

/** This start of the server (finding 12 of docs/gui-review.md): run and prompt numbers restart, the incarnation does not. */
const incarnation = `${Date.now().toString(36)}-${randomUUID()}`;

const main = Effect.gen(function* () {
  // Issue #29: the mount table, read once at the server's start; a failed read (no such file, no permission, another
  // platform) is the empty table, so every path identifies as itself.
  const files = yield* FileSystem.FileSystem;
  const mounts = parseMountinfo(yield* files.readFileString("/proc/self/mountinfo").pipe(Effect.orElseSucceed(() => "")));
  const manager = yield* makeRunManager(wiringOf, process.cwd(), mounts, incarnation);
  const web = yield* makeWebServer(manager, distDir);
  yield* HttpServer.serveEffect(web.handler);
  // Registered after serveEffect, so that it runs before the HTTP shutdown, which would wait for the open tabs (finding 15).
  yield* Effect.addFinalizer(() => web.closeAll);
  yield* Effect.sync(() => void process.stdout.write(
    `Interloq web GUI on http://localhost:${port}/ (working directory ${process.cwd()}, project ${identify(mounts, process.cwd())}); Ctrl+C ends the server.\n`));
  return yield* Effect.never;
}).pipe(
  Effect.scoped,
  Effect.provide(NodeHttpServer.layer(() => createServer(), { port })),
  Effect.provide(platformLayer),
);

// On SIGINT or SIGTERM the runner interrupts the server; its finalizer tells each tab and closes its socket, then a
// run in progress ends with the process.
NodeRuntime.runMain(main);

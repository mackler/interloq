// Usage: node /opt/interloq/src/web.ts [port]   (default 8090)
// Untested wiring (plan step 3.5): the web server with the live wiring per run,
// under the platform runner. The page is served from web/dist (npm run build).
// Issue #158 (the user's decision Q1): an uncaught exception or unhandled rejection cannot be traced to one run, so
// the server halts every run in progress with its record, tells every tab it is ending, and ends with exit code 1,
// by itself or at a hard deadline; the user starts it again with bin/ilcli web.

import { Effect, Fiber, FileSystem, Layer } from "effect";
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
import { makeRunManager, SERVER_FAULT_GRACE_MS, SERVER_FAULT_INTERRUPT_MS } from "./runManager.ts";
import { ServerFault } from "./errors.ts";
import { firstProcessFault } from "./processFault.ts";
import { unrecordedHaltLine } from "./prompts.ts";
import { suiteRunner } from "./suiteExec.ts";
import { liveSdk } from "./sdkLive.ts";
import { distMissingMessage, parsePort, WEB_USAGE } from "./webArgs.ts";
import { makeWebServer } from "./webServer.ts";
import type { WebUi } from "./webUi.ts";
import { DEFAULT_SETTINGS } from "./chain.ts";

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
  suite: suiteRunner(process.env),
});

/** This start of the server (finding 12 of docs/gui-review.md): run and prompt numbers restart, the incarnation does not. */
const incarnation = `${Date.now().toString(36)}-${randomUUID()}`;

/** How long after an untraced error the process ends whatever is still running: the manager's bounds and 5 s more. */
const FAULT_DEADLINE_MS = SERVER_FAULT_GRACE_MS + SERVER_FAULT_INTERRUPT_MS + 5_000;

const main = Effect.gen(function* () {
  // Issue #158: listening from the start, so an error while the server starts is caught too. Started at once, so its
  // listeners are registered before anything else runs.
  const faultFiber = yield* Effect.forkDetach(firstProcessFault(process), { startImmediately: true });
  // Issue #29: the mount table, read once at the server's start; a failed read (no such file, no permission, another
  // platform) is the empty table, so every path identifies as itself.
  const files = yield* FileSystem.FileSystem;
  const mounts = parseMountinfo(yield* files.readFileString("/proc/self/mountinfo").pipe(Effect.orElseSucceed(() => "")));
  // Issue #120: the tracker of the project in the server's directory, reached from the server and never from the page.
  const manager = yield* makeRunManager(wiringOf, process.cwd(), mounts, incarnation, { sharedConfig: fileURLToPath(new URL("../config.json", import.meta.url)), tracker: liveTracker }, DEFAULT_SETTINGS);
  const web = yield* makeWebServer(manager, distDir);
  yield* HttpServer.serveEffect(web.handler);
  // Registered after serveEffect, so that it runs before the HTTP shutdown, which would wait for the open tabs (finding 15).
  yield* Effect.addFinalizer(() => web.closeAll);
  yield* Effect.sync(() => void process.stdout.write(
    `Interloq web GUI on http://localhost:${port}/ (working directory ${process.cwd()}, project ${identify(mounts, process.cwd())}); Ctrl+C ends the server.\n`));
  const fault = yield* Fiber.join(faultFiber);
  yield* Effect.sync(() => void process.stderr.write(`Interloq: ${fault.kind}: ${fault.text}. Halting every run in progress; the server is ending.\n`));
  // The deadline is armed first and outside Effect: once the process's state is untrusted no Effect-level wait is sure
  // to end (an interruption waits on uninterruptible regions and finalizers, the HTTP shutdown on open connections).
  yield* Effect.sync(() => void setTimeout(() => process.exit(1), FAULT_DEADLINE_MS));
  const report = yield* manager.haltAll(fault.text);
  if (report.unconfirmed.length > 0) yield* Effect.sync(() => void process.stderr.write(`${unrecordedHaltLine(report.unconfirmed)}\n`));
  // A failed main closes the scope, whose finalizer tells every tab the server is ending; the runner's teardown then
  // ends the process with exit code 1.
  return yield* Effect.fail(new ServerFault({ message: fault.text }));
}).pipe(
  Effect.scoped,
  Effect.provide(NodeHttpServer.layer(() => createServer(), { port })),
  Effect.provide(platformLayer),
);

// On SIGINT or SIGTERM the runner interrupts the server; its finalizer tells each tab and closes its socket, then a
// run in progress ends with the process. After an untraced error main fails, and the runner's teardown exits with 1
// (defaultTeardown of effect/dist/Runtime.js, docs/effect-v4-api.md).
NodeRuntime.runMain(main);

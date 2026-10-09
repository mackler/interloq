// The live tracker (issue #120, part 1): the GitHub adapter over Node's fetch, its token read from process.env. Untested
// wiring like src/sdkLive.ts, and the one module of the tracker that reads the environment; it passes the credential
// on and never logs, says or records it. Wired into the server by src/web.ts (issue #120, parts 2 to 4), which gives it
// to the run manager: every run reads its item and sets its state through it.
import { Layer, Result } from "effect";
import { FetchHttpClient } from "effect/http";
import type { NoTracker, TrackerCredentialMissing } from "./errors.ts";
import { githubTrackerFrom } from "./github.ts";
import type { Config } from "./schema.ts";
import type { Tracker } from "./services.ts";

/** The configured tracker over the live HTTP client; refused when the configuration names none or its credential is absent. */
export const liveTracker = (config: Config): Result.Result<Layer.Layer<Tracker>, TrackerCredentialMissing | NoTracker> =>
  Result.map(githubTrackerFrom(config, process.env), (layer) => Layer.provide(layer, FetchHttpClient.layer));

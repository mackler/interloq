// The live tracker (issue #120): the configured adapter, GitHub or Trello, over Node's fetch, its credential read from
// process.env. Untested wiring like src/sdkLive.ts, and the one module of the tracker that reads the environment; it
// passes the credential on and never logs, says or records it. Wired into the server by src/web.ts (issue #120, parts
// 2 to 4), which gives it to the run manager: every run reads its item and sets its state through it.
import { Layer, Result } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/http";
import { NoTracker, type TrackerCredentialMissing } from "./errors.ts";
import { githubTrackerFrom } from "./github.ts";
import type { Config, TrackerConfig } from "./schema.ts";
import type { Tracker } from "./services.ts";
import { trelloTrackerFrom } from "./trello.ts";

/** The adapter of a tracker's kind, its credential from the process's environment; a kind without a case is a type error. */
const adapterOf = (tracker: TrackerConfig): Result.Result<Layer.Layer<Tracker, never, HttpClient.HttpClient>, TrackerCredentialMissing> => {
  switch (tracker.kind) {
    case "github":
      return githubTrackerFrom(tracker, process.env);
    case "trello":
      return trelloTrackerFrom(tracker, process.env);
  }
};

/** The configured tracker over the live HTTP client; refused when the configuration names none or its credential is absent. */
export const liveTracker = (config: Config): Result.Result<Layer.Layer<Tracker>, TrackerCredentialMissing | NoTracker> =>
  config.tracker === null ? Result.fail(new NoTracker()) : Result.map(adapterOf(config.tracker), (layer) => Layer.provide(layer, FetchHttpClient.layer));

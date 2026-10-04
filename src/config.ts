// The configuration files (decided behaviour 9; decision Q4): decoded before any agent call and before the
// records are initialised. Split from the Store (finding 27).

import { Effect, FileSystem, Path, type PlatformError, Result, Schema } from "effect";
import { pathOf, RECORDS_DIR } from "./artifacts.ts";
import { ConfigInvalid, FileSystemError } from "./errors.ts";
import * as S from "./schema.ts";
import type { Config } from "./schema.ts";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const decodeConfigFile = Schema.decodeUnknownResult(S.PartialConfig, { onExcessProperty: "error" });

/** The content of one config file. Invalid JSON, a wrong type and an unknown key are ConfigInvalid. */
export const decodeConfigText = (file: string, text: string): Result.Result<Partial<Config>, ConfigInvalid> => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return Result.fail(new ConfigInvalid({ file, path: "", message: message(e) }));
  }
  const decoded = decodeConfigFile(json);
  return Result.isSuccess(decoded) ? Result.succeed(decoded.success) : Result.fail(new ConfigInvalid({ file, ...S.firstIssue(decoded.failure) }));
};

/** The configuration from its three sources, each later one replacing the keys it sets (decided behaviour 9). */
export const mergeConfig = (shared: Partial<Config>, own: Partial<Config>): Config => ({ ...S.defaultConfig, ...shared, ...own });

/**
 * The configuration: the defaults, then the shared config file, then <project>/plan-review/config.json
 * (decided behaviour 9). Invalid JSON, a wrong type or an unknown key is ConfigInvalid (Q4).
 */
export const loadConfig = (project: string, sharedFile: string): Effect.Effect<Config, ConfigInvalid | FileSystemError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const io = <A>(file: string, effect: Effect.Effect<A, PlatformError.PlatformError>): Effect.Effect<A, FileSystemError> =>
      Effect.mapError(effect, (e) => new FileSystemError({ operation: "read", path: file, message: e.message }));
    const read = (file: string): Effect.Effect<Partial<Config>, ConfigInvalid | FileSystemError> =>
      Effect.gen(function* () {
        if (!(yield* io(file, fs.exists(file)))) return {};
        const text = yield* io(file, fs.readFileString(file));
        return yield* Effect.fromResult(decodeConfigText(file, text));
      });
    const shared = yield* read(sharedFile);
    const own = yield* read(path.join(path.resolve(project), RECORDS_DIR, pathOf({ kind: "config" })));
    return mergeConfig(shared, own);
  });

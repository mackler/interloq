// The chain's state kept across a restart of the server (issue #147, requirements Q4): plan-review/chain.json. An edge
// over Effect's FileSystem and Path services. The file is outside every run's records directory, so neither the records
// guard nor the project snapshot (which excludes plan-review/) sees it.
import { Effect, FileSystem, Path, type PlatformError } from "effect";
import { CHAIN_FILE, RECORDS_DIR } from "./artifacts.ts";
import { type ChainSettings, ChainFileSchema, initialState, type KeptState } from "./chain.ts";
import { PREPARATION_KEPT_OFF } from "./preparationSwitch.ts";
import { describe, FileSystemError } from "./errors.ts";
import { decodeText } from "./state.ts";

const io = <A>(operation: string, file: string, effect: Effect.Effect<A, PlatformError.PlatformError>): Effect.Effect<A, FileSystemError> =>
  Effect.mapError(effect, (e) => new FileSystemError({ operation, path: file, message: e.message }));

const chainPath = (cwd: string): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function* () {
    return (yield* Path.Path).join(cwd, RECORDS_DIR, CHAIN_FILE);
  });

/**
 * The chain's state as the file holds it: missing, an idle chain with the given settings, which starts nothing; a file
 * that cannot be read or decoded, the same with `Unreadable`, never a failure, so a damaged file never stops the server.
 */
export const loadChain = (cwd: string, defaults: ChainSettings): Effect.Effect<KeptState, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* chainPath(cwd);
    // Issue #131: an unreadable file also gives the preparation's switch off, with no failure and no release.
    const unreadable = (message: string): KeptState => ({ chain: { ...initialState(defaults), chain: { _tag: "Idle", ended: { _tag: "Unreadable", message }, history: [] } }, preparation: PREPARATION_KEPT_OFF });
    const read = Effect.gen(function* () {
      if (!(yield* io("read", file, fs.exists(file)))) return { chain: initialState(defaults), preparation: PREPARATION_KEPT_OFF };
      const decoded = decodeText(file, ChainFileSchema, yield* io("read", file, fs.readFileString(file)));
      return decoded._tag === "Success" ? { chain: decoded.success.state, preparation: decoded.success.preparation } : unreadable(describe(decoded.failure));
    });
    return yield* read.pipe(Effect.catch((e) => Effect.succeed(unreadable(describe(e)))));
  });

/** Writes `{ version: 2, state, preparation }` to a temporary name and renames it into place, as every JSON record is written. */
export const saveChain = (cwd: string, kept: KeptState): Effect.Effect<void, FileSystemError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* chainPath(cwd);
    const temporary = `${file}.tmp-${process.pid}`;
    yield* io("write", file, fs.makeDirectory(path.dirname(file), { recursive: true }));
    yield* io("write", temporary, fs.writeFileString(temporary, JSON.stringify({ version: 2, state: kept.chain, preparation: kept.preparation }, null, 2) + "\n"));
    yield* io("rename", file, fs.rename(temporary, file));
  });

/** Removes the file, so a restart finds an idle chain; a missing file is no failure. */
export const removeChain = (cwd: string): Effect.Effect<void, FileSystemError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* chainPath(cwd);
    yield* io("remove", file, fs.remove(file, { force: true }));
  });

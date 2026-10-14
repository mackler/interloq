// Issue #162: the check of a project's listed commands against its package.json (pure). A command that names an npm
// script must name one the manifest has, so a renamed script refuses the run at its start instead of failing a step.
import { Option, Schema } from "effect";
import type { CommandLine, StepChecks } from "./schema.ts";

/**
 * A command whose npm script the manifest lacks, or an npm script command in a project with no top-level package.json.
 * A schema, since it is the data of the halt CheckCommandInvalid, which decodeRunError reads.
 */
export const ManifestProblemSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("MissingScript"), command: Schema.String, script: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("NoManifest"), command: Schema.String }),
]);
export type ManifestProblem = typeof ManifestProblemSchema.Type;

/** Leading environment assignments: NAME=value, NAME='…' or NAME="…", each followed by whitespace. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s'"]*)\s+/u;

const withoutAssignments = (text: string): string => {
  const match = ASSIGNMENT.exec(text);
  return match === null ? text : withoutAssignments(text.slice(match[0].length));
};

/** npm options that take the next word as their value, so that word is not the script (W1-R1-2). */
export const NPM_VALUE_OPTIONS: ReadonlySet<string> = new Set(["--loglevel", "--prefix", "-C", "--workspace", "-w", "--userconfig", "--cache", "--registry", "--script-shell"]);
/** npm options that take no value. */
export const NPM_FLAG_OPTIONS: ReadonlySet<string> = new Set(["--silent", "-s", "--quiet", "-q", "--verbose", "-d", "--if-present", "--ignore-scripts", "--foreground-scripts", "--workspaces", "--ws", "--include-workspace-root"]);

const QUOTING = /['"\\]/u;

/**
 * The script named by the words after `run`: a known value-taking option is skipped with its value, `-x=value` and a
 * known flag alone, and the first other word is the script. None (not checked) where a word up to the script holds a
 * quote or a backslash, since the words were split on whitespace and a shell would join them differently, or where an
 * unknown option stands before a further word, since whether that word is its value cannot be told.
 */
const scriptAfterRun = (words: ReadonlyArray<string>): Option.Option<string> => {
  const [word, next] = words;
  if (word === undefined || QUOTING.test(word)) return Option.none();
  if (word.startsWith("-") && word.includes("=")) return scriptAfterRun(words.slice(1));
  if (NPM_VALUE_OPTIONS.has(word)) return next === undefined || QUOTING.test(next) ? Option.none() : scriptAfterRun(words.slice(2));
  if (NPM_FLAG_OPTIONS.has(word)) return scriptAfterRun(words.slice(1));
  return word.startsWith("-") ? Option.none() : Option.some(word);
};

/**
 * The npm script a command names: `npm run <script>` or `npm run-script <script>`, and `npm test` or `npm t`, which name
 * `test`; any leading environment assignments allowed. Before the script's name, the known npm flags are skipped, and
 * so are the known value-taking options with their values (`--loglevel error`, `--loglevel=error`). An unknown option
 * before a further word, or a quote or backslash in a word up to the script, makes the command unchecked. Every other
 * command is none: it is used as written and not checked.
 */
export const scriptOf = (command: CommandLine): Option.Option<string> => {
  const words = withoutAssignments(command.trim()).split(/\s+/u);
  if (words[0] !== "npm") return Option.none();
  if (words[1] === "test" || words[1] === "t") return Option.some("test");
  if (words[1] !== "run" && words[1] !== "run-script") return Option.none();
  return scriptAfterRun(words.slice(2));
};

/** Every listed command: the check commands in their order, then the suite command where one is set. */
export const listedCommands = (checks: StepChecks): ReadonlyArray<CommandLine> => [
  ...checks.commands.map((entry) => entry.command),
  ...(checks.suite === null ? [] : [checks.suite]),
];

/** The problems of the listed commands against the manifest's scripts; none for the manifest means no package.json. */
export const manifestProblems = (commands: ReadonlyArray<CommandLine>, scripts: Option.Option<Readonly<Record<string, string>>>): ReadonlyArray<ManifestProblem> =>
  commands.flatMap((command): ReadonlyArray<ManifestProblem> => {
    const script = scriptOf(command);
    if (Option.isNone(script)) return [];
    if (Option.isNone(scripts)) return [{ _tag: "NoManifest", command }];
    return Object.hasOwn(scripts.value, script.value) ? [] : [{ _tag: "MissingScript", command, script: script.value }];
  });

/**
 * The scripts of a package.json text. A text that is not JSON, or whose `scripts` is absent or not an object of strings,
 * has none, so every npm command is a missing script rather than a crash.
 */
export const manifestScriptsOf = (text: string): Readonly<Record<string, string>> => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof json !== "object" || json === null || !("scripts" in json)) return {};
  const scripts: unknown = json.scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return {};
  return Object.values(scripts).every((value) => typeof value === "string") ? (scripts as Readonly<Record<string, string>>) : {};
};

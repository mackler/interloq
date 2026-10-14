// Issue #162: the check of a project's listed commands against its package.json (pure). A command that names an npm
// script must name one the manifest has, so a renamed script refuses the run at its start instead of failing a step.
import { Option } from "effect";
import type { CommandLine, StepChecks } from "./schema.ts";

/** A command whose npm script the manifest lacks, or an npm script command in a project with no top-level package.json. */
export type ManifestProblem =
  | Readonly<{ _tag: "MissingScript"; command: CommandLine; script: string }>
  | Readonly<{ _tag: "NoManifest"; command: CommandLine }>;

/** Leading environment assignments: NAME=value, NAME='…' or NAME="…", each followed by whitespace. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s'"]*)\s+/u;

const withoutAssignments = (text: string): string => {
  const match = ASSIGNMENT.exec(text);
  return match === null ? text : withoutAssignments(text.slice(match[0].length));
};

/**
 * The npm script a command names: `npm run <script>` or `npm run-script <script>`, npm flags allowed before the script's
 * name, and `npm test` or `npm t`, which name `test`; any leading environment assignments allowed. Every other command
 * is none: it is used as written and not checked.
 */
export const scriptOf = (command: CommandLine): Option.Option<string> => {
  const words = withoutAssignments(command.trim()).split(/\s+/u);
  if (words[0] !== "npm") return Option.none();
  if (words[1] === "test" || words[1] === "t") return Option.some("test");
  if (words[1] !== "run" && words[1] !== "run-script") return Option.none();
  const script = words.slice(2).find((word) => !word.startsWith("-"));
  return script === undefined ? Option.none() : Option.some(script);
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

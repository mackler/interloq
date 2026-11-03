// Issue #39: a Playwright reporter that, where INTERLOQ_TEST_COUNTS_FILE names a file (Interloq's final run of the
// end-to-end command), writes there a counts file of one counted command: the tests' outcomes as Playwright reported
// them, the command's name as it was invoked, and whether it ran a selection. playwright.config.ts adds it beside the
// list reporter only where the variable is set. Its types are structural, so the test passes fakes and only types come
// from Playwright.
import { writeFileSync } from "node:fs";
import { type PlaywrightOutcome, playwrightCounts } from "../src/runnerCounts.ts";
import { type CommandScope, COUNTS_FILE_VARIABLE, encodeCountsFile } from "../src/testCounts.ts";

/** The arguments after Playwright's own `test` argument. */
const testArgs = (argv: readonly string[]): readonly string[] => {
  const at = argv.indexOf("test");
  return at === -1 ? [] : argv.slice(at + 1);
};
const PLAIN = /^[A-Za-z0-9_\-./=:,@%+]+$/u;
/** An argument as a shell reads it back: single-quoted where it holds anything but plain characters. */
const quoted = (arg: string): string => (PLAIN.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`);

/**
 * The command as it was invoked: `npm run <script>` where npm ran a script (npm sets `npm_lifecycle_event` to the script,
 * and to `npx` for `npx` and `npm exec`), with the arguments npm passed on after `--`; otherwise `npx playwright test`
 * with its arguments.
 */
export const commandNameOf = (env: NodeJS.ProcessEnv, argv: readonly string[]): string => {
  const args = testArgs(argv).map(quoted);
  const event = env.npm_lifecycle_event;
  if (event !== undefined && event !== "" && event !== "npx") return args.length === 0 ? `npm run ${event}` : `npm run ${event} -- ${args.join(" ")}`;
  return ["npx playwright test", ...args].join(" ");
};

// From the `testOptions` table of Playwright's `lib/program.js`, the source of `npx playwright test --help`.
/** The options that run only part of the tests. `-x` and `--max-failures` end a run early but select no test. */
const SELECTION_OPTIONS: ReadonlySet<string> = new Set([
  "-g", "--grep", "-G", "--grep-invert", "--project", "--shard", "--last-failed", "--only-changed", "--test-list", "--test-list-invert",
]);
/** The options shown with a required `<value>`, which consume the next argument. */
const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--add-reporter", "--browser", "-c", "--config", "--global-timeout", "-g", "--grep", "-G", "--grep-invert", "--last-failed-file",
  "--max-failures", "--output", "--project", "--repeat-each", "--reporter", "--retries", "--run-agents", "--shard", "--test-list",
  "--test-list-invert", "--timeout", "--trace", "--tsconfig", "--ui-host", "--ui-port", "--update-source-method", "-j", "--workers",
]);
/** The options with an optional value from listed choices, which consume the next argument only when it is one of them. */
const CHOICE_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["--debug", new Set(["inspector", "cli"])],
  ["-u", new Set(["all", "changed", "missing", "none"])],
  ["--update-snapshots", new Set(["all", "changed", "missing", "none"])],
]);

/** A short option with its value or further flags attached (`-gslow`, `-j4`, `-xj4`): its name and the rest. */
const SHORT_ATTACHED = /^-([A-Za-z0-9])(.+)$/su;

/**
 * Whether one short option with text attached selects tests, read as Commander's `parseOptions` reads it: an option that
 * takes a value (required, or optional as `-u` is) takes the attached text as its value; any other is a boolean flag,
 * and the rest is read as the next short options combined with it (`-xgslow` is `-x` then `-gslow`).
 */
const shortSelects = (name: string, rest: string): boolean => {
  if (SELECTION_OPTIONS.has(name)) return true;
  if (VALUE_OPTIONS.has(name) || CHOICE_OPTIONS.has(name)) return false;
  const next = SHORT_ATTACHED.exec(`-${rest}`);
  return next === null ? false : shortSelects(`-${next[1]}`, next[2]);
};

/** Whether the arguments from `i` on select tests: a file named, or an option that runs only part of the tests. */
const selectsFrom = (args: readonly string[], i: number): boolean => {
  if (i >= args.length) return false;
  const arg = args[i];
  if (arg === "--") return i + 1 < args.length;
  if (!arg.startsWith("-")) return true;
  const short = arg.startsWith("--") ? null : SHORT_ATTACHED.exec(arg);
  if (short !== null) return shortSelects(`-${short[1]}`, short[2]) || selectsFrom(args, i + 1);
  const eq = arg.indexOf("=");
  const name = eq === -1 ? arg : arg.slice(0, eq);
  if (SELECTION_OPTIONS.has(name)) return true;
  const next = args[i + 1];
  const consumes =
    eq === -1 && next !== undefined && (VALUE_OPTIONS.has(name) || (CHOICE_OPTIONS.get(name)?.has(next) ?? false));
  return selectsFrom(args, consumes ? i + 2 : i + 1);
};

/** A selection where E2E_SCENARIOS starts some servers alone, or an argument names a file or a selecting option. */
export const scopeOf = (env: NodeJS.ProcessEnv, argv: readonly string[]): CommandScope => {
  if (env.E2E_SCENARIOS !== undefined && env.E2E_SCENARIOS !== "") return "selection";
  return selectsFrom(testArgs(argv), 0) ? "selection" : "whole";
};

type RunTests = Readonly<{ allTests: () => readonly Readonly<{ outcome: () => PlaywrightOutcome }>[] }>;

export default class CountsReporter {
  #suite: RunTests | null = null;
  onBegin(_config: object, suite: RunTests): void {
    this.#suite = suite;
  }
  onEnd(result: Readonly<{ status: string }>): void {
    const path = process.env[COUNTS_FILE_VARIABLE];
    if (path === undefined || path === "" || this.#suite === null) return;
    const counts = playwrightCounts(this.#suite.allTests().map((t) => t.outcome()));
    const outcome = result.status === "passed" ? "passed" : "failed";
    const name = commandNameOf(process.env, process.argv);
    writeFileSync(path, encodeCountsFile({ version: 2, commands: [{ _tag: "Counted", name, outcome, scope: scopeOf(process.env, process.argv), counts }] }));
  }
  printsToStdio(): boolean {
    return false;
  }
}

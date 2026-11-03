/**
 * The counts of a test run as Interloq reports them (issue #39): what one command that ran reported, and the counts file
 * a final command writes to the path Interloq names in `COUNTS_FILE_VARIABLE`. Pure, also imported by the browser,
 * `scripts/test-all.ts` and `e2e/`, so it imports nothing but `effect`. A command whose runner counts nothing, a build or a
 * type check, carries no number: `Uncounted` has no field for one.
 */
import { Option, Result, Schema } from "effect";
import { SUITE_OUTCOMES, type SuiteOutcome } from "./suite.ts";

/** The environment variable naming the file a final command writes its counts to. */
export const COUNTS_FILE_VARIABLE = "INTERLOQ_TEST_COUNTS_FILE";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));

/** Passed, failed and skipped tests, each as the runner reported it. */
export const TestCountsSchema = Schema.Struct({ passed: Count, failed: Count, skipped: Count });
export type TestCounts = Readonly<{ passed: number; failed: number; skipped: number }>;

export const COMMAND_SCOPES = ["whole", "selection"] as const;
/** Whether a command ran all of its tests or a selection of them. */
export type CommandScope = (typeof COMMAND_SCOPES)[number];
export const COMMAND_OUTCOMES = ["passed", "failed"] as const;
export type CommandOutcome = (typeof COMMAND_OUTCOMES)[number];

const CommandName = Schema.String.check(Schema.isPattern(/\S/u));

export const CommandReportSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Counted"),
    name: CommandName,
    outcome: Schema.Literals(COMMAND_OUTCOMES),
    scope: Schema.Literals(COMMAND_SCOPES),
    counts: TestCountsSchema,
  }),
  Schema.Struct({ _tag: Schema.Literal("Uncounted"), name: CommandName, outcome: Schema.Literals(COMMAND_OUTCOMES) }),
]);
/** One command that ran: counted by its runner, or not (a build, a type check, a runner that reported nothing). */
export type CommandReport =
  | Readonly<{ _tag: "Counted"; name: string; outcome: CommandOutcome; scope: CommandScope; counts: TestCounts }>
  | Readonly<{ _tag: "Uncounted"; name: string; outcome: CommandOutcome }>;

export const CountsFileSchema = Schema.Struct({ version: Schema.Literal(2), commands: Schema.NonEmptyArray(CommandReportSchema) });
export type CountsFile = Readonly<{ version: 2; commands: readonly [CommandReport, ...CommandReport[]] }>;

const decodeFile = Schema.decodeUnknownResult(Schema.fromJsonString(CountsFileSchema), { onExcessProperty: "error" });

/** A counts file's text decoded, or why it is not one. */
export const decodeCountsFile = (text: string): Result.Result<CountsFile, string> =>
  Result.mapError(decodeFile(text), (error) => error.message);

export const encodeCountsFile = (file: CountsFile): string => `${JSON.stringify(file, null, 2)}\n`;

/** A counted command whose passed count fell between two runs. */
export type Fall = Readonly<{ name: string; before: number; after: number }>;

/** Each command counted in both lists whose passed count fell: a change, never a verdict. */
export const fallenCounts = (before: readonly CommandReport[], after: readonly CommandReport[]): readonly Fall[] =>
  after.flatMap((now, i): Fall[] => {
    if (now._tag !== "Counted" || after.findIndex((r) => r.name === now.name) !== i) return [];
    const earlier = before.find((r) => r.name === now.name);
    return earlier !== undefined && earlier._tag === "Counted" && now.counts.passed < earlier.counts.passed
      ? [{ name: now.name, before: earlier.counts.passed, after: now.counts.passed }]
      : [];
  });

/**
 * What a suite run's command reported of its counts: the commands it wrote, nothing (it wrote no counts file), or a file
 * that did not decode, whose reason is kept in the record alone and said nowhere.
 */
export type SuiteReported =
  | Readonly<{ _tag: "Reported"; commands: readonly [CommandReport, ...CommandReport[]] }>
  | Readonly<{ _tag: "NotReported" }>
  | Readonly<{ _tag: "Unreadable"; reason: string }>;
const SuiteReportedSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Reported"), commands: Schema.NonEmptyArray(CommandReportSchema) }),
  Schema.Struct({ _tag: Schema.Literal("NotReported") }),
  Schema.Struct({ _tag: Schema.Literal("Unreadable"), reason: Schema.String }),
]);
/** Interloq's record of suite run n (`suite-<n>.json`), so a later run's counts can be compared with this one's. */
export const SuiteRecordSchema = Schema.Struct({
  version: Schema.Literal(2),
  suite: Schema.Int,
  command: Schema.String,
  result: Schema.Literals(SUITE_OUTCOMES),
  reported: SuiteReportedSchema,
});
export type SuiteRecord = Readonly<{ version: 2; suite: number; command: string; result: SuiteOutcome; reported: SuiteReported }>;

/** What a suite run's counts file, read or absent, reports. */
export const suiteReportedOf = (text: Option.Option<string>): SuiteReported =>
  Option.match(text, {
    onNone: (): SuiteReported => ({ _tag: "NotReported" }),
    onSome: (t) =>
      Result.match(decodeCountsFile(t), {
        onFailure: (reason): SuiteReported => ({ _tag: "Unreadable", reason }),
        onSuccess: (file): SuiteReported => ({ _tag: "Reported", commands: file.commands }),
      }),
  });

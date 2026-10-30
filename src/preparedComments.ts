// The comments of an item's unattended preparation (issue #131, requirements Q1, Q2 and G-R1-2): pure, server-side
// only (it imports node:crypto for the digest, so the browser never imports it). One comment per prepared question,
// then the preparation's own comment, written last, so that a preparation whose own comment is absent is a partial
// write. Each comment is legible Markdown for a person reading the issue, then one hidden data line, then the marker
// line of src/itemComments.ts.
import { createHash } from "node:crypto";
import { Result, Schema } from "effect";
import type { QuestionInvalid } from "./errors.ts";
import { type CommentKey, parseComment, preparationMarkerLine, runCommentKey } from "./itemComments.ts";
import { blocksMarkdown } from "./pieces.ts";
import { PREPARED_QUESTION_NOTE, PREPARED_TERMS_HEADING, preparationCauseText, preparationPreparedText, preparationSetAsideText, preparedQuestionHeading } from "./prompts.ts";
import { withoutRefinement } from "./refinement.ts";
import { renderQuestions, renderTerms } from "./render.ts";
import { StoredQuestion, TermsEntry } from "./schema.ts";
import type { PreparationMark } from "./preparationSwitch.ts";
import type { CommentId, ItemComment, TrackerItem } from "./tracker.ts";

/**
 * The digest of what a preparation was formed from (requirements Q2: only a change of the title or the text discards
 * it): the lowercase hex SHA-256 of the title, a line break and the body without its Refined using Interloq section;
 * the whole body where the section is malformed, since such an item's refinement halts anyway.
 */
export const digestOf = (item: Pick<TrackerItem, "title" | "body">): string => {
  const text = Result.getOrElse(withoutRefinement(item.body), () => item.body);
  return createHash("sha256").update(`${item.title}\n${text}`).digest("hex");
};

/** One prepared question: its entry as questions.json records it and its explanations as terms.json does, or null where terms.json had none for it. */
export type PreparedQuestion = Readonly<{ entry: StoredQuestion; terms: TermsEntry | null }>;
const PreparedQuestionSchema = Schema.Struct({ entry: StoredQuestion, terms: Schema.NullOr(TermsEntry) });

/** Why an item was set aside: its review stopped for the developer, the preparation failed, or a question's comment would be too long. */
export const PreparationCauseSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Paused"), question: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("Failed"), reason: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("TooLong"), question: Schema.String }),
]);
export type PreparationCause = typeof PreparationCauseSchema.Type;

/**
 * What the preparation's own comment holds: its key (its question comments' keys are `<key>/q-<n>`), the item's digest,
 * the switch's generation when it was written, and the day; then the count of questions, or why it was set aside. A
 * set-aside counts only while its generation is the switch's (requirements G-R1-1).
 */
export const PreparationRecordSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Prepared"), key: Schema.String, digest: Schema.String, count: Schema.Int, generation: Schema.Int, date: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("SetAside"), key: Schema.String, digest: Schema.String, generation: Schema.Int, date: Schema.String, cause: PreparationCauseSchema }),
]);
export type PreparationRecord = typeof PreparationRecordSchema.Type;

/** GitHub's limit on a comment, in UTF-16 code units, the stricter of the two trackers (GitLab's is 1,000,000). */
export const COMMENT_LENGTH_LIMIT = 65_536;

/** The key of the preparation's question n. */
export const questionKeyOf = (key: CommentKey, n: number): CommentKey => runCommentKey(key, `q-${n}`);

const DATA_OPEN = "<!-- interloq:data ";
const DATA_CLOSE = " -->";
/**
 * The hidden data line: compact JSON with every `>` written as the JSON escape `>`. A `>` can occur in JSON only
 * inside a string, where the escape denotes the same character, so JSON.parse returns exactly the value written; and
 * the payload then holds no `>`, so no `-->` or `--!>` ends the HTML comment early.
 */
const dataLine = (value: unknown): string => `${DATA_OPEN}${JSON.stringify(value).replaceAll(">", "\\u003e")}${DATA_CLOSE}`;
/** The data a comment carries: its second-to-last line that is not blank, the last being the marker. */
const dataOf = <S extends Schema.Top>(schema: S & Schema.Decoder<S["Type"]>, body: string): Result.Result<S["Type"], unknown> => {
  const line = body.split(/\r\n|\r|\n/u).filter((l) => l.trim() !== "").at(-2) ?? "";
  if (!line.startsWith(DATA_OPEN) || !line.endsWith(DATA_CLOSE)) return Result.fail("no data line");
  return Schema.decodeUnknownResult(Schema.fromJsonString(schema))(line.slice(DATA_OPEN.length, line.length - DATA_CLOSE.length));
};

/** Prepared question n of count: its heading, its context, the question as conversation.md renders it, its terms, the note, the data and the marker. */
export const questionCommentText = (key: CommentKey, n: number, count: number, pq: PreparedQuestion): Result.Result<string, QuestionInvalid> =>
  Result.map(pq.terms === null ? Result.succeed(null) : renderTerms([pq.terms]), (terms) =>
    [
      preparedQuestionHeading(n, count),
      blocksMarkdown(pq.entry.context),
      renderQuestions({ questions: [pq.entry] }).trimEnd(),
      ...(terms === null ? [] : [`${PREPARED_TERMS_HEADING}\n\n${terms.trimEnd()}`]),
      PREPARED_QUESTION_NOTE,
      dataLine(pq),
      preparationMarkerLine("PreparedQuestion", questionKeyOf(key, n)),
    ].filter((part) => part.trim() !== "").join("\n\n"),
  );

/** The preparation's own comment: what became of the preparation in words, the record as data, and the marker. */
export const preparationCommentText = (record: PreparationRecord): string =>
  [record._tag === "Prepared" ? preparationPreparedText(record.date, record.count) : preparationSetAsideText(record.date, record.cause), dataLine(record), preparationMarkerLine("Preparation", runCommentKey(record.key))].join("\n\n");

/** A comment to write, with the key the retry reconciles it by. */
export type PreparationComment = Readonly<{ key: CommentKey; text: string }>;
export type TooLong = Extract<PreparationCause, { _tag: "TooLong" }>;

/**
 * Every comment of a preparation in the order written: the questions, then the preparation's own comment last. A
 * question whose comment would pass COMMENT_LENGTH_LIMIT is TooLong, never split or truncated.
 */
export const preparedComments = (key: CommentKey, questions: readonly PreparedQuestion[], record: PreparationRecord): Result.Result<readonly PreparationComment[], TooLong | QuestionInvalid> =>
  Result.flatMap(
    Result.all(questions.map((q, i) => Result.map(questionCommentText(key, i + 1, questions.length, q), (text) => ({ q, text, key: questionKeyOf(key, i + 1) })))),
    (written): Result.Result<readonly PreparationComment[], TooLong | QuestionInvalid> => {
      const long = written.find((w) => w.text.length > COMMENT_LENGTH_LIMIT);
      if (long !== undefined) return Result.fail({ _tag: "TooLong", question: long.q.entry.id });
      return Result.succeed([...written.map(({ key: k, text }) => ({ key: k, text })), { key: runCommentKey(record.key), text: preparationCommentText(record) }]);
    },
  );

/**
 * What an item's comments hold of a preparation, each variant with the ids of every preparation comment found, any key,
 * for deletion: none; a partial write; a complete preparation a refinement already used (a refinement record after it:
 * Spent); one formed from another title or text (Stale); a set-aside that counts (its generation the switch's, or no
 * generation asked for) or one of another generation (Released); and a complete, current, unspent preparation.
 */
export type PreparationFound =
  | Readonly<{ _tag: "None"; ids: readonly CommentId[] }>
  | Readonly<{ _tag: "Partial"; ids: readonly CommentId[] }>
  | Readonly<{ _tag: "Spent"; ids: readonly CommentId[] }>
  | Readonly<{ _tag: "Stale"; ids: readonly CommentId[] }>
  | Readonly<{ _tag: "SetAside"; ids: readonly CommentId[]; key: string; cause: PreparationCause }>
  | Readonly<{ _tag: "Released"; ids: readonly CommentId[] }>
  | Readonly<{ _tag: "Prepared"; ids: readonly CommentId[]; key: string; questions: readonly StoredQuestion[]; terms: readonly TermsEntry[]; count: number }>;

type Seen = Readonly<{ comment: ItemComment; index: number; own: boolean; base: string; n: number | null }>;
const QUESTION_KEY = /^(.+)\/q-([1-9][0-9]*)$/u;

/** Where several preparations' comments exist, the newest own comment decides. */
export const preparationOf = (comments: readonly ItemComment[], item: Pick<TrackerItem, "title" | "body">, generation: number | null): PreparationFound => {
  const seen: readonly Seen[] = comments.flatMap((comment, index): Seen[] => {
    const marker = parseComment(comment.body);
    if (marker?._tag === "Preparation") return [{ comment, index, own: true, base: marker.key, n: null }];
    if (marker?._tag !== "PreparedQuestion") return [];
    const match = QUESTION_KEY.exec(marker.key);
    return [{ comment, index, own: false, base: match?.[1] ?? marker.key, n: match === null ? null : Number(match[2]) }];
  });
  const ids = seen.map((s) => s.comment.id);
  const own = seen.filter((s) => s.own).at(-1);
  if (own === undefined) return seen.length === 0 ? { _tag: "None", ids } : { _tag: "Partial", ids };
  const record = dataOf(PreparationRecordSchema, own.comment.body);
  if (Result.isFailure(record) || record.success.key !== own.base) return { _tag: "Partial", ids };
  const r = record.success;
  if (r._tag === "SetAside") {
    if (r.digest !== digestOf(item)) return { _tag: "Stale", ids };
    return generation === null || r.generation === generation ? { _tag: "SetAside", ids, key: r.key, cause: r.cause } : { _tag: "Released", ids };
  }
  const questions = Array.from({ length: r.count }, (_, i) => {
    const comment = seen.filter((s) => !s.own && s.base === r.key && s.n === i + 1).at(-1);
    return comment === undefined ? null : Result.getOrNull(dataOf(PreparedQuestionSchema, comment.comment.body));
  });
  if (questions.some((q) => q === null)) return { _tag: "Partial", ids };
  const complete = questions.filter((q): q is PreparedQuestion => q !== null);
  if (comments.some((c, i) => i > own.index && parseComment(c.body)?._tag === "RefinementRecord")) return { _tag: "Spent", ids };
  if (r.digest !== digestOf(item)) return { _tag: "Stale", ids };
  return { _tag: "Prepared", ids, key: r.key, questions: complete.map((q) => q.entry), terms: complete.flatMap((q) => (q.terms === null ? [] : [q.terms])), count: r.count };
};

/** Whether the pass may prepare the item: anything but a current set-aside and a usable preparation. */
export const eligible = (found: PreparationFound): boolean => {
  switch (found._tag) {
    case "None":
    case "Partial":
    case "Spent":
    case "Stale":
    case "Released":
      return true;
    case "SetAside":
    case "Prepared":
      return false;
  }
};

/** The mark an item's row shows in the Refinement list (requirements Q6), or none. */
export const markOf = (found: PreparationFound): PreparationMark | null => {
  switch (found._tag) {
    case "Prepared":
      return { _tag: "Prepared", questions: found.count };
    case "SetAside":
      return { _tag: "SetAside", reason: preparationCauseText(found.cause) };
    case "None":
    case "Partial":
    case "Spent":
    case "Stale":
    case "Released":
      return null;
  }
};

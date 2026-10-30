// The comments Interloq leaves on an item (issue #186, requirements Q3 and Q5): pure. The one place that writes and
// recognizes them, so the writer (src/sendBack.ts, src/run.ts), the tracker retry's reconciliation of a comment
// (src/trackerRetry.ts), the send-back's guard, a refinement's task and the count in the tabs' lists cannot disagree
// on a marker. Each comment ends in one hidden marker line, an HTML comment both GitHub and GitLab render invisibly.
import { type Brand, Result } from "effect";
import { COMMENTS_TASK_HEADING, commentTaskLine, refinementRecordCommentText, sentBackCommentText, stoppedUnrefinedCommentText } from "./prompts.ts";
import type { ItemComment } from "./tracker.ts";

/**
 * A comment's key, unique among every comment Interloq writes: a send-back's or a guard stop's is
 * `<records directory name>/verdict-<n>`, a refinement record's the refinement run's records directory name. Built by
 * commentKeyOf alone: no whitespace and no `-->`, so it stands whole in its marker line.
 */
export type CommentKey = Brand.Branded<string, "CommentKey">;
export type InvalidCommentKey = Readonly<{ _tag: "InvalidCommentKey"; text: string }>;
export const commentKeyOf = (text: string): Result.Result<CommentKey, InvalidCommentKey> =>
  /^\S+$/u.test(text) && !text.includes("-->") ? Result.succeed(text as CommentKey) : Result.fail({ _tag: "InvalidCommentKey", text });

/**
 * The key of a comment named by a run's records directory: its name (`rootName` of src/park.ts), with any whitespace or
 * `-->` replaced, which runRootOf never writes, so the function is total; `suffix` (`verdict-<n>`) after a slash.
 */
export const runCommentKey = (rootName: string, suffix: string | null = null): CommentKey => {
  const safe = (t: string) => t.replace(/\s|-->/gu, "_");
  const text = suffix === null ? safe(rootName) : `${safe(rootName)}/${safe(suffix)}`;
  return (text === "" ? "_" : text) as CommentKey;
};

/** What Interloq writes on an item: a send-back, a guard stop (requirements Q5), or a refinement's record of whether it asked the developer anything. `date` is `YYYY-MM-DD` in UTC. */
export type InterloqComment =
  | Readonly<{ _tag: "SentBack"; key: CommentKey; date: string; missing: string }>
  | Readonly<{ _tag: "StoppedUnrefined"; key: CommentKey; date: string; missing: string }>
  | Readonly<{ _tag: "RefinementRecord"; key: CommentKey; date: string; asked: boolean }>;

/**
 * Issue #131: the two kinds of a preparation's comments, written by src/preparedComments.ts with
 * preparationMarkerLine: a prepared question (key `<preparation's key>/q-<n>`) and the preparation's own comment
 * (key the preparation's key, `runCommentKey` of its records directory name).
 */
export type PreparationMarkerKind = "PreparedQuestion" | "Preparation";

/** What a marker line says: its kind, its key and, for a refinement record, whether it asked. */
export type CommentMarker =
  | Readonly<{ _tag: "SentBack" | "StoppedUnrefined"; key: string }>
  | Readonly<{ _tag: "RefinementRecord"; key: string; asked: boolean }>
  | Readonly<{ _tag: PreparationMarkerKind; key: string }>;

/** The date a comment carries: the instant's UTC day. */
export const commentDateOf = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

/** A comment's text: the developer's words, then the marker line. */
export const commentText = (c: InterloqComment): string => `${wordsOf(c)}\n\n${markerLine(c)}`;

const wordsOf = (c: InterloqComment): string => {
  switch (c._tag) {
    case "SentBack":
      return sentBackCommentText(c.date, c.missing);
    case "StoppedUnrefined":
      return stoppedUnrefinedCommentText(c.date, c.missing);
    case "RefinementRecord":
      return refinementRecordCommentText(c.date, c.asked);
  }
};

const markerLine = (c: InterloqComment): string => {
  switch (c._tag) {
    case "SentBack":
      return `<!-- interloq:sent-back key=${c.key} -->`;
    case "StoppedUnrefined":
      return `<!-- interloq:stopped-unrefined key=${c.key} -->`;
    case "RefinementRecord":
      return `<!-- interloq:refinement key=${c.key} asked=${c.asked ? "yes" : "no"} -->`;
  }
};

/** Issue #131: the marker line of a preparation's comment, the one source the parser below reads. */
export const preparationMarkerLine = (kind: PreparationMarkerKind, key: CommentKey): string =>
  `<!-- interloq:${kind === "Preparation" ? "preparation" : "prepared-question"} key=${key} -->`;

const MARKER = /^<!-- interloq:(sent-back|stopped-unrefined|refinement|preparation|prepared-question) key=(\S+?)(?: asked=(yes|no))? -->$/u;
const lastLine = (body: string): string | undefined => body.split(/\r\n|\r|\n/u).filter((line) => line.trim() !== "").at(-1);

/** The marker of a comment Interloq wrote, read from the body's last non-blank line, exactly; null for anyone else's comment. */
export const parseComment = (body: string): CommentMarker | null => {
  const match = MARKER.exec(lastLine(body) ?? "");
  if (match === null) return null;
  const [, kind, key, asked] = match;
  if (kind === "refinement") return asked === undefined ? null : { _tag: "RefinementRecord", key: key!, asked: asked === "yes" };
  if (asked !== undefined) return null;
  if (kind === "preparation") return { _tag: "Preparation", key: key! };
  if (kind === "prepared-question") return { _tag: "PreparedQuestion", key: key! };
  return { _tag: kind === "sent-back" ? "SentBack" : "StoppedUnrefined", key: key! };
};

/** The body without its marker line, where Interloq wrote it. */
const withoutMarker = (body: string): string => {
  const lines = body.split(/\r\n|\r|\n/u);
  const last = lines.reduce((found, line, i) => (line.trim() !== "" ? i : found), -1);
  return last < 0 ? body : lines.slice(0, last).join("\n").trimEnd();
};

/** The key of a comment Interloq wrote, or null. */
export const keyOf = (body: string): string | null => parseComment(body)?.key ?? null;

/** How many times Interloq sent the item back (F1): its send-back markers, each key counted once. */
export const sentBackCount = (comments: readonly ItemComment[]): number =>
  new Set(comments.flatMap((c) => {
    const marker = parseComment(c.body);
    return marker?._tag === "SentBack" ? [marker.key] : [];
  })).size;

/** Whether the refinement that last refined the item asked the developer anything: the newest record's; none counts as asked (requirements G-R1-1). */
export const lastRefinementAsked = (comments: readonly ItemComment[]): boolean => {
  const records = comments.flatMap((c) => {
    const marker = parseComment(c.body);
    return marker?._tag === "RefinementRecord" ? [marker.asked] : [];
  });
  return records.at(-1) ?? true;
};

/**
 * The comments a refinement run gives its task (requirements Q3), oldest first, without the refinement records, the
 * preparation's comments (issue #131: the prepared questions are not the task) and the marker lines; "" when none remain.
 */
export const commentsTaskText = (comments: readonly ItemComment[]): string => {
  const shown = comments.flatMap((c) => {
    const marker = parseComment(c.body);
    if (marker?._tag === "RefinementRecord" || marker?._tag === "Preparation" || marker?._tag === "PreparedQuestion") return [];
    const text = marker === null ? c.body.trim() : withoutMarker(c.body);
    return text === "" ? [] : [`${commentTaskLine(c.created.slice(0, 10))}\n${text}`];
  });
  return shown.length === 0 ? "" : [COMMENTS_TASK_HEADING, ...shown].join("\n\n");
};

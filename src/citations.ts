// The issues an item cites (issue #216, requirements Q6 and the open point's default): `#<n>` and the issue URLs of
// the item's own project, other repositories not followed; and the file of the cited issues the check reads. Pure;
// the two-level reading is src/bringUpToDate.ts.
import { Option } from "effect";
import type { TrackerConfig } from "./schema.ts";
import { type CitedItem, type ItemId, positiveDecimalOf } from "./tracker.ts";

/** How the item's own project's issue URLs are written, built from the tracker's configuration. */
export type CitationForm = Readonly<{ url: string | null }>;
/** Where no tracker is configured: `#<n>` alone. */
export const NO_URL_FORM: CitationForm = { url: null };

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");

/** The prefix of an issue URL of the configured project, before its number. */
export const citationFormOf = (config: TrackerConfig): CitationForm => {
  switch (config.kind) {
    case "github":
      return { url: `https://github.com/${config.owner}/${config.repo}/issues/` };
    case "gitlab":
      return { url: `https://gitlab.com/${config.project}/-/issues/` };
  }
};

/**
 * Every `#<n>` not preceded by a letter, a digit, `/`, `&` or `#` (so `W1-R1-1`, `&#32;`, a URL's fragment and a `##`
 * heading do not count), and every issue URL of the item's own project, n a positive decimal; each id once, in order
 * of first occurrence, without the ids excluded.
 */
export const citedIdsOf = (text: string, form: CitationForm, exclude: readonly ItemId[]): readonly ItemId[] => {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}/&#])#(\\d+)(?!\\d)${form.url === null ? "" : `|${escaped(form.url)}(\\d+)(?!\\d)`}`, "gu");
  const found = [...text.matchAll(pattern)].flatMap((m) => Option.match(positiveDecimalOf(m[1] ?? m[2] ?? ""), { onNone: () => [], onSome: (n) => [String(n) as ItemId] }));
  return [...new Set(found)].filter((id) => !exclude.includes(id));
};

/** A cited issue as read, its open or closed state kept, or one that could not be read, with the reason. */
export type CitedIssue = Readonly<{ _tag: "Read" } & CitedItem> | Readonly<{ _tag: "Unreadable"; id: ItemId; reason: string }>;

/** A fence longer than any run of backticks in the text, at least three, so the text cannot end its block. */
const fenceFor = (text: string): string => "`".repeat(Math.max(3, 1 + Math.max(0, ...(text.match(/`+/gu) ?? []).map((r) => r.length))));

/** The file `cited-issues.md`: each issue under a heading with its number, open or closed, and title, its whole body fenced. */
export const citedIssuesMarkdown = (cited: readonly CitedIssue[]): string =>
  ["# Cited issues", ...cited.map((c) => {
    if (c._tag === "Unreadable") return `## #${c.id} (unreadable)\n\n${c.reason}`;
    const fence = fenceFor(c.body);
    return `## #${c.id} (${c.open ? "open" : "closed"}): ${c.title}\n\n${fence}\n${c.body}\n${fence}`;
  }), ...(cited.length === 0 ? ["The item cites no issue."] : [])].join("\n\n") + "\n";

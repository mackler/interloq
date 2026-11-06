// Issue #252: the late-findings measure over a run's code reviews (pure; no Effect, no I/O). A finding of code review k is
// late when its file's section of review k's changes.diff equals that file's section in an earlier code review's diff
// of the same run: a later code review found it in code an earlier one had read. The measure does not show defects
// never found, and does not by itself say why one was missed.

export type CodeReviewFinding = Readonly<{ id: string; location: string }>;
export type CodeReviewRecord = Readonly<{ review: number; diff: string; findings: readonly CodeReviewFinding[] }>;
export type LateFindings = Readonly<{ late: readonly string[]; total: number }>;

/** A path as Git writes it in a diff: C-quoted (`"b/…"`, escapes and octal UTF-8 bytes) where it needs it, plain otherwise. */
const unquoted = (text: string): string => {
  if (!(text.startsWith('"') && text.endsWith('"') && text.length >= 2)) return text;
  const bytes: number[] = [];
  const inner = text.slice(1, -1);
  const named: Readonly<Record<string, number>> = { t: 9, n: 10, r: 13, a: 7, b: 8, f: 12, v: 11, "\\": 92, '"': 34 };
  const encoder = new TextEncoder();
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== "\\" || i + 1 >= inner.length) {
      // S13 (W1-R1-2): the run of unescaped text up to the next escape is encoded whole, so by code point.
      const end = inner.indexOf("\\", i + 1);
      const stop = end === -1 || end + 1 >= inner.length ? inner.length : end;
      bytes.push(...encoder.encode(inner.slice(i, stop)));
      i = stop - 1;
      continue;
    }
    const next = inner[i + 1]!;
    if (/^[0-7]{3}$/.test(inner.slice(i + 1, i + 4))) {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(named[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
};
/** A path of a `---` or `+++` line: the trailing tab Git writes after a path with a space dropped, then unquoted. */
const linePath = (rest: string): string => unquoted(rest.endsWith("\t") ? rest.slice(0, -1) : rest);
const withoutPrefix = (p: string, prefix: string): string => (p.startsWith(prefix) ? p.slice(prefix.length) : p);
/** The path of a header `diff --git a/P b/P` whose halves are the same path: never split at the last ` b/`. */
const headerPath = (rest: string): string | null => {
  const quoted = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest);
  if (quoted !== null) return withoutPrefix(unquoted(quoted[2]!), "b/");
  const length = (rest.length - 5) / 2;
  if (!Number.isInteger(length) || length < 1 || !rest.startsWith("a/")) return null;
  const p = rest.slice(2, 2 + length);
  return rest.slice(2 + length) === ` b/${p}` ? p : null;
};
/** The path a section is about: its `+++` line (or `---` for a deleted file), else `rename to`, else its header. */
const sectionPath = (lines: readonly string[]): string | null => {
  const plus = lines.find((l) => l.startsWith("+++ "));
  if (plus !== undefined) {
    const target = linePath(plus.slice(4));
    if (target !== "/dev/null") return withoutPrefix(target, "b/");
    const minus = lines.find((l) => l.startsWith("--- "));
    if (minus !== undefined) return withoutPrefix(linePath(minus.slice(4)), "a/");
  }
  const renamed = lines.find((l) => l.startsWith("rename to "));
  if (renamed !== undefined) return unquoted(renamed.slice("rename to ".length));
  return headerPath(lines[0]!.slice("diff --git ".length));
};
/** A diff's sections by the path each is about, each section's whole text, its header included. */
export const diffSections = (diff: string): ReadonlyMap<string, string> => {
  const sections = new Map<string, string>();
  const starts = [...diff.matchAll(/^diff --git /gmu)].map((m) => m.index);
  for (const [k, start] of starts.entries()) {
    const text = diff.slice(start, starts[k + 1] ?? diff.length);
    const lines = text.split("\n");
    // The section's own lines up to its first hunk: the path is never read from content.
    const hunk = lines.findIndex((l) => l.startsWith("@@"));
    const head = hunk === -1 ? lines : lines.slice(0, hunk);
    const file = sectionPath(head);
    if (file !== null) sections.set(file, text);
  }
  return sections;
};
const BEFORE = /[ (]/u;
const AFTER = /[:\s),]/u;
/** The longest of `paths` the location names: at its start or after a space or `(`, followed by its end, `:`, whitespace, `)` or `,`. */
export const fileOf = (location: string, paths: readonly string[]): string | null =>
  [...paths]
    .sort((a, b) => b.length - a.length)
    .find((p) => {
      for (let at = location.indexOf(p); at >= 0; at = location.indexOf(p, at + 1)) {
        const end = at + p.length;
        if ((at === 0 || BEFORE.test(location[at - 1]!)) && (end === location.length || AFTER.test(location[end]!))) return true;
      }
      return false;
    }) ?? null;
/** The late findings of a run's code reviews, and the count of every finding. */
export const lateFindings = (records: readonly CodeReviewRecord[]): LateFindings => {
  const sectioned = records.map((r) => ({ review: r.review, sections: diffSections(r.diff), findings: r.findings }));
  const late = sectioned.flatMap((r) =>
    r.findings.flatMap((f) => {
      const file = fileOf(f.location, [...r.sections.keys()]);
      if (file === null) return [];
      const own = r.sections.get(file);
      return sectioned.some((e) => e.review < r.review && e.sections.get(file) === own) ? [f.id] : [];
    }),
  );
  return { late, total: records.reduce((n, r) => n + r.findings.length, 0) };
};

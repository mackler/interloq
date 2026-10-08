import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { hostDirOf, identify, parseMountinfo, type MountRecord } from "../src/hostDir.ts";

// Issue #29: the parser of /proc/self/mountinfo and the lookup of a path's host directory, over generated input.
const RUNS = { numRuns: 200 };

/** A path component: never empty, never a slash, often with the characters the kernel escapes. */
const segment = fc.array(fc.constantFrom("a", "b", "x", "0", "4", " ", "\t", "\n", "\\", "-"), { minLength: 1, maxLength: 5 }).map((cs) => cs.join(""));
/** An absolute path other than `/`, without a trailing slash. */
const path = fc.array(segment, { minLength: 1, maxLength: 3 }).map((ss) => `/${ss.join("/")}`);
const record: fc.Arbitrary<MountRecord> = fc.tuple(path, path).map(([root, point]) => ({ root, point }));
const optional = fc.array(fc.constantFrom("shared:1", "master:2", "propagate_from:3", "unbindable"), { maxLength: 3 });

/** The kernel's escaping of a path in mountinfo. */
const escape = (s: string): string => s.replace(/[\\ \t\n]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, "0")}`);
const lineOf = (r: MountRecord, fields: readonly string[], i: number): string =>
  [String(100 + i), "1", "8:1", escape(r.root), escape(r.point), "rw", ...fields, "-", "ext4", "/dev/sda1", "rw"].join(" ");

test("property: parseMountinfo is total, and never keeps a root of /", () => {
  const token = fc.oneof(fc.string(), fc.constantFrom("-", "/", "/a", "\\040", "1", "8:1"));
  const text = fc.oneof(fc.string(), fc.array(fc.array(token, { maxLength: 12 }).map((ts) => ts.join(" ")), { maxLength: 6 }).map((ls) => ls.join("\n")));
  fc.assert(
    fc.property(text, (t) => {
      const table = parseMountinfo(t);
      assert.ok(Array.isArray(table));
      for (const r of table) assert.notEqual(r.root, "/");
    }),
    RUNS,
  );
});

test("property: records written as mountinfo lines, escaped and with optional fields, parse back to themselves", () => {
  fc.assert(
    fc.property(fc.array(fc.tuple(record, optional), { maxLength: 5 }), (rows) => {
      const text = rows.map(([r, fields], i) => lineOf(r, fields, i)).join("\n");
      assert.deepEqual(parseMountinfo(text), rows.map(([r]) => r));
    }),
    RUNS,
  );
});

/** The model: the longest mount point equal to the path or followed in it by a slash. */
const model = (table: readonly MountRecord[], p: string): string | null => {
  const containing = table.filter((r) => p === r.point || p.startsWith(`${r.point}/`));
  if (containing.length === 0) return null;
  const longest = containing.reduce((a, b) => (b.point.length > a.point.length ? b : a));
  return longest.root + p.slice(longest.point.length);
};

test("property: hostDirOf is the root of the longest containing mount point plus the rest, and null where none contains the path", () => {
  const table = fc.array(record, { maxLength: 5 });
  const caseOf = table.chain((t) =>
    fc.tuple(
      fc.constant(t),
      t.length === 0 ? path : fc.oneof(path, fc.tuple(fc.constantFrom(...t.map((r) => r.point)), fc.array(segment, { maxLength: 2 })).map(([p, rest]) => [p, ...rest].join("/"))),
    ),
  );
  fc.assert(
    fc.property(caseOf, ([t, p]) => {
      assert.equal(hostDirOf(t, p), model(t, p));
      assert.equal(identify(t, p), model(t, p) ?? p);
    }),
    RUNS,
  );
});

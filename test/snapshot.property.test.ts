import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import fc from "fast-check";
import { compareSnapshots, decodeStatusV2, excluded, excludedIndexPaths, type Snapshot, type SnapshotEntry, type StatusRecord, type WorkingTreeEntry } from "../src/snapshot.ts";
import { platformLayer } from "../src/platform.ts";
import { makeStore } from "../src/store.ts";
import { tempRepo , TEST_ROOT } from "./helpers.ts";

// Row 4 of the table in recommendation E of docs/functional-design-review.md.

const RUNS = { numRuns: 200, seed: 20260925 };
const record = <T>(shape: { [K in keyof T]: fc.Arbitrary<T[K]> }): fc.Arbitrary<T> => fc.record(shape, { noNullPrototype: true }) as fc.Arbitrary<T>;
const hex40 = fc.stringMatching(/^[0-9a-f]{40}$/);
const mode = fc.constantFrom("000000", "100644", "100755", "120000", "160000");
const xy = fc.stringMatching(/^[.MADRCU]{2}$/);
// A raw path: anything but NUL and "/" runs; tabs, quotes, spaces and newlines are ordinary characters.
const arbPath = fc.stringMatching(/^[a-z" \t\n\\][a-z0-9" \t\n\\.]{0,6}$/).filter((p) => !p.startsWith("plan-review/") && p.trim() !== "");
const arbRecord: fc.Arbitrary<StatusRecord> = fc.oneof(
  record({ kind: fc.constant("changed" as const), xy, sub: fc.constant("N..."), mH: mode, mI: mode, mW: mode, hH: hex40, hI: hex40, path: arbPath }),
  record({ kind: fc.constant("renamed" as const), xy, sub: fc.constant("N..."), mH: mode, mI: mode, mW: mode, hH: hex40, hI: hex40, score: fc.stringMatching(/^[RC][0-9]{1,3}$/), path: arbPath, origPath: arbPath }),
  record({ kind: fc.constant("unmerged" as const), xy, sub: fc.constant("N..."), path: arbPath }),
  record({ kind: fc.constant("untracked" as const), path: arbPath }),
);
/** The encoder the decoder must invert: the porcelain v2 -z format as git writes it. */
const encode = (records: readonly StatusRecord[]): string =>
  records
    .map((r) => {
      switch (r.kind) {
        case "changed":
          return `1 ${r.xy} ${r.sub} ${r.mH} ${r.mI} ${r.mW} ${r.hH} ${r.hI} ${r.path}\0`;
        case "renamed":
          return `2 ${r.xy} ${r.sub} ${r.mH} ${r.mI} ${r.mW} ${r.hH} ${r.hI} ${r.score} ${r.path}\0${r.origPath}\0`;
        case "unmerged":
          return `u ${r.xy} ${r.sub} 100644 100644 100644 100644 ${"0".repeat(40)} ${"0".repeat(40)} ${"0".repeat(40)} ${r.path}\0`;
        case "untracked":
          return `? ${r.path}\0`;
      }
    })
    .join("");
const arbContent: fc.Arbitrary<WorkingTreeEntry> = fc.oneof(
  record({ type: fc.constant("file" as const), hash: fc.string({ minLength: 1 }) }),
  record({ type: fc.constant("link" as const), target: fc.string({ minLength: 1 }) }),
  fc.constant({ type: "directory" as const }),
  fc.constant({ type: "missing" as const }),
);
const arbSnapshot: fc.Arbitrary<Snapshot> = fc
  .uniqueArray(arbPath, { maxLength: 6 })
  .chain((paths) => fc.tuple(...paths.map((p) => record<SnapshotEntry>({ record: arbRecord.map((r) => ({ ...r, path: p })), content: arbContent }).map((e) => [p, e] as const))))
  .map((entries) => ({ entries: new Map(entries) }));

test("property: decodeStatusV2 is total and inverts the encoder", () => {
  fc.assert(fc.property(fc.array(arbRecord, { maxLength: 6 }), (records) => assert.deepEqual(decodeStatusV2(encode(records)), records)), RUNS);
  fc.assert(fc.property(fc.string(), (text) => void decodeStatusV2(text.replace(/\0/g, ""))), RUNS);
});

test("property: a snapshot compared with itself has no change, and changing one component is detected with the matching kind", () => {
  fc.assert(
    fc.property(arbSnapshot.filter((s) => s.entries.size > 0), fc.nat(), fc.constantFrom("status", "type", "content", "presence"), hex40, (before, pick, component, fresh) => {
      assert.deepEqual(compareSnapshots(before, before), []);
      const paths = [...before.entries.keys()].sort();
      const target = paths[pick % paths.length];
      const current = before.entries.get(target)!;
      const entries = new Map(before.entries);
      let expected: string;
      if (component === "presence") {
        entries.delete(target);
        expected = "removed";
      } else if (component === "status") {
        const r = current.record;
        entries.set(target, { ...current, record: r.kind === "untracked" ? { kind: "changed", xy: "??", sub: "N...", mH: "0", mI: "0", mW: "0", hH: fresh, hI: fresh, path: target } : { ...r, xy: r.xy === "ZZ" ? "YY" : "ZZ" } });
        expected = "status_changed";
      } else if (component === "type") {
        const c = current.content;
        entries.set(target, { ...current, content: c.type === "file" ? { type: "link", target: fresh } : { type: "file", hash: fresh } });
        expected = "type_changed";
      } else {
        const c = current.content;
        if (c.type === "directory" || c.type === "missing") return; // no content component to change
        entries.set(target, { ...current, content: c.type === "file" ? { type: "file", hash: c.hash + "x" } : { type: "link", target: c.target + "x" } });
        expected = "content_changed";
      }
      const changes = compareSnapshots(before, { entries });
      assert.deepEqual(changes.map((c) => `${c.kind} ${c.path}`), [`${expected} ${target}`]);
    }),
    RUNS,
  );
});

test("property: a file entry and a link entry are never equal, whatever their strings", () => {
  fc.assert(
    fc.property(fc.string(), fc.string(), arbPath, (hash, target, p) => {
      const file: Snapshot = { entries: new Map([[p, { record: { kind: "untracked", path: p }, content: { type: "file", hash } }]]) };
      const link: Snapshot = { entries: new Map([[p, { record: { kind: "untracked", path: p }, content: { type: "link", target } }]]) };
      assert.equal(compareSnapshots(file, link).length, 1);
      assert.equal(compareSnapshots(link, file).length, 1);
    }),
    RUNS,
  );
});

test("property: the order of the entries does not change the comparison, and its result is in path order", () => {
  fc.assert(
    fc.property(arbSnapshot, arbSnapshot, (a, b) => {
      const shuffled = (s: Snapshot): Snapshot => ({ entries: new Map([...s.entries].reverse()) });
      const changes = compareSnapshots(a, b);
      assert.deepEqual(compareSnapshots(shuffled(a), shuffled(b)), changes);
      assert.deepEqual(changes.map((c) => c.path), [...changes.map((c) => c.path)].sort());
    }),
    RUNS,
  );
});

test("property: excluded respects directory boundaries", () => {
  const segment = fc.stringMatching(/^[a-z]{1,4}$/);
  fc.assert(
    fc.property(fc.array(segment, { minLength: 1, maxLength: 3 }), segment, fc.array(segment, { maxLength: 2 }), (dir, extra, rest) => {
      const prefix = dir.join("/");
      const inside = [...dir, ...rest].join("/");
      const sibling = [...dir.slice(0, -1), dir[dir.length - 1] + extra, ...rest].join("/");
      assert.equal(excluded(inside, [prefix]), true);
      assert.equal(excluded(inside, [prefix + "/"]), true);
      assert.equal(excluded(sibling, [prefix]), false, `${sibling} excluded by ${prefix}`);
      assert.equal(excluded(`plan-review/${inside}`, []), true);
    }),
    RUNS,
  );
});

// Generated operations on a temporary repository, compared against an independent oracle: the raw git status
// output plus the bytes of every listed path. numRuns ≤ 25 (each run is a real repository).
type Op = { op: "create" | "modify" | "delete" | "stage" | "rename"; name: string; other: string; content: string };
const fileName = fc.stringMatching(/^[a-z][a-z0-9 "\t]{0,5}\.txt$/);
const arbOps = fc.array(record<Op>({ op: fc.constantFrom("create", "modify", "delete", "stage", "rename"), name: fileName, other: fileName, content: fc.string({ maxLength: 8 }) }), { minLength: 1, maxLength: 5 });
const apply = (repo: string, ops: readonly Op[]): void => {
  for (const o of ops) {
    const file = path.join(repo, o.name);
    try {
      if (o.op === "create" || o.op === "modify") fs.writeFileSync(file, o.content);
      else if (o.op === "delete") fs.rmSync(file, { force: true });
      else if (o.op === "stage") execFileSync("git", ["-C", repo, "add", "--", o.name]);
      else if (fs.existsSync(file)) fs.renameSync(file, path.join(repo, o.other));
    } catch {
      // an operation on a missing file is a no-op
    }
  }
};
const oracle = (repo: string): string => {
  const status = execFileSync("git", ["-C", repo, "status", "--porcelain=v2", "-z", "--untracked-files=all"], { encoding: "utf8" });
  const names = fs.readdirSync(repo).filter((n) => n !== ".git");
  return status + "|" + names.map((n) => `${n}=${fs.readFileSync(path.join(repo, n), "utf8")}`).join("|");
};

test("property: generated file operations are detected between two snapshots exactly when the working tree or index differs", async () => {
  await fc.assert(
    fc.asyncProperty(arbOps, arbOps, async (first, second) => {
      const repo = tempRepo();
      apply(repo, first);
      const s = await Effect.runPromise(makeStore(repo, TEST_ROOT, []).pipe(Effect.provide(platformLayer)));
      const before = await Effect.runPromise(s.projectSnapshot());
      const oracleBefore = oracle(repo);
      apply(repo, second);
      const after = await Effect.runPromise(s.projectSnapshot());
      const changes = compareSnapshots(before, after);
      assert.equal(changes.length > 0, oracle(repo) !== oracleBefore, `changes: ${JSON.stringify(changes)}\nops: ${JSON.stringify(second)}`);
    }),
    { numRuns: 25, seed: 20260925 },
  );
});

// Finding 9 of docs/gui-review.md: the exclusion policy tested against an independent statement of it, written here
// from the documented rules (CLAUDE.md, the project snapshot; src/snapshot.ts), not from `excluded`. A path is
// excluded when it lies under the directory plan-review/ at the root, or when its segments begin with the segments of
// an ignorePaths entry (a trailing "/" makes no difference). Glob characters are literal; plan-review/ below the root
// and a name that merely starts with "plan-review" are not excluded. Paths are root-relative: since stage C the
// project is the worktree's top-level directory.
const policy = (p: string, ignore: readonly string[]): boolean => {
  const segments = p.split("/");
  const startsWith = (prefix: readonly string[]) => prefix.length <= segments.length && prefix.every((s, i) => segments[i] === s);
  if (segments.length > 1 && segments[0] === "plan-review") return true;
  return ignore.some((entry) => startsWith(entry.replace(/\/$/, "").split("/")));
};
const segment = fc.oneof(fc.stringMatching(/^[a-z*?[\]._-]{1,6}$/), fc.constantFrom("plan-review", "plan-reviewx", "sub", "src"));
const relPath = fc.array(segment, { minLength: 1, maxLength: 4 }).map((s) => s.join("/"));
const ignoreEntry = fc.oneof(relPath, relPath.map((p) => p + "/"));

test("property: excluded and excludedIndexPaths follow the independent path policy", () => {
  fc.assert(
    fc.property(fc.array(relPath, { maxLength: 12 }), fc.array(ignoreEntry, { maxLength: 4 }), (paths, ignore) => {
      for (const p of paths) assert.equal(excluded(p, ignore), policy(p, ignore), `${p} with ${JSON.stringify(ignore)}`);
      assert.deepEqual(excludedIndexPaths(paths, ignore), paths.filter((p) => policy(p, ignore)));
    }),
    { numRuns: 300, seed: 20260926 },
  );
});

test("the policy's boundary examples: nested and look-alike records, literal globs, prefixes", () => {
  const cases: [string, readonly string[], boolean][] = [
    ["plan-review/plan.md", [], true],
    ["sub/plan-review/plan.md", [], false],
    ["plan-reviewx/y", [], false],
    ["a*b/c", ["a*b"], true],
    ["axb/c", ["a*b"], false],
    [".devcontainer/claude.json", [".devcontainer/claude.json"], true],
    ["src/x.ts", ["src/"], true],
    ["srcx/x.ts", ["src"], false],
  ];
  for (const [p, ignore, expected] of cases) {
    assert.equal(policy(p, ignore), expected, `policy: ${p}`);
    assert.equal(excluded(p, ignore), expected, `excluded: ${p}`);
  }
});

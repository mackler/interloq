import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Result } from "effect";
import {
  backlogAdmit, backlogTake, EMPTY_BACKLOG, NEW_SANITIZER, type OutputBacklog, type OutputEnvelope, type OutputEvent, plainOutput,
  PROCESS_NAME_LENGTH, type ProcessKey, processKeyOf, processNameOf, sanitizeChunk,
} from "../src/liveOutput.ts";

// Issue #49: the live output's pure core.

const RUNS = { numRuns: 200, seed: 20261030 };
const ESC = "\u001b";
const keyOf = (id: string): ProcessKey => Result.getOrThrow(processKeyOf({ kind: "claude", id }));

const arbChar = fc.constantFrom("a", "b", " ", "\t", "\r", "\n", ESC, "[", "]", "3", "1", "m", ";", "\u0007", "\\", "\u0000", "\u0008", "é", "<", "`");
const arbText = fc.array(arbChar, { maxLength: 60 }).map((cs) => cs.join(""));

const chunked = (text: string, cuts: readonly number[]): string[] => {
  const points = [...new Set(cuts.map((c) => c % (text.length + 1)))].sort((a, b) => a - b);
  return [0, ...points].map((p, i, all) => text.slice(p, all[i + 1] ?? text.length));
};
const sanitizeAll = (chunks: readonly string[]): string => {
  let s = NEW_SANITIZER;
  let out = "";
  for (const c of chunks) {
    const [next, text] = sanitizeChunk(s, c);
    s = next;
    out += text;
  }
  return out;
};

test("plainOutput leaves no ESC and no control character but tab, CR and LF, and is idempotent", () => {
  fc.assert(
    fc.property(arbText, (t) => {
      const p = plainOutput(t);
      assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(p));
      assert.equal(plainOutput(p), p);
    }),
    RUNS,
  );
});

test("plainOutput leaves text without escapes unchanged", () => {
  fc.assert(fc.property(fc.string().filter((t) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(t)), (t) => assert.equal(plainOutput(t), t)), RUNS);
});

test("any split of a text into chunks sanitizes to plainOutput of the whole", () => {
  fc.assert(fc.property(arbText, fc.array(fc.nat(), { maxLength: 6 }), (t, cuts) => assert.equal(sanitizeAll(chunked(t, cuts)), plainOutput(t))), RUNS);
});

test("a CSI and an OSC split across chunks are removed whole, a long OSC included", () => {
  assert.equal(sanitizeAll([`ok ${ESC}[3`, "2mgreen", `${ESC}[0m done`]), "ok green done");
  assert.equal(sanitizeAll([`a${ESC}]0;ti`, `tle\u0007b`]), "ab");
  assert.equal(sanitizeAll([`a${ESC}]8;;x`, `${ESC}`, "\\b"]), "ab");
  const osc = `${ESC}]${"x".repeat(1000)}\u0007`;
  assert.equal(sanitizeAll(["<", osc.slice(0, 255), osc.slice(255, 257), osc.slice(257), ">"]), "<>");
});

test("processNameOf is one line of at most 40 characters and an ellipsis", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 120 }), (t) => {
      const n = processNameOf(t);
      assert.ok(!/[\r\n]/u.test(n));
      assert.ok(Array.from(n).length <= PROCESS_NAME_LENGTH + 1);
    }),
    RUNS,
  );
  assert.equal(processNameOf("  npm   test\nsecond line"), "npm test");
  assert.equal(processNameOf("x".repeat(50)), `${"x".repeat(40)}…`);
});

test("processKeyOf refuses a blank part and keeps one Codex item apart under two call ids", () => {
  assert.ok(Result.isFailure(processKeyOf({ kind: "claude", id: " " })));
  assert.ok(Result.isFailure(processKeyOf({ kind: "codex", callId: "", item: "item_1" })));
  assert.ok(Result.isFailure(processKeyOf({ kind: "reasoning", callId: "codex-1", item: "" })));
  assert.ok(Result.isFailure(processKeyOf({ kind: "suite", run: 0 })));
  // An id the SDK left out of a message is refused, never a defect.
  assert.ok(Result.isFailure(processKeyOf({ kind: "claude", id: undefined as unknown as string })));
  const a = Result.getOrThrow(processKeyOf({ kind: "codex", callId: "codex-1", item: "item_1" }));
  const b = Result.getOrThrow(processKeyOf({ kind: "codex", callId: "codex-2", item: "item_1" }));
  assert.notEqual(a, b);
  assert.equal(Result.getOrThrow(processKeyOf({ kind: "suite", run: 3 })), "suite:3");
});

// The backlog, over interleavings of admits and takes. A source sends per process Started, then Printed and Progress,
// then perhaps Finished; the tab is everything taken, in order.
type Op = Readonly<{ admit: OutputEnvelope }> | Readonly<{ take: true }>;
const KEYS: readonly ProcessKey[] = [
  keyOf("a"), keyOf("b"), keyOf("c"),
  Result.getOrThrow(processKeyOf({ kind: "codex", callId: "codex-1", item: "i" })),
  Result.getOrThrow(processKeyOf({ kind: "codex", callId: "codex-2", item: "i" })),
];
const arbOps: fc.Arbitrary<readonly Op[]> = fc
  .array(fc.tuple(fc.constantFrom(1, 2), fc.constantFrom(...KEYS), fc.constantFrom("print", "progress", "finish", "touch", "take")), { maxLength: 120 })
  .map((raw) => {
    const state = new Map<string, "running" | "done">();
    const ops: Op[] = [];
    raw.forEach(([run, key, what], i) => {
      if (what === "take") return void ops.push({ take: true });
      if (what === "touch") return void ops.push({ admit: { run, event: { _tag: "Touched", name: `read ${i}` } } });
      const id = `${run}:${key}`;
      if (state.get(id) === "done") return;
      if (!state.has(id)) {
        state.set(id, "running");
        ops.push({ admit: { run, event: { _tag: "Started", key, name: key } } });
      }
      const event: OutputEvent =
        what === "print" ? { _tag: "Printed", key, name: key, text: `line ${i}\n` }
        : what === "progress" ? { _tag: "Progress", key, name: key, seconds: i }
        : { _tag: "Finished", key, name: key, status: { _tag: "Exited", code: i } };
      if (what === "finish") state.set(id, "done");
      ops.push({ admit: { run, event } });
    });
    return [...ops, { take: true }];
  });

const idOf = (e: OutputEnvelope): string | null => (e.event._tag === "Touched" ? null : `${e.run}:${e.event.key}`);
const finalStates = (events: readonly OutputEnvelope[]): Map<string, string> => {
  const m = new Map<string, string>();
  for (const e of events) {
    const id = idOf(e);
    if (id !== null) m.set(id, e.event._tag === "Finished" ? `finished ${JSON.stringify(e.event.status)}` : "running");
  }
  return m;
};

test("the backlog keeps order, stays within its bound, and never leaves a process shown running past its end", () => {
  fc.assert(
    fc.property(arbOps, fc.integer({ min: 1, max: 12 }), (ops, bound) => {
      let backlog: OutputBacklog = EMPTY_BACKLOG;
      const sent: OutputEnvelope[] = [];
      const tab: OutputEnvelope[] = [];
      const takenStarted = new Set<string>();
      for (const op of ops) {
        if ("take" in op) {
          const [handed, rest] = backlogTake(backlog);
          for (const e of handed) if (e.event._tag === "Started") takenStarted.add(idOf(e) ?? "");
          tab.push(...handed);
          backlog = rest;
          continue;
        }
        sent.push(op.admit);
        backlog = backlogAdmit(backlog, op.admit, bound);
        const positions = backlog.map((e) => sent.indexOf(e));
        assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "arrival order kept");
        const finished = new Set(sent.filter((e) => e.event._tag === "Finished").map(idOf));
        const running = new Set(sent.map(idOf).filter((id) => id !== null && !finished.has(id)));
        const finishedAfterTake = [...finished].filter((id) => id !== null && takenStarted.has(id)).length;
        assert.ok(backlog.length <= bound + 2 * running.size + finishedAfterTake, `size ${backlog.length}`);
      }
      const atSource = finalStates(sent);
      const atTab = finalStates(tab);
      for (const [id, state] of atTab) assert.equal(state, atSource.get(id), `process ${id}`);
    }),
    RUNS,
  );
});

test("10,000 Progress events of one process keep one pending", () => {
  const key = keyOf("p");
  let b: OutputBacklog = backlogAdmit(EMPTY_BACKLOG, { run: 1, event: { _tag: "Started", key, name: "p" } }, 500);
  for (let i = 0; i < 10_000; i++) b = backlogAdmit(b, { run: 1, event: { _tag: "Progress", key, name: "p", seconds: i } }, 500);
  assert.equal(b.filter((e) => e.event._tag === "Progress").length, 1);
  assert.deepEqual(b.at(-1)?.event, { _tag: "Progress", key, name: "p", seconds: 9_999 });
});

test("5,000 short lifecycles admitted without a take never exceed the bound", () => {
  let b: OutputBacklog = EMPTY_BACKLOG;
  for (let i = 0; i < 5_000; i++) {
    const key = keyOf(`k${i}`);
    for (const event of [
      { _tag: "Started", key, name: "k" },
      { _tag: "Printed", key, name: "k", text: "x\n" },
      { _tag: "Finished", key, name: "k", status: { _tag: "Succeeded" } },
    ] satisfies OutputEvent[]) b = backlogAdmit(b, { run: 1, event }, 50);
    assert.ok(b.length <= 50);
  }
});

test("a Started already taken keeps its Finished through a stalled delivery", () => {
  const key = keyOf("held");
  const [handed, rest] = backlogTake(backlogAdmit(EMPTY_BACKLOG, { run: 1, event: { _tag: "Started", key, name: "held" } }, 20));
  assert.equal(handed.length, 1);
  let b = backlogAdmit(rest, { run: 1, event: { _tag: "Finished", key, name: "held", status: { _tag: "Exited", code: 1 } } }, 20);
  for (let i = 0; i < 1_000; i++) {
    const k = keyOf(`o${i}`);
    b = backlogAdmit(b, { run: 1, event: { _tag: "Started", key: k, name: "o" } }, 20);
    b = backlogAdmit(b, { run: 1, event: { _tag: "Printed", key: k, name: "o", text: "y" } }, 20);
    b = backlogAdmit(b, { run: 1, event: { _tag: "Finished", key: k, name: "o", status: { _tag: "Succeeded" } } }, 20);
  }
  assert.ok(b.some((e) => e.event._tag === "Finished" && e.event.key === key));
  assert.ok(b.length <= 21);
});

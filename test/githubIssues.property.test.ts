import { test } from "node:test";
import fc from "fast-check";
import { Option, Result } from "effect";
import { nextPage, relabeled, stateOf } from "../src/githubIssues.ts";
import { ITEM_STATES } from "../src/tracker.ts";
import { LABELS } from "./githubLabels.ts";

// Issue #120, part 1 (issue #66): the seam between setting a state and reading it, and the Link header.
const RUNS = { numRuns: 200, seed: 20261008 };
const stageLabels = Object.values(LABELS);
const arbLabels = fc.array(fc.oneof(fc.constantFrom(...stageLabels), fc.string({ maxLength: 6 })), { maxLength: 6 });
const arbState = fc.constantFrom(...ITEM_STATES);

test("an open issue relabeled to a state reads as that state", () => {
  fc.assert(fc.property(arbLabels, arbState, (labels, state) => {
    const read = stateOf(LABELS, { open: true, labelNames: relabeled(labels, LABELS, state) });
    return Result.isSuccess(read) && read.success === state;
  }), RUNS);
});

test("relabeled keeps every label that is not a stage label, in order", () => {
  fc.assert(fc.property(arbLabels, arbState, (labels, state) => {
    const kept = relabeled(labels, LABELS, state).filter((l) => !stageLabels.includes(l));
    return JSON.stringify(kept) === JSON.stringify(labels.filter((l) => !stageLabels.includes(l)));
  }), RUNS);
});

test("nextPage finds the next URL wherever it stands among the relations", () => {
  const url = fc.webUrl().filter((u) => !/[<>,;]/u.test(u));
  const rel = fc.constantFrom("prev", "first", "last");
  fc.assert(fc.property(fc.array(fc.tuple(url, rel), { maxLength: 3 }), url, fc.nat(3), (others, next, at) => {
    const parts = others.map(([u, r]) => `<${u}>; rel="${r}"`);
    const header = [...parts.slice(0, at), `<${next}>; rel="next"`, ...parts.slice(at)].join(", ");
    const found = nextPage(header);
    return Option.isSome(found) && found.value === next;
  }), RUNS);
});

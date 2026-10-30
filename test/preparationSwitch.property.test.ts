// Issue #131: the preparation's switch, its durable failures and releases, and what the page is shown.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Schema } from "effect";
import {
  failureCounts,
  isReleased,
  PREPARATION_KEPT_OFF,
  type PreparationKept,
  PreparationKeptSchema,
  PreparationStatusSchema,
  PreparationViewSchema,
  preparingItemOf,
  switched,
  withFailure,
  withoutFailure,
  withoutRelease,
  withRelease,
} from "../src/preparationSwitch.ts";

const RUNS = { numRuns: 200 };
const item = fc.constantFrom("1", "2", "3");
const failure = fc.record({ item, digest: fc.constantFrom("a", "b"), generation: fc.nat(5), reason: fc.string() }, { noNullPrototype: true });
const release = fc.record({ item, key: fc.constantFrom("k1", "k2") }, { noNullPrototype: true });
const kept: fc.Arbitrary<PreparationKept> = fc.record(
  { settings: fc.record({ enabled: fc.boolean(), generation: fc.nat(20) }, { noNullPrototype: true }), failures: fc.uniqueArray(failure, { selector: (f) => f.item }), released: fc.uniqueArray(release, { selector: (r) => r.item }) },
  { noNullPrototype: true },
);
const status = fc.oneof(
  fc.constant({ _tag: "Off" as const }),
  fc.constant({ _tag: "Idle" as const }),
  fc.record({ _tag: fc.constant("Preparing" as const), item, title: fc.string() }, { noNullPrototype: true }),
  fc.record({ _tag: fc.constant("Unavailable" as const), notice: fc.string() }, { noNullPrototype: true }),
);

test("switched sets enabled to exactly the value given, and states every case", () => {
  fc.assert(fc.property(kept, fc.boolean(), (k, enabled) => {
    const next = switched(k, enabled);
    assert.equal(next.settings.enabled, enabled);
    if (enabled && !k.settings.enabled) {
      assert.equal(next.settings.generation, k.settings.generation + 1);
      assert.deepEqual([next.failures, next.released], [[], []]);
    } else if (!enabled && k.settings.enabled) {
      assert.deepEqual({ ...next, settings: { ...next.settings, enabled: true } }, k);
    } else assert.deepEqual(next, k);
  }), RUNS);
});

test("the switch is off by default, generation 0, with no failure and no release", () => {
  assert.deepEqual(PREPARATION_KEPT_OFF, { settings: { enabled: false, generation: 0 }, failures: [], released: [] });
});

test("a failure counts only for its own digest and generation", () => {
  fc.assert(fc.property(failure, fc.constantFrom("a", "b"), fc.nat(5), (f, digest, generation) => {
    assert.equal(failureCounts(f, digest, generation), f.digest === digest && f.generation === generation);
  }), RUNS);
});

test("withFailure and withRelease keep one entry per item, the newest; the withouts remove it", () => {
  fc.assert(fc.property(kept, failure, release, (k, f, r) => {
    const failed = withFailure(k, f);
    assert.deepEqual(failed.failures.filter((x) => x.item === f.item), [f]);
    assert.equal(withoutFailure(failed, f.item).failures.some((x) => x.item === f.item), false);
    const released = withRelease(k, r);
    assert.deepEqual(released.released.filter((x) => x.item === r.item), [r]);
    assert.equal(isReleased(released, r.item, r.key), true);
    assert.equal(isReleased(withoutRelease(released, r.item), r.item, r.key), false);
  }), RUNS);
});

test("preparingItemOf is the item exactly of Preparing", () => {
  fc.assert(fc.property(status, (s) => assert.equal(preparingItemOf(s), s._tag === "Preparing" ? s.item : null)), RUNS);
});

test("the schemas decode what they encode", () => {
  fc.assert(fc.property(kept, status, (k, s) => {
    assert.deepEqual(Schema.decodeUnknownSync(PreparationKeptSchema)(Schema.encodeSync(PreparationKeptSchema)(k)), k);
    assert.deepEqual(Schema.decodeUnknownSync(PreparationStatusSchema)(Schema.encodeSync(PreparationStatusSchema)(s)), s);
    const view = { settings: k.settings, status: s };
    assert.deepEqual(Schema.decodeUnknownSync(PreparationViewSchema)(Schema.encodeSync(PreparationViewSchema)(view)), view);
  }), RUNS);
});

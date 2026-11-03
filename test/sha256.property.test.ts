import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import fc from "fast-check";
import { sha256Hex } from "../src/sha256.ts";

const RUNS = { numRuns: 300, seed: 20261103 };
const reference = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

test("the known vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("agrees with node:crypto over grapheme strings, across block boundaries", () => {
  fc.assert(fc.property(fc.string({ unit: "grapheme", maxLength: 300 }), (s) => {
    assert.equal(sha256Hex(s), reference(s));
  }), RUNS);
});

test("agrees with node:crypto over binary strings, lone surrogates included", () => {
  fc.assert(fc.property(fc.string({ unit: "binary", maxLength: 300 }), (s) => {
    assert.equal(sha256Hex(s), reference(s));
  }), RUNS);
});

test("agrees at every length from 0 to 130 bytes", () => {
  for (let n = 0; n <= 130; n++) {
    const s = "x".repeat(n);
    assert.equal(sha256Hex(s), reference(s), `length ${n}`);
  }
});

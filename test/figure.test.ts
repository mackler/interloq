import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Result } from "effect";
import { FIGURE_SVG_LIMIT_BYTES, figureFileOf, figureOf, figureProblems } from "../src/figure.ts";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="5" height="5"/></svg>';
const kinds = (svg: string, alt = "A square") => figureProblems({ svg, alt }).map((p) => p.kind);
/** Markup of exactly n UTF-8 bytes, padded inside a comment with a three-byte character and ASCII. */
const ofBytes = (n: number): string => {
  const open = "<svg>";
  const close = "</svg>";
  const room = n - open.length - close.length;
  const wide = Math.floor(room / 3);
  return open + "€".repeat(wide) + "x".repeat(room - wide * 3) + close;
};

test("a blank alt text is altBlank", () => {
  assert.deepEqual(kinds(SVG, " \n\t"), ["altBlank"]);
});

test("the limit is counted in UTF-8 bytes, not characters", () => {
  assert.equal(new TextEncoder().encode(ofBytes(FIGURE_SVG_LIMIT_BYTES)).length, FIGURE_SVG_LIMIT_BYTES);
  assert.ok(ofBytes(FIGURE_SVG_LIMIT_BYTES).length < FIGURE_SVG_LIMIT_BYTES);
  assert.deepEqual(kinds(ofBytes(FIGURE_SVG_LIMIT_BYTES)), []);
  assert.deepEqual(figureProblems({ svg: ofBytes(FIGURE_SVG_LIMIT_BYTES + 1), alt: "a" }), [{ kind: "tooLarge", bytes: FIGURE_SVG_LIMIT_BYTES + 1 }]);
});

test("markup whose root is not svg is notSvg", () => {
  assert.deepEqual(kinds("<div></div>"), ["notSvg"]);
  assert.deepEqual(kinds("<svgx></svgx>"), ["notSvg"]);
  assert.deepEqual(kinds("<svg><rect/>"), ["notSvg"]);
  assert.deepEqual(kinds("<svg></svg><script/>"), ["notSvg"]);
  assert.deepEqual(kinds(""), ["notSvg"]);
});

test("an XML declaration and surrounding whitespace are allowed", () => {
  assert.deepEqual(kinds(`\n<?xml version="1.0" encoding="UTF-8"?>\n${SVG}\n`), []);
  assert.deepEqual(kinds("<svg\n viewBox='0 0 1 1'>\n</svg>"), []);
});

test("a valid figure is built, and several problems are all reported", () => {
  assert.ok(Result.isSuccess(figureOf({ svg: SVG, alt: "A square" })));
  const failed = figureOf({ svg: "<div/>", alt: "" });
  assert.ok(Result.isFailure(failed));
  assert.deepEqual(failed.failure.map((p) => p.kind).sort(), ["altBlank", "notSvg"]);
});

test("the figure's file is figures/<sha256 of its markup>.svg", () => {
  assert.equal(figureFileOf({ svg: SVG, alt: "x" }), `figures/${createHash("sha256").update(SVG, "utf8").digest("hex")}.svg`);
});

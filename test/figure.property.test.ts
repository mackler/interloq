import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { Result, Schema } from "effect";
import { FigureSchema, figureOf, figureProblems } from "../src/figure.ts";

const RUNS = { numRuns: 300, seed: 20261103 };
const arbSvg = fc.oneof(
  fc.string(),
  fc.string().map((inner) => `<svg viewBox="0 0 1 1">${inner}</svg>`),
  fc.tuple(fc.constantFrom("", " ", "\n", '<?xml version="1.0"?>'), fc.constantFrom("<svg>", "<svg ", "<svgx>", "<div>"), fc.string(), fc.constantFrom("</svg>", "</svg>\n", "</div>", "")).map((p) => p.join("")),
);
const arbAlt = fc.oneof(fc.string(), fc.constantFrom("", " ", "\t\n"));

test("figureOf succeeds exactly when figureProblems is empty, and the schema agrees", () => {
  fc.assert(fc.property(arbSvg, arbAlt, (svg, alt) => {
    const reply = { svg, alt };
    const ok = figureProblems(reply).length === 0;
    assert.equal(Result.isSuccess(figureOf(reply)), ok);
    assert.equal(Result.isSuccess(Schema.decodeUnknownResult(FigureSchema)(reply)), ok);
  }), RUNS);
});

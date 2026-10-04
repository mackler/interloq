// S2 of the task of issue #36: the pure functions over a question's pieces and blocks. Nothing in them reads Markdown.
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { blockPieces, blocksMarkdown, blocksText, codePiece, literalsOf, normalizedLevels, normalizedRuns, piecesMarkdown, piecesText, plainBlocks, plainOption, plainPieces, refsOf, sameBlocks, samePieces, type ShownBlock } from "../src/pieces.ts";
import type { Block, Piece } from "../src/schema.ts";
import { readBack } from "./helpers.ts";

const plain = (text: string): Piece => ({ text, ref: "", code: false });
const ref = (text: string, id: string): Piece => ({ text, ref: id, code: false });

test("the program's own words become plain pieces and paragraphs; the empty text none", () => {
  assert.deepEqual(plainPieces("Which?"), [plain("Which?")]);
  assert.deepEqual(plainPieces(""), []);
  assert.deepEqual(plainBlocks("One.", " ", "Two."), [{ kind: "paragraph", pieces: [plain("One.")] }, { kind: "paragraph", pieces: [plain("Two.")] }]);
  assert.deepEqual(plainOption("A", "a"), { label: [plain("A")], description: [plain("a")] });
  assert.deepEqual(codePiece("ls"), { text: "ls", ref: "", code: true });
});

test("the words of pieces and blocks, and the pieces and refs of blocks", () => {
  const blocks: readonly ShownBlock[] = [
    { kind: "paragraph", pieces: [plain("Use "), ref("zod", "z"), plain(".")] },
    { kind: "list", items: [{ level: 0, pieces: [plain("first")] }, { level: 1, pieces: [codePiece("npm i")] }] },
    { kind: "code", text: "a\nb" },
    { kind: "document", markdown: "# M" },
  ];
  assert.equal(piecesText([plain("Use "), ref("zod", "z"), plain(".")]), "Use zod.");
  assert.deepEqual(blocksText(blocks), ["Use zod.", "first", "npm i", "a\nb", "# M"]);
  assert.deepEqual(blockPieces(blocks).map((p) => p.text), ["Use ", "zod", ".", "first", "npm i"]);
  assert.deepEqual(refsOf(blockPieces(blocks)), ["z"]);
  assert.deepEqual(literalsOf(blocks), ["npm i", "a\nb"]);
});

test("Markdown for the records and the terminal: paragraphs, nested lists, a code span and a fenced block, exactly", () => {
  const blocks: readonly ShownBlock[] = [
    { kind: "paragraph", pieces: [plain("Use "), ref("zod", "z"), plain(" with "), codePiece("a`b")] },
    { kind: "list", items: [{ level: 0, pieces: [plain("one")] }, { level: 1, pieces: [plain("two")] }] },
    { kind: "code", text: "x\n```\ny" },
    { kind: "document", markdown: "\n# M\n" },
  ];
  assert.equal(blocksMarkdown(blocks), "Use zod with ``a`b``\n\n- one\n  - two\n\n````\nx\n```\ny\n````\n\n# M");
  // A code piece is shown exactly: the program escapes a value before it becomes a piece (S48), so nothing is doubled.
  assert.equal(piecesMarkdown([codePiece("a\\rb")]), "`a\\rb`");
  assert.equal(piecesMarkdown([codePiece("")]), "(empty text)");
});

test("sameBlocks and samePieces compare kinds, list levels and words, however the pieces are divided", () => {
  const a: readonly Block[] = [{ kind: "paragraph", pieces: [plain("Use zod.")] }];
  const b: readonly Block[] = [{ kind: "paragraph", pieces: [plain("Use "), ref("zod", "z"), plain(".")] }];
  assert.ok(sameBlocks(a, b));
  assert.ok(samePieces(a[0].kind === "paragraph" ? a[0].pieces : [], [plain("Use"), plain(" zod.")]));
  assert.ok(!sameBlocks(a, [{ kind: "paragraph", pieces: [plain("Use zod!")] }]));
  assert.ok(!sameBlocks(a, [{ kind: "list", items: [{ level: 0, pieces: [plain("Use zod.")] }] }]), "a paragraph is not a list item");
  assert.ok(!sameBlocks([{ kind: "list", items: [{ level: 0, pieces: [plain("x")] }] }], [{ kind: "list", items: [{ level: 1, pieces: [plain("x")] }] }]), "another level");
  assert.ok(!sameBlocks(a, [...a, ...a]));
});

// ---- properties (issue #66) ----------------------------------------------------------------------------------------

/** A text and an arbitrary division of it into pieces, some referring to an explanation, some code. */
const divided = fc.tuple(fc.string({ maxLength: 30 }), fc.array(fc.nat(30), { maxLength: 6 }), fc.array(fc.constantFrom("", "a", "b"), { maxLength: 7 }), fc.array(fc.boolean(), { maxLength: 7 })).map(([text, cuts, refs, codes]) => {
  const at = [...new Set([0, ...cuts.map((c) => Math.min(c, text.length)), text.length])].sort((x, y) => x - y);
  const pieces = at.slice(0, -1).map((a, i): Piece => ({ text: text.slice(a, at[i + 1]), ref: refs[i] ?? "", code: codes[i] ?? false }));
  return { text, pieces };
});
const arbBlock: fc.Arbitrary<Block> = fc.oneof(
  divided.map(({ pieces }) => ({ kind: "paragraph" as const, pieces })),
  fc.array(fc.record({ level: fc.integer(), pieces: divided.map((d) => d.pieces) }), { maxLength: 3 }).map((items) => ({ kind: "list" as const, items })),
  fc.string({ maxLength: 10 }).map((text) => ({ kind: "code" as const, text })),
);
/** The same blocks with every piece divided again at its middle. */
const redivide = (blocks: readonly Block[]): readonly Block[] => {
  const split = (ps: readonly Piece[]): readonly Piece[] => ps.flatMap((p) => (p.text.length < 2 ? [p] : [{ ...p, text: p.text.slice(0, 1) }, { ...p, text: p.text.slice(1) }]));
  return blocks.map((b) => (b.kind === "paragraph" ? { ...b, pieces: split(b.pieces) } : b.kind === "list" ? { ...b, items: b.items.map((i) => ({ ...i, pieces: split(i.pieces) })) } : b));
};

test("property: dividing a text into pieces keeps its words", () => {
  fc.assert(fc.property(divided, ({ text, pieces }) => piecesText(pieces) === text), { numRuns: 300 });
});

test("property: sameBlocks is reflexive and symmetric, and holds after any re-division", () => {
  fc.assert(
    fc.property(fc.array(arbBlock, { maxLength: 4 }), fc.array(arbBlock, { maxLength: 4 }), (a, b) => sameBlocks(a, a) && sameBlocks(a, b) === sameBlocks(b, a) && sameBlocks(a, redivide(a))),
    { numRuns: 300 },
  );
});

test("property: sameBlocks fails after any change of one character of the words", () => {
  const changed = (blocks: readonly Block[]): readonly Block[] | null => {
    const at = blocks.findIndex((b) => b.kind === "code" || blocksText([b]).join("") !== "");
    if (at < 0) return null;
    const b = blocks[at];
    const next: Block =
      b.kind === "code" ? { ...b, text: `${b.text}x` } : b.kind === "paragraph" ? { ...b, pieces: [...b.pieces.slice(0, -1), ...b.pieces.slice(-1).map((p) => ({ ...p, text: `${p.text}x` }))] } : { ...b, items: [{ level: 0, pieces: [plain("x")] }, ...b.items].slice(0, b.items.length + 1) };
    return blocks.map((x, i) => (i === at ? next : x));
  };
  fc.assert(
    fc.property(fc.array(arbBlock, { minLength: 1, maxLength: 4 }), (a) => {
      const b = changed(a);
      return b === null || !sameBlocks(a, b);
    }),
    { numRuns: 300 },
  );
});

test("property: literalsOf is unchanged by re-dividing the plain pieces, and every function is total", () => {
  fc.assert(
    fc.property(fc.array(arbBlock, { maxLength: 4 }), (a) => {
      const plainOnly = (blocks: readonly Block[]): readonly Block[] =>
        blocks.map((b) => {
          const split = (ps: readonly Piece[]) => ps.flatMap((p) => (p.code || p.text.length < 2 ? [p] : [{ ...p, text: p.text.slice(0, 1) }, { ...p, text: p.text.slice(1) }]));
          return b.kind === "paragraph" ? { ...b, pieces: split(b.pieces) } : b.kind === "list" ? { ...b, items: b.items.map((i) => ({ ...i, pieces: split(i.pieces) })) } : b;
        });
      blocksMarkdown(a);
      blocksText(a);
      refsOf(blockPieces(a));
      return JSON.stringify(literalsOf(a)) === JSON.stringify(literalsOf(plainOnly(a)));
    }),
    { numRuns: 300 },
  );
});

// W1-R1-3 (S24): a list's levels are normalized before rendering, so an unbounded level never throws.
test("normalizedLevels: at least 0, at most one more than the previous item's, the first 0", () => {
  const items = (levels: readonly number[]) => levels.map((level) => ({ level, pieces: [plain("x")] }));
  assert.deepEqual(normalizedLevels(items([2147483647, -5])).map((i) => i.level), [0, 0]);
  assert.deepEqual(normalizedLevels(items([0, 2147483647])).map((i) => i.level), [0, 1]);
  assert.deepEqual(normalizedLevels(items([0, 1, 3, 1, 2])).map((i) => i.level), [0, 1, 2, 1, 2]);
  for (const levels of [[2147483647, -5], [0, 2147483647]]) assert.doesNotThrow(() => blocksMarkdown([{ kind: "list", items: items(levels) }]));
});

test("property: any list levels render, indented no deeper than the items, and normalizing is idempotent", () => {
  fc.assert(
    fc.property(fc.array(fc.integer(), { maxLength: 8 }), (levels) => {
      const items = levels.map((level) => ({ level, pieces: [plain("x")] }));
      const once = normalizedLevels(items);
      const md = blocksMarkdown([{ kind: "list", items }]);
      const deepest = Math.max(0, ...md.split("\n").map((l) => l.length - l.trimStart().length));
      return JSON.stringify(normalizedLevels(once)) === JSON.stringify(once) && deepest <= 2 * items.length;
    }),
    { numRuns: 300 },
  );
});

// W2-R1-1, P3-R1-1 (S26): the properties of S24 hold over a run of lists interrupted by code blocks and paragraphs:
// normalizing twice equals normalizing once, nothing is nested deeper than its items, and every item and every
// interrupting block keeps its order and its text.
test("property: normalizedRuns is idempotent, keeps every block in order and nests no deeper than its items", () => {
  const piece = fc.string({ maxLength: 4 }).map((text) => ({ text, ref: "", code: false }));
  const block = fc.oneof(
    fc.array(fc.record({ level: fc.integer(), pieces: fc.array(piece, { maxLength: 2 }) }), { maxLength: 4 }).map((items): ShownBlock => ({ kind: "list", items })),
    fc.string({ maxLength: 6 }).map((text): ShownBlock => ({ kind: "code", text })),
    fc.array(piece, { maxLength: 2 }).map((pieces): ShownBlock => ({ kind: "paragraph", pieces })),
    fc.string({ maxLength: 6 }).map((markdown): ShownBlock => ({ kind: "document", markdown })),
  );
  fc.assert(
    fc.property(fc.array(block, { maxLength: 8 }), (blocks) => {
      const laid = normalizedRuns(blocks);
      // Flattened back to blocks, in order, and laid out again: the same layout.
      const flat = laid.flatMap((b): readonly ShownBlock[] =>
        b.kind === "list" ? [{ kind: "list", items: [] }, ...b.items.flatMap((i): readonly ShownBlock[] => [{ kind: "list", items: [{ level: i.level, pieces: i.pieces }] }, ...i.attached, ...(i.attached.length > 0 ? [{ kind: "list" as const, items: [] }] : [])])] : [b],
      );
      const words = (bs: readonly ShownBlock[]) => blocksText(bs).filter((t) => t !== "");
      const items = blocks.flatMap((b) => (b.kind === "list" ? b.items : []));
      const levels = laid.flatMap((b) => (b.kind === "list" ? b.items.map((i) => i.level) : []));
      return (
        JSON.stringify(words(flat)) === JSON.stringify(words(blocks)) &&
        JSON.stringify(normalizedRuns(laid.flatMap((b): readonly ShownBlock[] => (b.kind === "list" ? [{ kind: "list", items: b.items.map((i) => ({ level: i.level, pieces: i.pieces })) }] : [b])))
          .flatMap((b) => (b.kind === "list" ? b.items.map((i) => i.level) : []))) === JSON.stringify(levels) &&
        levels.every((l) => l >= 0 && l < Math.max(1, items.length)) &&
        (() => {
          blocksMarkdown(blocks);
          return true;
        })()
      );
    }),
    { numRuns: 300 },
  );
});

// W7-R1-1 (S36): a code piece of spaces alone is written between single backticks, unpadded, so that it renders exactly.
test("piecesMarkdown writes a code piece of spaces alone without padding", () => {
  assert.equal(piecesMarkdown([codePiece(" ")]), "` `");
  assert.equal(piecesMarkdown([codePiece("   ")]), "`   `");
  assert.equal(piecesMarkdown([codePiece(" a ")]), "`  a  `", "padding stays where the content is not all spaces");
});

// S37 (the developer's decision of 4 Oct 2026): a plain piece carries emphasis and links only, never code. piecesMarkdown
// escapes every backtick of a plain piece and doubles its trailing backslash, so that nothing in a plain piece can pair
// with anything outside it. The tests read the Markdown back with marked (a devDependency of the page); the program
// itself reads no Markdown.
test("a plain piece ending in a backtick does not merge with the code piece after it", () => {
  const back = readBack(piecesMarkdown([plain("see `"), codePiece("ls"), plain(" now")]));
  assert.deepEqual(back.code, ["ls"]);
  assert.equal(back.rest, "see ` now");
});

test("a plain piece ending in a backslash does not escape the code span after it", () => {
  const back = readBack(piecesMarkdown([plain("path C:\\"), codePiece("dir"), plain(" here")]));
  assert.deepEqual(back.code, ["dir"]);
  assert.equal(back.rest, "path C:\\ here");
});

test("an unclosed backtick run in a plain piece does not close against a run inside a code piece", () => {
  const back = readBack(piecesMarkdown([plain("one `` two "), codePiece("a``b"), plain(" three")]));
  assert.deepEqual(back.code, ["a``b"]);
  assert.equal(back.rest, "one `` two  three");
});

test("property: the code read back is exactly the code pieces, whatever the plain pieces hold", () => {
  const plainText = fc.string({ unit: fc.constantFrom("`", "`", "\\", "\\", "a", "b", " "), maxLength: 12 });
  const codeText = fc.string({ unit: fc.constantFrom("`", "\\", "a", " ", "x"), minLength: 1, maxLength: 8 });
  fc.assert(
    fc.property(plainText, plainText, plainText, codeText, codeText, (p1, p2, p3, c1, c2) => {
      const back = readBack(piecesMarkdown([plain(p1), codePiece(c1), plain(` and ${p2} or `), codePiece(c2), plain(p3)]));
      return JSON.stringify(back.code) === JSON.stringify([c1, c2]);
    }),
    { numRuns: 200 },
  );
});

test("property: a plain piece of words and backticks reads back as its own text, nothing in code", () => {
  fc.assert(
    fc.property(fc.string({ unit: fc.constantFrom("`", "`", "a", "b", " "), maxLength: 16 }), (text) => {
      const back = readBack(piecesMarkdown([plain(text)]));
      return back.code.length === 0 && back.rest === text;
    }),
    { numRuns: 200 },
  );
});

test("a plain piece keeps its emphasis and links; an escaped backtick stays one backtick; an empty code piece stays a phrase", () => {
  assert.equal(piecesMarkdown([plain("*a* and [x](https://example.com)")]), "*a* and [x](https://example.com)");
  const escaped = readBack(piecesMarkdown([plain("a \\` b")]));
  assert.deepEqual(escaped, { code: [], rest: "a ` b" });
  assert.ok(piecesMarkdown([plain("a `"), codePiece(""), plain("b")]).endsWith("(empty text)b"));
});

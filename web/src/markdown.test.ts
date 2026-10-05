import { describe, expect, test } from "vitest";
import DOMPurify from "dompurify";
import fc from "fast-check";
import { makeRenderer, render } from "./markdown.ts";

// Plan step 4.4: the agents' Markdown is rendered and sanitised.
describe("render", () => {
  test("headings, lists and code render", () => {
    const html = render("# Title\n\n- one\n- two\n\n`code`");
    expect(html).toMatch(/<h1[^>]*>Title<\/h1>/);
    expect(html).toMatch(/<li>one<\/li>/);
    expect(html).toMatch(/<code>code<\/code>/);
  });

  test("a script tag, an onerror attribute and a javascript: link are removed", () => {
    const html = render('<script>alert(1)</script>\n\n<img src="x" onerror="alert(2)">\n\n[x](javascript:alert(3))');
    expect(html).not.toMatch(/<script/);
    expect(html).not.toMatch(/onerror/);
    expect(html).not.toMatch(/javascript:/);
  });

  test("links open without access to the page", () => {
    expect(render("[site](https://example.com)")).toMatch(/<a href="https:\/\/example.com"[^>]*rel="noopener noreferrer"/);
  });
});

// Finding 14 of docs/gui-review.md: the link hook belongs to a private instance, not to the imported singleton.
describe("makeRenderer", () => {
  test("its links open without access to the page, and the global DOMPurify is left unconfigured", () => {
    const own = makeRenderer(window);
    expect(own("[site](https://example.com)")).toMatch(/target="_blank"/);
    expect(DOMPurify.sanitize('<a href="https://example.com">x</a>', { ADD_ATTR: ["target"] })).not.toMatch(/target=|rel=/);
  });

  test("two renderers are independent instances", () => {
    const a = makeRenderer(window);
    const b = makeRenderer(window);
    expect(a).not.toBe(b);
    expect(b("[x](https://example.com)")).toMatch(/rel="noopener noreferrer"/);
  });
});

// S33 (W5-R1-1, P6-R1-2): after the validation, each code piece is one code element of exactly its text. The generator
// is confined to adjacency: plain pieces without any Markdown or HTML character, code pieces of letters and digits.
describe("code pieces rendered from piecesMarkdown", () => {
  test("property: one code element per code piece, in order, each with exactly its text", async () => {
    const fc = (await import("fast-check")).default;
    const { piecesMarkdown } = await import("../../src/pieces.ts");
    const { questionProblems } = await import("../../src/question.ts");
    const plainPiece = fc.stringMatching(/^[a-z0-9 ,.]{0,6}$/).map((text) => ({ text, ref: "", code: false }));
    const codePiece = fc.stringMatching(/^[a-z0-9]{1,6}$/).map((text) => ({ text, ref: "", code: true }));
    fc.assert(
      fc.property(fc.array(fc.oneof(plainPiece, codePiece), { minLength: 1, maxLength: 6 }), (pieces) => {
        const q = { context: [{ kind: "paragraph" as const, pieces: [{ text: "c", ref: "", code: false }] }], question: [{ text: "Q?", ref: "", code: false }], explanations: [], options: [{ label: pieces, description: [] }] };
        if (questionProblems(q).length > 0) return true;
        const el = document.createElement("div");
        el.innerHTML = render(piecesMarkdown(pieces));
        return JSON.stringify([...el.querySelectorAll("code")].map((c) => c.textContent)) === JSON.stringify(pieces.filter((p) => p.code).map((p) => p.text));
      }),
      { numRuns: 300 },
    );
  });
  test("an empty code piece renders its phrase and no code element", async () => {
    const { piecesMarkdown } = await import("../../src/pieces.ts");
    const el = document.createElement("div");
    el.innerHTML = render(piecesMarkdown([{ text: "", ref: "", code: true }]));
    expect(el.querySelector("code")).toBe(null);
    expect(el.textContent).toContain("(empty text)");
  });
});

// W7-R1-1 (S36): a code piece made only of spaces renders as exactly its text.
describe("a code piece of spaces alone", () => {
  test("one space renders as one code element of one space", async () => {
    const { piecesMarkdown } = await import("../../src/pieces.ts");
    const el = document.createElement("div");
    el.innerHTML = render(piecesMarkdown([{ text: " ", ref: "", code: true }]));
    expect([...el.querySelectorAll("code")].map((c) => c.textContent)).toEqual([" "]);
  });
  test("property: any run of spaces, alone or beside the adjacency cases, renders as exactly its text", async () => {
    const fc = (await import("fast-check")).default;
    const { piecesMarkdown } = await import("../../src/pieces.ts");
    const { questionProblems } = await import("../../src/question.ts");
    const plainPiece = fc.stringMatching(/^[a-z0-9 ,.]{0,6}$/).map((text) => ({ text, ref: "", code: false }));
    const codePiece = fc.oneof(fc.stringMatching(/^[a-z0-9]{1,6}$/), fc.stringMatching(/^ {1,5}$/)).map((text) => ({ text, ref: "", code: true }));
    fc.assert(
      fc.property(fc.array(fc.oneof(plainPiece, codePiece), { minLength: 1, maxLength: 6 }), (pieces) => {
        const q = { context: [{ kind: "paragraph" as const, pieces: [{ text: "c", ref: "", code: false }] }], question: [{ text: "Q?", ref: "", code: false }], explanations: [], options: [{ label: pieces, description: [] }] };
        if (questionProblems(q).length > 0) return true;
        const el = document.createElement("div");
        el.innerHTML = render(piecesMarkdown(pieces));
        return JSON.stringify([...el.querySelectorAll("code")].map((c) => c.textContent)) === JSON.stringify(pieces.filter((p) => p.code).map((p) => p.text));
      }),
      { numRuns: 300 },
    );
  });
});

// Issue #94: a plain piece carries emphasis and links only (decided behaviour 2), so a sequence of plain pieces renders
// as text and opens no block. S37 escapes a backtick in a plain piece; nothing yet guards what opens a block at the
// start of a line, and piecesMarkdown joins the pieces of one sequence into one line. These are the seven cases found
// on 5 Oct 2026, four of which the property above cannot generate: its plain piece is drawn from [a-z0-9 ,.], which
// holds no tab, hyphen, number sign or greater-than sign. The joined sequence is what matters: two pieces of two
// spaces make four leading spaces between them.
describe("a plain piece opens no Markdown block (issue #94)", () => {
  const BLOCKS = "pre, code, h1, h2, h3, h4, h5, h6, ul, ol, li, blockquote";
  const cases: readonly (readonly string[])[] = [["    ", "a"], ["\t", "a"], ["  ", "  ", "a"], ["- x"], ["# h"], ["> q"], ["1. x"]];
  for (const texts of cases) {
    test(`${JSON.stringify(texts)} renders as its text alone`, async () => {
      const { piecesMarkdown } = await import("../../src/pieces.ts");
      const pieces = texts.map((text) => ({ text, ref: "", code: false }));
      const el = document.createElement("div");
      el.innerHTML = render(piecesMarkdown(pieces));
      expect([...el.querySelectorAll(BLOCKS)]).toEqual([]);
      // marked ends every block with a line break, which no fix can remove (issue #94, step S3).
      expect(el.textContent?.replace(/\n$/u, "")).toBe(texts.join(""));
    });
  }
});

// Issue #94: the property over the joined sequence, on its own and inside a list item through blocksMarkdown, and the
// rest of the class of block openers. The text is compared without the line break the renderer writes after its last block.
describe("a plain piece opens no Markdown block: the class (issue #94)", () => {
  const BLOCKS = "pre, code, h1, h2, h3, h4, h5, h6, ul, ol, li, blockquote, hr, table";
  const plainOf = (text: string) => ({ text, ref: "", code: false });
  const shown = (markdown: string): HTMLDivElement => {
    const el = document.createElement("div");
    el.innerHTML = render(markdown);
    return el;
  };
  const textOf = (el: Element): string => (el.textContent ?? "").replace(/\n$/u, "");
  const pieces = () => {
    const unit = fc.constantFrom(" ", "\t", "-", "+", "*", "#", ">", "~", "<", "0", "1", "9", ".", ")", "_", "=", "[", "]", ":", "a", "b");
    return { arb: fc.array(fc.string({ unit, maxLength: 4 }), { minLength: 1, maxLength: 5 }) };
  };
  /** The joined text is not whitespace alone, and forms no emphasis or inline HTML when read as inline Markdown alone. */
  const admissible = async (texts: readonly string[]): Promise<boolean> => {
    const { renderInline } = await import("./markdown.ts");
    const joined = texts.join("");
    const el = document.createElement("span");
    el.innerHTML = renderInline(joined);
    return joined.trim() !== "" && el.textContent === joined;
  };

  test("property: a sequence of plain pieces renders as exactly its text and holds no block", async () => {
    const { piecesMarkdown } = await import("../../src/pieces.ts");
    const { arb } = pieces();
    await fc.assert(
      fc.asyncProperty(arb, async (texts) => {
        fc.pre(await admissible(texts));
        const el = shown(piecesMarkdown(texts.map(plainOf)));
        expect([...el.querySelectorAll(BLOCKS)]).toEqual([]);
        expect(textOf(el)).toBe(texts.join(""));
      }),
      { numRuns: 300 },
    );
  });

  test("property: the same sequence inside a list item, as an item and as a paragraph interrupting the list", async () => {
    const { blocksMarkdown } = await import("../../src/pieces.ts");
    const { arb } = pieces();
    const item = (level: number, text: string) => ({ level, pieces: [plainOf(text)] });
    await fc.assert(
      fc.asyncProperty(arb, async (texts) => {
        fc.pre(await admissible(texts));
        const joined = texts.join("");
        const asItem = shown(blocksMarkdown([{ kind: "list", items: [item(0, "top"), { level: 1, pieces: texts.map(plainOf) }] }]));
        expect(asItem.querySelectorAll("ul").length).toBe(2);
        expect([...asItem.querySelectorAll("li")].map(textOf).at(-1)).toBe(joined);
        expect([...asItem.querySelectorAll("pre, code, h1, h2, h3, h4, h5, h6, ol, blockquote, hr, table")]).toEqual([]);
        const interrupting = shown(
          blocksMarkdown([
            { kind: "list", items: [item(0, "one"), item(1, "two")] },
            { kind: "paragraph", pieces: texts.map(plainOf) },
            { kind: "list", items: [item(1, "three")] },
          ]),
        );
        expect(interrupting.querySelectorAll("ul").length).toBe(2);
        expect(interrupting.querySelectorAll("li").length).toBe(3);
        expect([...interrupting.querySelectorAll("p")].map(textOf)).toContain(joined);
        expect([...interrupting.querySelectorAll("pre, code, h1, h2, h3, h4, h5, h6, ol, blockquote, hr, table")]).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  // W1-R1-1: a link reference definition's label may span line breaks (no blank line) and reach past the run into a code
  // piece; each case ends at its destination, since text after it would make the line a paragraph anyway.
  const labelCases: readonly (readonly { text: string; ref: string; code: boolean }[])[] = [
    [plainOf("[a\n]: b")],
    [plainOf("[a\nb]: c")],
    [plainOf("[a"), plainOf("\n]: b")],
    [plainOf("[a "), { text: "x", ref: "", code: true }, plainOf("]: b")],
  ];
  for (const ps of labelCases) {
    test(`a multi-line link label ${JSON.stringify(ps.map((p) => p.text))} renders as its text`, async () => {
      const { piecesMarkdown } = await import("../../src/pieces.ts");
      const el = shown(piecesMarkdown(ps));
      // A code piece is its one code element; nothing else is a block.
      expect([...el.querySelectorAll("code")].map((c) => c.textContent)).toEqual(ps.filter((p) => p.code).map((p) => p.text));
      expect([...el.querySelectorAll(BLOCKS.replace("code, ", ""))]).toEqual([]);
      expect(textOf(el)).toBe(ps.map((p) => p.text).join(""));
    });
  }
  for (const text of ["[a\n]: b", "[a\nb]: c"]) {
    test(`a multi-line link label ${JSON.stringify(text)} inside a list item renders as its text`, async () => {
      const { blocksMarkdown } = await import("../../src/pieces.ts");
      const el = shown(blocksMarkdown([{ kind: "list", items: [{ level: 0, pieces: [plainOf(text)] }] }]));
      expect([...el.querySelectorAll("li")].map(textOf)).toEqual([text]);
    });
  }
  /**
   * The oracle of work review 2: the joined input, its line endings normalized as block parsing normalizes them, rendered
   * as inline Markdown alone. A backslash before a line break is a hard break, inline Markdown a plain piece may carry, so
   * the block rendering must add or remove nothing beyond what this inline rendering does.
   */
  const inlineText = async (text: string): Promise<string> => {
    const { renderInline } = await import("./markdown.ts");
    const el = document.createElement("span");
    el.innerHTML = renderInline(text.replace(/\r\n?/gu, "\n"));
    return el.textContent ?? "";
  };
  const BLOCKS_BUT_CODE = "pre, code, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, hr, table";
  // Work review 2: a backslash right before a line break does not end a label, so the text is still a definition.
  for (const text of ["[a\\\nb]: c", "[a\\\r\nb]: c"]) {
    test(`a link label with a backslash before its line break ${JSON.stringify(text)} renders as its inline text`, async () => {
      const { piecesMarkdown } = await import("../../src/pieces.ts");
      const el = shown(piecesMarkdown([plainOf(text)]));
      expect([...el.querySelectorAll(BLOCKS)]).toEqual([]);
      expect(textOf(el)).toBe(await inlineText(text));
    });
  }
  test("a link label with a backslash before its line break inside a list item renders as its inline text", async () => {
    const { blocksMarkdown } = await import("../../src/pieces.ts");
    const text = "[a\\\nb]: c";
    const el = shown(blocksMarkdown([{ kind: "list", items: [{ level: 0, pieces: [plainOf(text)] }] }]));
    expect([...el.querySelectorAll(BLOCKS_BUT_CODE.replace("ul, ", ""))]).toEqual([]);
    expect([...el.querySelectorAll("li")].map(textOf)).toEqual([await inlineText(text)]);
  });
  // Separate from the property above: a line break in that generator would also make blank lines (two paragraphs) and
  // leading or trailing breaks (dropped by the renderer), neither a block a plain piece opens. Compared with the inline
  // oracle (work review 2), so a backslash means the same on both sides; no space beside a line break, since step S3 keeps
  // whitespace at a line's edge as references while inline parsing strips it or makes a hard break of it; and no cut right
  // after a backslash, since escapedPiece doubles a piece's trailing backslash (S37), which the oracle cannot model.
  test("property: a link reference definition whose label spans lines, divided into pieces anywhere, renders as its text", async () => {
    const { piecesMarkdown } = await import("../../src/pieces.ts");
    const label = fc
      .string({ unit: fc.constantFrom("a", "b", " ", "\n", "\\"), minLength: 1, maxLength: 8 })
      .filter((l) => l.trim() !== "" && !/\n[ \t]*\n/u.test(l) && !/[ \t]\n|\n[ \t]/u.test(l));
    const destination = fc.string({ unit: fc.constantFrom("a", "b", "c"), minLength: 1, maxLength: 4 });
    const cuts = fc.array(fc.nat(), { maxLength: 2 });
    await fc.assert(
      fc.asyncProperty(label, destination, cuts, async (l, d, at) => {
        const text = `[${l}]: ${d}`;
        const points = [...new Set(at.map((n) => n % (text.length + 1)))].filter((n) => text[n - 1] !== "\\").sort((x, y) => x - y);
        const texts = [0, ...points, text.length].slice(1).map((end, i, ends) => text.slice(i === 0 ? 0 : ends[i - 1], end)).filter((t) => t !== "");
        const el = shown(piecesMarkdown(texts.map(plainOf)));
        expect([...el.querySelectorAll(BLOCKS)]).toEqual([]);
        expect(textOf(el)).toBe(await inlineText(text));
      }),
      { numRuns: 200 },
    );
  });

  const cases: readonly (readonly string[])[] = [["***"], ["___"], ["---"], ["~~~"], ["<div>"], ["+ x"], ["2) x"], ["###### h"], ["a\n==="], ["[a]: b"]];
  for (const texts of cases) {
    test(`${JSON.stringify(texts)} renders as its text alone`, async () => {
      const { piecesMarkdown } = await import("../../src/pieces.ts");
      const el = shown(piecesMarkdown(texts.map(plainOf)));
      expect([...el.querySelectorAll(BLOCKS)]).toEqual([]);
      expect(textOf(el)).toBe(texts.join(""));
    });
  }
  test("four spaces before a word inside a list item render as text", async () => {
    const { blocksMarkdown } = await import("../../src/pieces.ts");
    const el = shown(blocksMarkdown([{ kind: "list", items: [{ level: 0, pieces: [plainOf("    a")] }] }]));
    expect([...el.querySelectorAll("pre, code")]).toEqual([]);
    expect([...el.querySelectorAll("li")].map(textOf)).toEqual(["    a"]);
  });
  test("emphasis and a link are kept; an autolink at the start of a line stays a link; four spaces alone render as nothing", async () => {
    const { piecesMarkdown } = await import("../../src/pieces.ts");
    const emphasis = shown(piecesMarkdown([plainOf("*a* and [x](https://example.com)")]));
    expect(emphasis.querySelector("em")?.textContent).toBe("a");
    expect(emphasis.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(shown(piecesMarkdown([plainOf("<https://example.com>")])).querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(textOf(shown(piecesMarkdown([plainOf("    ")])))).toBe("");
  });
  test("a backslash ending one piece stays a character before a number sign beginning the next", async () => {
    const { piecesMarkdown } = await import("../../src/pieces.ts");
    const el = shown(piecesMarkdown([plainOf("C:\\"), plainOf("# h")]));
    expect([...el.querySelectorAll(BLOCKS)]).toEqual([]);
    expect(textOf(el)).toBe("C:\\# h");
  });
  test("the spaces beside a code piece are written as spaces", async () => {
    const { piecesMarkdown } = await import("../../src/pieces.ts");
    expect(piecesMarkdown([plainOf("run "), { text: "ls", ref: "", code: true }, plainOf(" now")])).toBe("run `ls` now");
  });
});

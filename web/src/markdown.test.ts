import { describe, expect, test } from "vitest";
import DOMPurify from "dompurify";
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

// S13 of the task of issue #36: a question's pieces rendered directly. A piece that refers to an explanation is a
// focusable word that carries it (hover and keyboard, S42, S44); a plain piece is inline Markdown only, sanitized on its
// own; a code piece and a code block are their text exactly; no list of terms is rendered.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import fc from "fast-check";
import type { Explanation, Piece, ShownBlock } from "../../src/pieces.ts";
import QuestionText from "./components/QuestionText.svelte";
import { INLINE_TAGS, makeInlineRenderer } from "./markdown.ts";

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
});
const plain = (text: string): Piece => ({ text, ref: "", code: false });
const ref = (text: string, id: string): Piece => ({ text, ref: id, code: false });
const show = (props: { blocks?: readonly ShownBlock[]; pieces?: readonly Piece[]; explanations: readonly Explanation[] }) => {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(QuestionText, { target, props }));
  flushSync();
  return target;
};
const tooltip = () => document.querySelector<HTMLElement>("[role=tooltip]");
const focus = (el: HTMLElement) => {
  el.focus();
  el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  flushSync();
};
const hover = (el: HTMLElement) => {
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  flushSync();
};
const key = (el: Element, k: string, shift = false) => {
  const e = new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  flushSync();
  return e;
};
const sqlite: Explanation = { id: "s", term: "SQLite", explanation: "An engine that keeps a database in one file." };
const database: Explanation = { id: "d", term: "database", explanation: "Data kept for later use." };

describe("the pieces of a question", () => {
  test("each piece that refers to an explanation is a focusable word whose tooltip shows that explanation, not the term's name", () => {
    const root = show({ pieces: [ref("SQLite", "s"), plain(" keeps the "), ref("databases", "d"), plain(".")], explanations: [sqlite, database] });
    const words = [...root.querySelectorAll<HTMLElement>(".term")];
    expect(words.map((w) => [w.textContent, w.tabIndex])).toEqual([["SQLite", 0], ["databases", 0]]);
    hover(words[1]);
    expect(tooltip()?.textContent).toContain(database.explanation);
    expect(tooltip()?.textContent).not.toContain("database:");
    expect(words[1].getAttribute("aria-describedby")).toBe(tooltip()!.id);
  });

  test("two pieces with one ref, a plural and a capitalized first word, show the same explanation", () => {
    const root = show({ pieces: [ref("Execution calls", "e"), plain(" and one "), ref("execution call", "e"), plain(".")], explanations: [{ id: "e", term: "execution call", explanation: "The part in which the plan is carried out." }] });
    const [a, b] = root.querySelectorAll<HTMLElement>(".term");
    hover(a);
    const first = tooltip()?.textContent;
    hover(b);
    expect(tooltip()?.textContent).toBe(first);
    expect(first).toContain("The part in which the plan is carried out.");
  });

  test("a plain piece's emphasis and link are rendered and sanitized; a javascript: link is removed", () => {
    const root = show({ pieces: [plain("Use *this* and [that](https://example.org) and [bad](javascript:alert(1)).")], explanations: [] });
    expect(root.querySelector("em")?.textContent).toBe("this");
    expect(root.querySelector("a[href='https://example.org']")?.getAttribute("target")).toBe("_blank");
    expect(root.querySelector("a[href^='javascript']")).toBe(null);
  });

  test("a plain piece never opens a block: HTML blocks, lists, fences and headings leave only their text", () => {
    for (const text of ["<div>inside</div>", "<p>para</p>", "<ul><li>item</li></ul>", "<pre>pre</pre>", "<table><tr><td>cell</td></tr></table>", "# heading", "- item", "```\ncode\n```"]) {
      const root = show({ pieces: [plain(text)], explanations: [] });
      const tags = [...root.querySelectorAll("*")].map((e) => e.tagName.toLowerCase()).filter((t) => t !== "span");
      expect(tags.every((t) => INLINE_TAGS.includes(t)), `${text}: ${tags.join(",")}`).toBe(true);
      expect(root.textContent?.replace(/\s+/g, ""), text).toContain(text.replace(/<[^>]+>|[#`\-\s]/g, "").replace(/\s+/g, ""));
    }
  });

  test("an unclosed emphasis in one plain piece does not format the next piece", () => {
    const root = show({ pieces: [plain("a *start "), plain("next* end")], explanations: [] });
    expect(root.querySelector("em")).toBe(null);
    expect(root.firstElementChild?.textContent).toBe("a *start next* end");
  });

  test("a piece that refers to an explanation shows its words literally, and a code piece its text exactly", () => {
    const root = show({ pieces: [ref("**bold**", "s"), plain(" "), { text: "a  <b>`c`", ref: "", code: true }], explanations: [sqlite] });
    expect(root.querySelector(".term")?.textContent).toBe("**bold**");
    expect(root.querySelector("code")?.textContent).toBe("a  <b>`c`");
    expect(root.querySelector("strong")).toBe(null);
  });

  test("blocks: paragraphs, a list nested by level, a code block exactly, and the program's document as Markdown", () => {
    const root = show({
      blocks: [
        { kind: "paragraph", pieces: [plain("One.")] },
        { kind: "list", items: [{ level: 0, pieces: [plain("top")] }, { level: 1, pieces: [ref("inner", "s")] }, { level: 0, pieces: [plain("next")] }] },
        { kind: "code", text: "line 1\n  line 2" },
        { kind: "document", markdown: "## Title\n\n- a" },
      ],
      explanations: [sqlite],
    });
    expect(root.querySelector("p")?.textContent).toBe("One.");
    const own = (li: Element) => [...li.childNodes].filter((n) => !(n instanceof HTMLUListElement)).map((n) => n.textContent).join("");
    expect([...root.querySelectorAll(":scope > div > ul > li")].map(own)).toEqual(["top", "next"]);
    expect(root.querySelector("ul ul li .term")?.textContent).toBe("inner");
    expect(root.querySelector("pre code")?.textContent).toBe("line 1\n  line 2");
    expect(root.querySelector(".document h2")?.textContent).toBe("Title");
  });

  test("no list of terms is rendered: an explanation costs no space until it is asked for", () => {
    const root = show({ pieces: [ref("SQLite", "s")], explanations: [sqlite, database] });
    expect(root.firstElementChild?.textContent).toBe("SQLite");
    expect(root.querySelector("dl")).toBe(null);
  });
});

describe("the keyboard (S42)", () => {
  const long = "A long explanation. ".repeat(80);
  const withButton = () => {
    const root = show({ pieces: [ref("SQLite", "s"), plain(" keeps the "), ref("database", "d"), plain(".")], explanations: [{ ...sqlite, explanation: long }, database] });
    const after = document.createElement("button");
    after.textContent = "After";
    document.body.appendChild(after);
    return { root, after };
  };

  test("Tab from a word with its tooltip open enters the tooltip, which stays open", () => {
    const { root } = withButton();
    const [first] = root.querySelectorAll<HTMLElement>(".term");
    focus(first);
    const e = key(first, "Tab");
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(tooltip());
    expect(tooltip()!.textContent).toContain("A long explanation.");
  });

  test("the next Tab moves to the second word, and the first tooltip closes", () => {
    const { root } = withButton();
    const [first, second] = root.querySelectorAll<HTMLElement>(".term");
    focus(first);
    key(first, "Tab");
    const e = key(tooltip()!, "Tab");
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(second);
    expect(tooltip()?.textContent ?? "").not.toContain("A long explanation.");
  });

  for (const [name, k, shift] of [["Shift+Tab", "Tab", true], ["Escape", "Escape", false]] as const) {
    test(`${name} in the tooltip closes it and returns focus to the word`, () => {
      const { root } = withButton();
      const [first] = root.querySelectorAll<HTMLElement>(".term");
      focus(first);
      key(first, "Tab");
      key(tooltip()!, k, shift);
      expect(document.activeElement).toBe(first);
      expect(tooltip()).toBe(null);
    });
  }

  test("Tab from the last word's tooltip reaches the following button, not the tooltip itself", () => {
    const { root, after } = withButton();
    const words = root.querySelectorAll<HTMLElement>(".term");
    const last = words[words.length - 1];
    focus(last);
    key(last, "Tab");
    expect(document.activeElement).toBe(tooltip());
    key(tooltip()!, "Tab");
    expect(document.activeElement).toBe(after);
    expect(tooltip()).toBe(null);
  });

  test("the tooltip lives in the document's body, outside the text it explains (S44)", () => {
    const { root } = withButton();
    const [first] = root.querySelectorAll<HTMLElement>(".term");
    hover(first);
    expect(root.contains(tooltip())).toBe(false);
    expect(tooltip()?.parentElement).toBe(document.body);
  });
});

test("property: the inline renderer never produces an element outside the inline allow-list", () => {
  const renderInline = makeInlineRenderer(window);
  const parts = fc.constantFrom("<div>", "</div>", "<p>", "<ul><li>", "# ", "- ", "```", "*", "_", "`", "[a](https://e.org)", "<script>x</script>", "<img src=x onerror=y>", "text", "\n", "|a|b|\n|-|-|");
  fc.assert(
    fc.property(fc.array(parts, { maxLength: 8 }), (ps) => {
      const el = document.createElement("div");
      el.innerHTML = renderInline(ps.join(""));
      return [...el.querySelectorAll("*")].every((e) => INLINE_TAGS.includes(e.tagName.toLowerCase()));
    }),
    { numRuns: 200 },
  );
});

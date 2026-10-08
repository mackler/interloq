// S13 of the task of issue #36: a question's pieces rendered directly. A piece that refers to an explanation is a
// focusable word that carries it (hover and keyboard, S42, S44); a plain piece is inline Markdown only, sanitized on its
// own; a code piece and a code block are their text exactly; no list of terms is rendered.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import fc from "fast-check";
import type { Explanation, Piece, ShownBlock } from "../../src/pieces.ts";
import { Result } from "effect";
import { numberedSenses, type PresentedQuestion, type ShownExplanation, shownExplanations } from "../../src/question.ts";
import { renderQuestionRecord } from "../../src/render.ts";
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
/** Issue #112: an explanation as a presented question holds it, its senses built by the program's one constructor. */
const shown = (es: readonly Explanation[]): readonly ShownExplanation[] => {
  const built = shownExplanations(es);
  if (Result.isFailure(built)) throw new Error(`not presented explanations: ${JSON.stringify(es)}`);
  return built.success;
};
const show = (raw: { blocks?: readonly ShownBlock[]; pieces?: readonly Piece[]; explanations: readonly Explanation[] }) => {
  const props = { ...raw, explanations: shown(raw.explanations) };
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
const sqlite: Explanation = { id: "s", term: "SQLite", senses: ["An engine that keeps a database in one file."] };
const database: Explanation = { id: "d", term: "database", senses: ["Data kept for later use."] };

describe("the pieces of a question", () => {
  test("each piece that refers to an explanation is a focusable word whose tooltip shows that explanation, not the term's name", () => {
    const root = show({ pieces: [ref("SQLite", "s"), plain(" keeps the "), ref("databases", "d"), plain(".")], explanations: [sqlite, database] });
    const words = [...root.querySelectorAll<HTMLElement>(".term")];
    expect(words.map((w) => [w.textContent, w.tabIndex])).toEqual([["SQLite", 0], ["databases", 0]]);
    hover(words[1]);
    expect(tooltip()?.textContent).toContain(database.senses[0]);
    expect(tooltip()?.textContent).not.toContain("database:");
    expect(words[1].getAttribute("aria-describedby")).toBe(tooltip()!.id);
  });

  test("two pieces with one ref, a plural and a capitalized first word, show the same explanation", () => {
    const root = show({ pieces: [ref("Execution calls", "e"), plain(" and one "), ref("execution call", "e"), plain(".")], explanations: [{ id: "e", term: "execution call", senses: ["The part in which the plan is carried out."] }] });
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

  // W1-R1-3 (S24): levels beyond what Markdown can express are normalized; nesting is never deeper than the items.
  test("a list with unbounded levels renders nested no deeper than its items", () => {
    const root = show({ blocks: [{ kind: "list", items: [{ level: 2147483647, pieces: [plain("a")] }, { level: -5, pieces: [plain("b")] }, { level: 2147483647, pieces: [plain("c")] }] }], explanations: [] });
    const depth = (el: Element): number => (el.parentElement === null || el.parentElement === root ? 0 : (el.tagName === "UL" ? 1 : 0) + depth(el.parentElement));
    const lis = [...root.querySelectorAll("li")];
    const own = (li: Element) => [...li.childNodes].filter((n) => !(n instanceof HTMLUListElement)).map((n) => n.textContent).join("");
    expect(lis.map(own)).toEqual(["a", "b", "c"]);
    expect(Math.max(...lis.map(depth))).toBeLessThanOrEqual(3);
    expect(own(root.querySelector("ul ul li")!)).toBe("c");
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
    const root = show({ pieces: [ref("SQLite", "s"), plain(" keeps the "), ref("database", "d"), plain(".")], explanations: [{ ...sqlite, senses: [long] }, database] });
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

// W2-R1-1 and P3-R1-1 (S26), the seam of the format and the rendering: blocks written as the clause "interrupted" of
// QUESTION_FORMAT describes them (a code block and a paragraph between two lists) are shown inside the list's last item
// before them, and the list after them continues at its levels.
describe("a list interrupted by blocks (the format's clause and the rendering)", () => {
  test("the clause is in the format the writers read, and the rendering does what it says", async () => {
    const prompts = await import("../../src/prompts.ts");
    const clause = prompts.QUESTION_FORMAT.find((c) => c.id === "interrupted");
    expect(clause?.text).toBeTruthy();
    expect(prompts.QUESTION_TEXT_FORMAT).toContain(clause!.text);
    const root = show({
      blocks: [
        { kind: "list", items: [{ level: 0, pieces: [plain("outer")] }, { level: 1, pieces: [plain("command")] }] },
        { kind: "code", text: "a\nb" },
        { kind: "paragraph", pieces: [plain("A note.")] },
        { kind: "list", items: [{ level: 1, pieces: [plain("inner")] }, { level: 0, pieces: [plain("after")] }] },
      ],
      explanations: [],
    });
    const own = (li: Element) => [...li.childNodes].filter((n) => n instanceof Text || (n instanceof HTMLElement && !["UL", "PRE", "P"].includes(n.tagName))).map((n) => n.textContent).join("");
    const command = [...root.querySelectorAll("li")].find((li) => own(li) === "command")!;
    expect(command.querySelector("pre code")?.textContent).toBe("a\nb");
    expect(command.querySelector("p")?.textContent).toBe("A note.");
    expect(root.querySelectorAll(":scope > div > ul").length).toBe(1);
    expect([...root.querySelectorAll(":scope > div > ul > li")].map(own)).toEqual(["outer", "after"]);
    expect([...root.querySelectorAll(":scope > div > ul > li > ul > li")].map(own)).toEqual(["command", "inner"]);
  });
});

// Issue #112: a term with two senses shows both, numbered in the order given, as a dictionary does; one sense has no number.
describe("the senses of a term", () => {
  const port: Explanation = { id: "p", term: "port", senses: ["The number in the address of the page.", "The socket the server listens on."] };
  test("two senses are numbered 1 and 2 in their order; one sense shows no number", () => {
    const root = show({ pieces: [plain("Which "), ref("port", "p"), plain("?")], explanations: [port] });
    hover(root.querySelector<HTMLElement>(".term")!);
    const items = [...tooltip()!.querySelectorAll("li")].map((li) => li.textContent?.replace(/\s+/g, " ").trim());
    expect(items).toEqual([`1. ${port.senses[0]}`, `2. ${port.senses[1]}`]);
    document.body.innerHTML = "";
    const one = show({ pieces: [ref("SQLite", "s")], explanations: [sqlite] });
    hover(one.querySelector<HTMLElement>(".term")!);
    expect(tooltip()!.querySelectorAll("li").length).toBe(0);
    expect(tooltip()!.textContent?.trim()).toBe(sqlite.senses[0]);
  });

  // The seam: the numbers the tooltip shows and the numbers conversation.md writes are both those of numberedSenses.
  test("the tooltip and conversation.md number the senses alike, from numberedSenses", () => {
    const [explanation] = shown([port]);
    const numbered = numberedSenses(explanation.senses).map((s) => `${s.number}. ${s.text}`);
    const root = show({ pieces: [ref("port", "p"), plain("?")], explanations: [port] });
    hover(root.querySelector<HTMLElement>(".term")!);
    expect([...tooltip()!.querySelectorAll("li")].map((li) => li.textContent?.replace(/\s+/g, " ").trim())).toEqual(numbered);
    const q: PresentedQuestion = { number: 1, origin: { kind: "relayed" }, context: { blocks: [], by: "agent" }, explanations: [explanation], question: [ref("port", "p"), plain("?")], options: [], details: [], decision: null };
    const record = renderQuestionRecord(q);
    for (const line of numbered) expect(record).toContain(`  ${line}\n`);
  });
});

// S45 (W3-R1-2, P4-R1-1): a permission's tool input is shown literally. S9 of the task of issue #36: the input is blocks
// of the details (toolInputBlocks of src/prompts.ts), rendered by the page's QuestionText; the seam is the blocks as the
// program builds them, shown in the page, every value exactly.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import * as prompts from "../../src/prompts.ts";
import { blocksMarkdown, plainBlocks } from "../../src/pieces.ts";
import fc from "fast-check";
import { renderQuestionRecord } from "../../src/render.ts";
import QuestionText from "./components/QuestionText.svelte";
import { render, renderInline } from "./markdown.ts";
import { shownOf } from "./test-setup.ts";

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
});
const shown = (blocks: ReturnType<typeof prompts.toolInputBlocks>, explanations: ReturnType<typeof prompts.toolInputExplanations> = []): HTMLElement => {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(QuestionText, { target, props: { blocks, explanations: explanations.map(shownOf) } }));
  flushSync();
  return target;
};
const rendered = (input: Record<string, unknown>): HTMLElement => shown(prompts.toolInputBlocks(input), prompts.toolInputExplanations(input));
const codes = (el: HTMLElement): string[] => [...el.querySelectorAll("code")].map((c) => c.textContent ?? "");
const blockCodes = (el: HTMLElement): string[] => [...el.querySelectorAll("pre code")].map((c) => c.textContent ?? "");
const noteText = (): string => {
  const el = document.createElement("div");
  el.innerHTML = renderInline(prompts.ESCAPED_VALUE_NOTE);
  return el.textContent ?? "";
};

describe("a tool's input, rendered in the page", () => {
  const singleLine = [
    "<script>alert(1)</script>",
    "echo <secret> > /tmp/out",
    "*emphasis*",
    "_x_",
    "`prefix",
    "suffix`",
    "`both`",
    "a `` b",
    " value ",
    " x",
    "x ",
  ];
  for (const value of singleLine) {
    test(`a single-line value is shown exactly: ${JSON.stringify(value)}`, () => {
      expect(codes(rendered({ new_string: value }))).toEqual([value]);
    });
  }

  for (const value of ["line 1\n```\nline 3", "  indented\n    more", "a\n````\nb"]) {
    test(`a multi-line value is shown exactly in its block: ${JSON.stringify(value)}`, () => {
      const el = rendered({ content: value });
      expect(blockCodes(el)).toEqual([value]);
    });
  }

  test("the empty string and spaces alone are shown as the program's phrases", () => {
    expect(rendered({ new_string: "" }).textContent).toContain(prompts.emptyTextPhrase);
    expect(rendered({ new_string: "   " }).textContent).toContain(prompts.spacesPhrase(3));
    expect(codes(rendered({ new_string: "" }))).toEqual([]);
  });

  test("the labels are the program's own text, a number is code, and a boolean and null are the program's phrases (W1-R1-1)", () => {
    const el = rendered({ file_path: "/tmp/a", replace_all: true, timeout: 5, run_in_background: false, mode: null });
    expect(el.textContent).toContain("The file:");
    expect(el.textContent).toContain(`Replace every occurrence: ${prompts.YES_PHRASE}`);
    expect(el.textContent).toContain(prompts.NO_PHRASE);
    expect(el.textContent).toContain(prompts.NONE_PHRASE);
    expect(codes(el)).toEqual(["/tmp/a", "5", "run_in_background", "mode"]);
  });

  test("conversation.md carries the same text", () => {
    const details = prompts.toolInputBlocks({ command: "echo <secret> > /tmp/out" });
    const record = renderQuestionRecord({ number: 1, origin: { kind: "permission", tool: "Bash", input: "" }, context: { blocks: plainBlocks("c"), by: "program" }, explanations: [], question: [{ text: "Allow?", ref: "", code: false }], options: [], details, decision: null });
    const el = document.createElement("div");
    el.innerHTML = render(record);
    expect(codes(el)).toContain("echo <secret> > /tmp/out");
  });
});

// S48 (P5-R1-1, P5-R1-2): through the page's renderer, a value is shown exactly or with each differing character named.
describe("whitespace and invisible characters in a tool's input", () => {
  const text = (input: Record<string, unknown>) => rendered(input).textContent ?? "";
  test("whitespace alone is named as its runs in order", () => {
    expect(text({ new_string: "\t" })).toContain("(1 tab)");
    expect(text({ new_string: "\u00a0" })).toContain("(1 non-breaking space)");
    const a = text({ old_string: "\t  " });
    const b = text({ old_string: "  \t" });
    expect(a).toContain("(1 tab, then 2 spaces)");
    expect(b).toContain("(2 spaces, then 1 tab)");
    expect(a).not.toBe(b);
  });
  for (const [value, escape, raw] of [
    ["before\rafter", "before\\rafter", "\r"],
    ["end\r", "end\\r", "\r"],
    ["a\u200bb", "a\\u200Bb", "\u200b"],
    ["bell\u0007", "bell\\u0007", "\u0007"],
    ["\u00a0x", "\\u00A0x", "\u00a0"],
  ] as const) {
    test(`an invisible or control character is a visible escape: ${JSON.stringify(value)}`, () => {
      const el = rendered({ new_string: value });
      expect(codes(el)[0]).toBe(escape);
      expect(el.textContent).not.toContain(raw);
      expect(el.textContent).toContain(noteText());
    });
  }
  test("a multi-line value with CRLF line ends shows the carriage return's escape at the end of its line", () => {
    const el = rendered({ content: "one\r\ntwo" });
    expect(blockCodes(el)).toEqual(["one\\r\ntwo"]);
  });
});

// S52 (W5-R1-1, P6-R1-1): the fault of the transport pause moved into its details, which the page renders as Markdown.
// The fault is text of the SDK or the CLI, not Markdown, so it is shown literally, as a tool's input is.
describe("the transport pause's fault, rendered in the page", () => {
  const faults = ["Connection failed: <endpoint> unavailable", "a ` tick and a ``` run", "*stars* and _underscores_"];
  const renderedDetails = (fault: string): HTMLElement => shown(prompts.transportDetails(3, fault));
  for (const fault of faults) {
    test(`a single-line fault is shown exactly: ${JSON.stringify(fault)}`, () => {
      const el = renderedDetails(fault);
      expect(el.textContent).toContain(prompts.TRANSPORT_FAULT_HEADING);
      expect(codes(el)).toEqual([fault]);
    });
  }
  test("a fault of several lines is shown exactly in its block", () => {
    const fault = "request failed\n    at <anonymous>\n```";
    expect(blockCodes(renderedDetails(fault))).toEqual([fault]);
  });
  test("the record in conversation.md carries the same details", () => {
    const details = prompts.transportDetails(3, faults[0]);
    const q = { number: 1, origin: { kind: "transport", agent: "codex", what: "the review", attempts: 3, fault: faults[0] }, context: { blocks: plainBlocks("c"), by: "program" }, explanations: [], question: [{ text: prompts.transportExhaustedQuestion("codex", "the review"), ref: "", code: false }], options: [], details, decision: null } as const;
    const record = renderQuestionRecord(q as never);
    expect(record).toContain(prompts.TRANSPORT_FAULT_HEADING);
    expect(record).toContain(`\`${faults[0]}\``);
  });
});

// S54 (W3-R1-2 of work review 6): a multi-line value's leading and trailing line breaks are shown, so that values that
// differ only in them never display alike (a fenced block drops a trailing line break of its content).
describe("line breaks at the edges of a value", () => {
  const values = ["a\nb", "a\nb\n", "a\nb\n\n", "\na\nb", "a\r\n"];
  test("values that differ only in their edge line breaks display differently", () => {
    const shown = values.map((v) => rendered({ content: v }).textContent ?? "");
    expect(new Set(shown).size).toBe(values.length);
  });
  test("an escaped edge line break carries the note; a value without one still round-trips", () => {
    const el = rendered({ content: "a\nb\n" });
    expect(el.textContent).toContain("a\nb\\n");
    expect(el.textContent).toContain(noteText());
    expect(blockCodes(rendered({ content: "a\nb" }))).toEqual(["a\nb"]);
  });
  test("a multi-line fault ending in a line break keeps it visible in the transport pause's details", () => {
    expect(shown(prompts.transportDetails(1, "first\nsecond\n")).textContent).toContain("second\\n");
  });
});

// S55 (W6-R1-1, P7-R1-1): a field without a plain label shows its own name literally, every line break escaped, and
// the label table is looked up by own properties only; the term of a key is the text displayed for it.
describe("the names of fields without a plain label", () => {
  const keys = ["**mode**", "mode", "<target>", "a`b", " mode", "a\nb", "a b", "constructor", "toString", "__proto__"];
  const inputWith = (key: string): Record<string, unknown> => {
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, key, { value: 1, enumerable: true, configurable: true, writable: true });
    return input;
  };
  const shownOf = (key: string) => rendered(inputWith(key)).textContent ?? "";
  test("every name is shown; names that differ display differently; none is removed or labeled as a known field", () => {
    const shown = keys.map(shownOf);
    expect(new Set(shown).size).toBe(keys.length);
    expect(shownOf("<target>")).toContain("<target>");
    expect(shownOf("**mode**")).toContain("**mode**");
    for (const key of ["constructor", "toString", "__proto__"]) {
      expect(shownOf(key)).toContain(prompts.unknownSettingLabel(key).replace(/`/g, ""));
      expect(shownOf(key)).not.toMatch(/function|native code/);
      expect(prompts.toolInputExplanations(inputWith(key)).length).toBe(1);
      expect(prompts.permissionFacts("T", inputWith(key))).not.toMatch(/function|native code/);
    }
  });
  test("the seam: each name refers to its explanation in the details as validated, and is marked in the page", async () => {
    const { permissionDraft } = await import("../../src/offer.ts");
    const { questionProblems, suppliedOf } = await import("../../src/question.ts");
    for (const key of keys) {
      const draft = permissionDraft("FutureTool", inputWith(key));
      expect(draft.explanations.length, key).toBe(1);
      const details = draft.details ?? [];
      const supplied = suppliedOf({ context: [], question: [], explanations: [], options: [], details });
      const problems = questionProblems({ context: plainBlocks("c"), question: draft.question, explanations: draft.explanations, options: [], details }, supplied);
      expect(problems, key).toEqual([]);
      const el = rendered(inputWith(key));
      expect([...el.querySelectorAll<HTMLElement>(".term")].map((m) => [m.textContent, m.dataset.ref]), key).toEqual([[draft.explanations[0].term, draft.explanations[0].id]]);
    }
  });
  test("a name with a line break is written with the escape, and its explanation says so", () => {
    expect(shownOf("a\nb")).toContain("a\\nb");
    const [term] = prompts.toolInputExplanations(inputWith("a\nb"));
    expect(term.term).toBe("a\\nb");
    expect(term.senses).toEqual([prompts.unknownSettingEscapedExplanation]);
  });
});

// S57 (W6-R1-1 of work review 7, P8-R1-1): through the page's renderer, distinct names display differently, escaped ones
// carry the note, and every term is marked and passes the validation.
describe("names that would otherwise display alike", () => {
  const BS = String.fromCharCode(92);
  const LF = String.fromCharCode(10);
  const groups: readonly (readonly string[])[] = [
    [`a${LF}b`, `a${BS}nb`],
    [`a${BS}b`, `a${BS}${BS}b`],
    ["", "(empty text)", "(empty name)"],
    [" ", "(1 space)", `${BS}u0020`],
    ["\t", "(1 tab)", `${BS}u0009`],
  ];
  const inputOf = (keys: readonly string[]) => {
    const input: Record<string, unknown> = {};
    for (const k of keys) Object.defineProperty(input, k, { value: 1, enumerable: true, configurable: true, writable: true });
    return input;
  };
  test("labels differ, the note is beside each escaped name, and every name refers to its explanation without a problem", async () => {
    const { permissionDraft } = await import("../../src/offer.ts");
    const { questionProblems, suppliedOf } = await import("../../src/question.ts");
    const note = noteText();
    for (const group of groups) {
      const labels = group.map((k) => {
        const el = document.createElement("div");
        el.innerHTML = render(prompts.unknownSettingLabel(k));
        return el.textContent ?? "";
      });
      expect(new Set(labels).size, JSON.stringify(group)).toBe(group.length);
      for (const k of group) if (k !== "" && prompts.shownName(k).kind === "escaped") expect(rendered(inputOf([k])).textContent).toContain(note);
      const draft = permissionDraft("FutureTool", inputOf(group));
      expect(draft.explanations.length).toBe(group.filter((k) => k !== "").length);
      const details = draft.details ?? [];
      const supplied = suppliedOf({ context: [], question: [], explanations: [], options: [], details });
      const problems = questionProblems({ context: plainBlocks("c"), question: draft.question, explanations: draft.explanations, options: [], details }, supplied);
      expect(problems, JSON.stringify(group)).toEqual([]);
      const marked = new Set([...rendered(inputOf(group)).querySelectorAll<HTMLElement>(".term")].map((m) => m.dataset.ref));
      for (const e of draft.explanations) expect(marked.has(e.id), e.term).toBe(true);
    }
  });
});

// S60 (W8-R1-2): through the page's renderer, empty lists, empty objects, the empty text and null display differently,
// and the phrases are plain text, never code.
describe("empty containers in a tool's input", () => {
  test("the rendered texts differ pairwise, and a phrase is not code", () => {
    const inputs = [{ settings: [] }, { settings: {} }, { settings: "" }, { settings: null }, { edits: [{}] }, { edits: [[]] }, {}];
    const texts = inputs.map((i) => rendered(i).textContent ?? "");
    expect(new Set(texts).size).toBe(inputs.length);
    for (const [input, phrase] of [[{ settings: [] }, prompts.EMPTY_LIST_PHRASE], [{ settings: {} }, prompts.EMPTY_OBJECT_PHRASE], [{}, prompts.NO_INPUT_PHRASE]] as const) {
      const el = rendered(input);
      expect(el.textContent).toContain(phrase);
      expect(codes(el).some((c) => c.includes(phrase))).toBe(false);
    }
  });
});

// W2-R1-1 and P3-R1-1 (S26): a multi-line value (a code block) and its escapes note (a paragraph) sit inside the item of
// their setting, and every setting is shown at its depth in the input: in the page's DOM, and in the Markdown of
// conversation.md as a Markdown renderer nests it.
describe("the nesting of a tool's input around a multi-line value", () => {
  /** The number of lists around an element, inside the rendered root. */
  const depthIn = (root: HTMLElement, el: Element): number => {
    let depth = -1;
    for (let at: Element | null = el; at !== null && at !== root; at = at.parentElement) if (at.tagName === "UL") depth += 1;
    return depth;
  };
  const codeNamed = (root: HTMLElement, text: string): HTMLElement => [...root.querySelectorAll<HTMLElement>("code")].find((c) => c.textContent === text)!;
  const markdownShown = (input: Record<string, unknown>): HTMLElement => {
    const el = document.createElement("div");
    el.innerHTML = render(blocksMarkdown(prompts.toolInputBlocks(input)));
    document.body.appendChild(el);
    return el;
  };
  test.each([["a\nb"], ["a\nb\r"]])("the reproduction with the command %j", (command) => {
    const input = { outer: { command, timeout: 12 }, timeout: 34 };
    for (const root of [rendered(input), markdownShown(input)]) {
      expect(depthIn(root, codeNamed(root, "12"))).toBe(1);
      expect(depthIn(root, codeNamed(root, "34"))).toBe(0);
      const block = root.querySelector("pre")!;
      const item = block.closest("li")!;
      expect(item.textContent).toContain("The command:");
      expect(depthIn(root, block)).toBe(1);
      if (command.includes("\r")) {
        const note = [...root.querySelectorAll("p")].find((p) => p.textContent?.startsWith("(Characters that cannot be shown"))!;
        expect(note.closest("li")).toBe(item);
      }
    }
  });
  test("property: every setting is shown at its depth in the input", () => {
    type Tree = { readonly [k: string]: Tree | string | number };
    const leaf = fc.oneof(fc.constant(0), fc.constantFrom("a\nb", "a\nb\r", "one", "x\n\ty​"));
    const { tree } = fc.letrec<{ tree: Tree }>((tie) => ({
      tree: fc.dictionary(fc.stringMatching(/^k[a-z]{1,3}$/), fc.oneof({ depthSize: "small" }, leaf, tie("tree")), { minKeys: 1, maxKeys: 3 }) as fc.Arbitrary<Tree>,
    }));
    fc.assert(
      fc.property(tree, (t) => {
        // Each number leaf gets a unique value, so that its code element can be found; its depth is recorded.
        let next = 1000;
        const depths = new Map<string, number>();
        const numbered = (node: Tree, depth: number): Tree =>
          Object.fromEntries(Object.entries(node).map(([k, v]) => {
            if (typeof v === "number") {
              const n = next++;
              depths.set(String(n), depth);
              return [k, n];
            }
            return [k, typeof v === "string" ? v : numbered(v, depth + 1)];
          }));
        const input = numbered(t, 0);
        for (const root of [rendered(input), markdownShown(input)]) {
          for (const [n, depth] of depths) expect(depthIn(root, codeNamed(root, n)), `${n} in ${JSON.stringify(input)}`).toBe(depth);
          // A block between two lists belongs to the item before it; one after the last list stands after the list.
          const all = [...root.querySelectorAll("pre, li")];
          for (const pre of root.querySelectorAll("pre")) if (all.slice(all.indexOf(pre) + 1).some((e) => e.tagName === "LI")) expect(pre.closest("li")).not.toBe(null);
        }
        for (const m of mounted) unmount(m);
        mounted = [];
        document.body.innerHTML = "";
      }),
      { numRuns: 60 },
    );
  });
});

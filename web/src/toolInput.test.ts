// S45 (W3-R1-2, P4-R1-1): a permission's tool input is shown literally. S9 of the task of issue #36: the input is blocks
// of the details (toolInputBlocks of src/prompts.ts), rendered by the page's QuestionText; the seam is the blocks as the
// program builds them, shown in the page, every value exactly.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import * as prompts from "../../src/prompts.ts";
import { blockPieces, plainBlocks } from "../../src/pieces.ts";
import { renderQuestionRecord } from "../../src/render.ts";
import QuestionText from "./components/QuestionText.svelte";
import { render, renderInline } from "./markdown.ts";

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
});
const shown = (blocks: ReturnType<typeof prompts.toolInputBlocks>, explanations: ReturnType<typeof prompts.toolInputExplanations> = []): HTMLElement => {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(QuestionText, { target, props: { blocks, explanations } }));
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

  test("the labels, numbers and booleans are the program's own text", () => {
    const el = rendered({ file_path: "/tmp/a", replace_all: true, timeout: 5 });
    expect(el.textContent).toContain("The file:");
    expect(el.textContent).toContain("Replace every occurrence: yes");
    expect(el.textContent).toContain("5");
    expect(codes(el)).toEqual(["/tmp/a"]);
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
    const { questionProblems } = await import("../../src/question.ts");
    for (const key of keys) {
      const draft = permissionDraft("FutureTool", inputWith(key));
      expect(draft.explanations.length, key).toBe(1);
      const details = draft.details ?? [];
      const supplied = blockPieces(details).filter((p) => p.code && p.ref !== "");
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
    expect(term.explanation).toBe(prompts.unknownSettingEscapedExplanation);
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
    const { questionProblems } = await import("../../src/question.ts");
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
      const supplied = blockPieces(details).filter((p) => p.code && p.ref !== "");
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

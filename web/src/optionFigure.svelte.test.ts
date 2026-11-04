// Issue #98 (requirements Q1): each option's picture is drawn inside its card, under its label and description, visible
// at once; a screen reader reads its alt text; nothing unsanitized reaches the page; an option without one looks as before.
// Issue #247 (requirements Q1): the picture stands beside the choosing button inside the choice, never inside it, so that
// nothing done with the picture or its enlarged view sends an answer, while the label and description still choose.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Figure } from "../../src/figure.ts";
import { plainPieces } from "../../src/pieces.ts";
import * as prompts from "../../src/prompts.ts";
import type { PresentedQuestion } from "../../src/question.ts";
import { promptOf } from "../../src/userPrompts.ts";
import AnsweredQuestion from "./components/AnsweredQuestion.svelte";
import QuestionPane from "./components/QuestionPane.svelte";
import type { Widget } from "./state.ts";

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
});
const target = () => document.body.appendChild(document.createElement("div"));

const figure = (size: number, extra = ""): Figure =>
  ({ svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"${extra}><defs><rect id="shape" width="${size}" height="${size}"/></defs><use href="#shape"/></svg>`, alt: `A square ${size} wide.` }) as Figure;
const question = (figures: readonly (Figure | null)[]): PresentedQuestion => ({
  number: 1,
  origin: { kind: "relayed" },
  context: { blocks: [{ kind: "paragraph", pieces: plainPieces("c") }], by: "agent" },
  history: [],
  explanations: [],
  question: plainPieces("Which?"),
  options: figures.map((f, i) => ({ label: plainPieces(`Option ${i + 1}`), description: plainPieces("d"), figure: f, answer: { token: String(i + 1) } })),
  attached: null,
  decision: null,
});
const widgetOf = (q: PresentedQuestion): Widget => {
  const asked = { _tag: "Asked" as const, prompt: 1, ...promptOf(prompts.decisionPrompt), countdown: null, deciding: null, beside: null };
  return { asked, options: [], choices: asked.choices, question: q, presentedAt: null, hint: prompts.pagePromptText(asked.kind, prompts.decisionPrompt), countdown: null, held: true, decision: "none" };
};
const pane = (q: PresentedQuestion, onAnswer: (prompt: number, text: string) => void = () => undefined, decision: Widget["decision"] = "none") => {
  const root = target();
  mounted.push(mount(QuestionPane, { target: root, props: { widget: { ...widgetOf(q), decision }, identity: { incarnation: "A", run: 1, prompt: 1 }, text: "", onAnswer } }));
  flushSync();
  return root;
};
const key = (el: EventTarget, k: string) => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  flushSync();
};

describe("a picture on each choice's card", () => {
  test("each choice holds its own picture, named by its alt text, outside its choosing button", () => {
    const root = pane(question([figure(40), figure(320)]));
    const cards = [...root.querySelectorAll(".options [data-choice]")];
    expect(cards).toHaveLength(2);
    expect(root.querySelectorAll(".options [data-choice] > button [data-option-figure]")).toHaveLength(0);
    cards.forEach((card, i) => {
      const shown = card.querySelectorAll("[data-option-figure]");
      expect(shown).toHaveLength(1);
      expect(shown[0]!.getAttribute("role")).toBe("img");
      expect(shown[0]!.getAttribute("aria-label")).toBe(`A square ${i === 0 ? 40 : 320} wide.`);
      expect(shown[0]!.querySelector("svg")).not.toBeNull();
    });
  });
  test("two pictures that define the same id keep apart, each use naming its own picture's element", () => {
    const root = pane(question([figure(40), figure(320)]));
    const ids = [...root.querySelectorAll("[data-option-figure] [id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const shown of root.querySelectorAll("[data-option-figure]")) {
      const use = shown.querySelector("use")!;
      const ref = use.getAttribute("href")!.slice(1);
      expect(shown.querySelector(`[id="${ref}"]`)).not.toBeNull();
    }
  });
  test("a script and an event handler are not rendered", () => {
    const bad = { svg: '<svg viewBox="0 0 1 1" onload="window.__hit = 1"><script>window.__hit = 2</script><rect width="1" height="1"/></svg>', alt: "A dot." } as Figure;
    const root = pane(question([bad, null]));
    expect(root.querySelector("[data-option-figure] script")).toBeNull();
    expect(root.querySelector("[data-option-figure] [onload]")).toBeNull();
    expect(root.querySelector("[data-option-figure] rect")).not.toBeNull();
  });
  test("an option without a picture renders none", () => {
    const root = pane(question([null, null]));
    expect(root.querySelector("[data-option-figure]")).toBeNull();
  });
  test("the transcript's answered question shows the pictures", () => {
    const root = target();
    mounted.push(mount(AnsweredQuestion, { target: root, props: { question: question([figure(40), null]) } }));
    flushSync();
    expect(root.querySelectorAll("[data-option-figure]")).toHaveLength(1);
    expect(root.querySelector("[data-option-figure]")!.getAttribute("aria-label")).toBe("A square 40 wide.");
  });
  test("nothing done with a picture or its enlarged view sends an answer; the card's label does", () => {
    const sent = vi.fn();
    const root = pane(question([figure(40), null]), sent);
    const control = root.querySelector<HTMLButtonElement>("[data-figure-enlarge]")!;
    control.click();
    flushSync();
    const view = document.body.querySelector<HTMLElement>("[data-figure-view]")!;
    expect(view).not.toBeNull();
    view.querySelector<HTMLElement>("[data-figure-view-picture]")!.click();
    view.click();
    flushSync();
    key(control, "Enter");
    key(view, "Escape");
    key(control, "Escape");
    expect(sent).not.toHaveBeenCalled();
    root.querySelector<HTMLElement>(".options [data-choice] > button .option-label")!.click();
    flushSync();
    expect(sent).toHaveBeenCalledWith(1, "1");
  });
  test("the picture stays enabled while its card waits for the answer to start", () => {
    const root = pane(question([figure(40), null]), () => undefined, "starting");
    expect(root.querySelector<HTMLButtonElement>(".options [data-choice] > button")!.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>("[data-figure-enlarge]")!.disabled).toBe(false);
  });
  test("the transcript's picture opens the enlarged view on click", () => {
    const root = target();
    mounted.push(mount(AnsweredQuestion, { target: root, props: { question: question([figure(40), null]) } }));
    flushSync();
    root.querySelector<HTMLButtonElement>("[data-figure-enlarge]")!.click();
    flushSync();
    expect(document.body.querySelector("[data-figure-view]")!.getAttribute("aria-label")).toBe("A square 40 wide.");
  });
});

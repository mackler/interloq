// Issue #247 (requirements Q1): an option's picture is its own control. Hovering it, or a click, tap, Enter or Space on
// it, opens the enlarged view in the document's body, named by its alt text, at the largest size the window allows; the
// view closes as the requirements say, returns focus when it took it, and keeps its ids apart from every other copy.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Figure } from "../../src/figure.ts";
import { CLOSE_PICTURE, enlargePictureName } from "../../src/prompts.ts";
import OptionFigure from "./components/OptionFigure.svelte";
import { aspectOf, enlargedSize, HOVER_CLOSE_MS, HOVER_OPEN_MS, roomOf } from "./figureView.ts";

let mounted: ReturnType<typeof mount>[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const figure = (extra = ' viewBox="0 0 400 300"', alt = "A sketch of the page."): Figure =>
  ({ svg: `<svg xmlns="http://www.w3.org/2000/svg"${extra}><defs><rect id="shape" width="40" height="40"/></defs><use href="#shape"/></svg>`, alt }) as Figure;
const show = (f: Figure) => {
  const root = document.body.appendChild(document.createElement("div"));
  mounted.push(mount(OptionFigure, { target: root, props: { figure: f } }));
  flushSync();
  return { root, control: root.querySelector<HTMLButtonElement>("[data-figure-enlarge]")! };
};
const views = () => [...document.body.querySelectorAll<HTMLElement>("[data-figure-view]")];
const fire = (el: EventTarget, type: string, init: EventInit = {}) => {
  el.dispatchEvent(new Event(type, { bubbles: type !== "mouseenter" && type !== "mouseleave", ...init }));
  flushSync();
};
const wait = (ms: number) => {
  vi.advanceTimersByTime(ms);
  flushSync();
};
const hoverOpen = (control: HTMLElement) => {
  fire(control, "mouseenter");
  wait(HOVER_OPEN_MS);
};
const closeButton = (view: HTMLElement) => view.querySelector<HTMLButtonElement>('button[name="close-picture"]')!;
const key = (el: EventTarget, k: string) => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  flushSync();
};

describe("hovering a picture", () => {
  test("opens a view in the body, outside the picture, named by the alt text", () => {
    const { root, control } = show(figure());
    expect(control.getAttribute("aria-label")).toBe(enlargePictureName("A sketch of the page."));
    hoverOpen(control);
    const [view] = views();
    expect(view).toBeDefined();
    expect(root.contains(view!)).toBe(false);
    expect(view!.getAttribute("role")).toBe("dialog");
    expect(view!.getAttribute("aria-label")).toBe("A sketch of the page.");
    const picture = view!.querySelector("[data-figure-view-picture]")!;
    expect(picture.getAttribute("role")).toBe("img");
    expect(picture.getAttribute("aria-label")).toBe("A sketch of the page.");
    expect(control.getAttribute("aria-expanded")).toBe("true");
  });
  test("its picture takes the enlarged size, larger than the card's picture", () => {
    Object.assign(window, { innerWidth: 1280, innerHeight: 800 });
    const { root, control } = show(figure());
    const card = root.querySelector("[data-option-figure]")!;
    card.getBoundingClientRect = () => ({ width: 220, height: 165, x: 0, y: 0, top: 0, left: 0, right: 220, bottom: 165, toJSON: () => ({}) });
    hoverOpen(control);
    const box = views()[0]!.querySelector<HTMLElement>("[data-figure-view-picture]")!;
    const expected = enlargedSize(aspectOf("0 0 400 300", null, null), roomOf({ width: 1280, height: 800 }));
    expect(box.style.width).toBe(`${expected.width}px`);
    expect(box.style.height).toBe(`${expected.height}px`);
    expect(expected.width).toBeGreaterThan(220);
    expect(expected.height).toBeGreaterThan(165);
  });
  test("a pass shorter than the delay opens nothing", () => {
    const { control } = show(figure());
    fire(control, "mouseenter");
    wait(HOVER_OPEN_MS - 20);
    fire(control, "mouseleave");
    wait(HOVER_OPEN_MS + HOVER_CLOSE_MS);
    expect(views()).toHaveLength(0);
  });
  test("leaving the picture closes it, crossing into the view keeps it, leaving the view closes it", () => {
    const { control } = show(figure());
    hoverOpen(control);
    fire(control, "mouseleave");
    wait(HOVER_CLOSE_MS);
    expect(views()).toHaveLength(0);
    hoverOpen(control);
    fire(control, "mouseleave");
    fire(views()[0]!, "mouseenter");
    wait(HOVER_CLOSE_MS * 2);
    expect(views()).toHaveLength(1);
    fire(views()[0]!, "mouseleave");
    wait(HOVER_CLOSE_MS);
    expect(views()).toHaveLength(0);
  });
  test("a hover-opened view closes by its close control while the pointer is inside it", () => {
    const { control } = show(figure());
    hoverOpen(control);
    const view = views()[0]!;
    fire(view, "mouseenter");
    closeButton(view).click();
    flushSync();
    expect(views()).toHaveLength(0);
  });
});

describe("activating a picture", () => {
  test("a click pins the view with focus on its close control; Escape, the close control and outside close it", () => {
    const { control } = show(figure());
    control.focus();
    control.click();
    flushSync();
    const view = views()[0]!;
    expect(document.activeElement).toBe(closeButton(view));
    expect(closeButton(view).textContent).toContain(CLOSE_PICTURE);
    fire(control, "mouseleave");
    wait(HOVER_CLOSE_MS * 2);
    expect(views()).toHaveLength(1);
    key(document.activeElement!, "Escape");
    expect(views()).toHaveLength(0);
    expect(document.activeElement).toBe(control);

    control.click();
    flushSync();
    closeButton(views()[0]!).click();
    flushSync();
    expect(views()).toHaveLength(0);
    expect(document.activeElement).toBe(control);

    control.click();
    flushSync();
    fire(document.body, "pointerdown");
    expect(views()).toHaveLength(0);
  });
  test("a click on a hover-opened view's picture pins it, the same element, focus moving to its close control", () => {
    const { control } = show(figure());
    hoverOpen(control);
    const view = views()[0]!;
    control.focus();
    control.click(); // a browser turns Enter or Space on the focused button into this click
    flushSync();
    expect(views()[0]).toBe(view);
    expect(document.activeElement).toBe(closeButton(view));
  });
  test("a hover opening after a pinned one moves no focus", () => {
    const { control } = show(figure());
    const other = document.body.appendChild(document.createElement("button"));
    control.click();
    flushSync();
    closeButton(views()[0]!).click();
    flushSync();
    expect(document.activeElement).toBe(control);
    other.focus();
    hoverOpen(control);
    expect(views()).toHaveLength(1);
    expect(document.activeElement).toBe(other);
    fire(control, "mouseleave");
    wait(HOVER_CLOSE_MS);
    expect(views()).toHaveLength(0);
    expect(document.activeElement).toBe(other);
  });
});

describe("the view's copy of the picture", () => {
  const idsResolve = (scope: Element) => {
    const use = scope.querySelector("use")!;
    expect(scope.querySelector(`[id="${use.getAttribute("href")!.slice(1)}"]`)).not.toBeNull();
  };
  test("its ids differ from the card's and from another view's, each use resolving within its own copy", () => {
    const a = show(figure());
    const b = show(figure());
    a.control.click();
    flushSync();
    const first = views()[0]!;
    const ids = (el: Element) => [...el.querySelectorAll("[id]")].map((e) => e.id);
    const cardIds = [...ids(a.root), ...ids(b.root)];
    const firstIds = ids(first);
    idsResolve(first);
    closeButton(first).click();
    flushSync();
    b.control.click();
    flushSync();
    const second = views()[0]!;
    idsResolve(second);
    const all = [...cardIds, ...firstIds, ...ids(second)];
    expect(new Set(all).size).toBe(all.length);
  });
  test("an SVG with width and height and no viewBox gets one in the view, the card's copy unchanged", () => {
    const { root, control } = show(figure(' width="120" height="80"'));
    control.click();
    flushSync();
    const svg = views()[0]!.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 120 80");
    expect(svg.hasAttribute("width")).toBe(false);
    expect(svg.hasAttribute("height")).toBe(false);
    const card = root.querySelector("svg")!;
    expect(card.getAttribute("width")).toBe("120");
    expect(card.hasAttribute("viewBox")).toBe(false);
  });
  test("where the sanitizer leaves nothing, the view shows the alt text", () => {
    const empty = { svg: "<div>not svg</div>", alt: "A plain sketch." } as Figure;
    const { control } = show(empty);
    control.click();
    flushSync();
    expect(views()[0]!.querySelector("[data-figure-view-picture]")!.textContent).toContain("A plain sketch.");
  });
});

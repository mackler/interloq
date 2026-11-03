// Issue #98: an agent's SVG is shown only through this sanitizer: an explicit allow-list of shapes, text and paint,
// references that stay inside the image, and ids prefixed per instance so two pictures on one page never share one.
import { describe, expect, test } from "vitest";
import { FIGURE_ALLOWED_ATTRS, FIGURE_ALLOWED_TAGS, prefixedReference, sanitizeFigure } from "./figure.ts";

const wrap = (inner: string, attrs = 'viewBox="0 0 10 10"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;
const clean = (inner: string, attrs?: string) => sanitizeFigure(wrap(inner, attrs), "p1");
const parsed = (html: string): Element => {
  const box = document.createElement("div");
  box.innerHTML = html;
  return box.firstElementChild!;
};

const FORBIDDEN = ["script", "foreignObject", "image", "feImage", "style", "a", "iframe", "animate", "animateMotion", "animateTransform", "set", "discard"];

describe("the policy", () => {
  test("no forbidden element is in the allow-list", () => {
    const allowed = new Set(FIGURE_ALLOWED_TAGS.map((t) => t.toLowerCase()));
    for (const tag of FORBIDDEN) expect(allowed.has(tag.toLowerCase()), tag).toBe(false);
    expect(FIGURE_ALLOWED_ATTRS).not.toContain("style");
    expect(FIGURE_ALLOWED_ATTRS.some((a) => a.toLowerCase().startsWith("on"))).toBe(false);
  });
});

describe("what is removed", () => {
  test.each(FORBIDDEN)("the element %s", (tag) => {
    const out = clean(`<${tag} href="http://x" xlink:href="http://x">x</${tag}><rect width="1" height="1"/>`);
    expect(out.toLowerCase()).not.toContain(`<${tag.toLowerCase()}`);
    expect(out).toContain("<rect");
  });
  test("an element outside the allow-list", () => {
    const out = clean('<filter id="f"><feGaussianBlur stdDeviation="2"/></filter><rect width="1" height="1"/>');
    expect(out.toLowerCase()).not.toContain("filter");
    expect(out.toLowerCase()).not.toContain("fegaussianblur");
  });
  test("event handlers and the style attribute", () => {
    const out = clean('<rect width="1" height="1" onclick="alert(1)" style="fill:url(http://x)"/>', 'viewBox="0 0 10 10" onload="alert(1)"');
    expect(out).not.toMatch(/onload|onclick|style=/u);
  });
  test("a reference that leaves the image", () => {
    expect(clean('<use href="http://x#a"/>')).not.toContain("http://x");
    expect(clean('<use xlink:href="data:image/svg+xml,&lt;svg/&gt;"/>')).not.toContain("data:");
  });
  test.each([
    'fill="url(http://x)"',
    'fill="URL(http://x)"',
    'fill="u\\72l(https://example.com/a.svg#p)"',
    'fill="&#117;rl(http://x)"',
    'clip-path="url(data:x)"',
  ])("the paint %s", (attr) => {
    const out = clean(`<rect width="1" height="1" ${attr}/>`);
    expect(out).toContain("<rect");
    expect(out).not.toMatch(/fill=|clip-path=/u);
  });
  test("data-* and aria-* attributes, which the allow-list does not name (W2-R1-1)", () => {
    const top = parsed(clean('<rect width="10" height="10" fill="#123456" data-extra="kept" aria-describedby="outside"/>', 'viewBox="0 0 10 10" data-extra="kept" aria-labelledby="outside"'));
    const rect = top.querySelector("rect")!;
    for (const element of [top, rect]) {
      const names = [...element.attributes].map((a) => a.name.toLowerCase());
      expect(names.filter((n) => n.startsWith("data-") || n.startsWith("aria-"))).toEqual([]);
    }
    expect(top.getAttribute("viewBox") ?? top.getAttribute("viewbox")).toBe("0 0 10 10");
    expect(rect.getAttribute("width")).toBe("10");
    expect(rect.getAttribute("height")).toBe("10");
    expect(rect.getAttribute("fill")).toBe("#123456");
  });
  test("every attribute of the result is in the allow-list (W2-R1-1)", () => {
    const allowed = new Set(FIGURE_ALLOWED_ATTRS.map((a) => a.toLowerCase()));
    const top = parsed(clean('<g data-a="1" aria-hidden="true"><rect width="10" height="10" fill="#123456" data-extra="kept" aria-describedby="outside"/></g>', 'viewBox="0 0 10 10" data-extra="kept" aria-labelledby="outside"'));
    for (const element of [top, ...top.querySelectorAll("*")]) {
      for (const attribute of element.attributes) expect(allowed.has(attribute.name.toLowerCase()), attribute.name).toBe(true);
    }
  });
  test("markup whose root is not svg is nothing", () => {
    expect(sanitizeFigure("<div>x</div>", "p1")).toBe("");
    expect(sanitizeFigure("", "p1")).toBe("");
  });
});

describe("what is kept", () => {
  test("shapes, text and groups, with viewBox and the camel-case attributes", () => {
    const out = parsed(clean('<g transform="translate(1 1)"><rect width="4" height="2" fill="#123456"/><path d="M0 0L1 1"/><text x="1" y="1" text-anchor="middle">Hi</text></g><linearGradient id="g" gradientUnits="userSpaceOnUse"/><marker id="m" refX="1" refY="1"/>'));
    expect(out.tagName.toLowerCase()).toBe("svg");
    expect(out.getAttribute("viewBox")).toBe("0 0 10 10");
    for (const sel of ["g", "rect", "path", "text"]) expect(out.querySelector(sel), sel).not.toBeNull();
    expect(out.querySelector("text")?.textContent).toBe("Hi");
    expect(out.querySelector("lineargradient, linearGradient")?.getAttribute("gradientUnits")).toBe("userSpaceOnUse");
    expect(out.querySelector("marker")?.getAttribute("refX")).toBe("1");
  });
  test("references inside the image, prefixed with the instance's prefix", () => {
    const out = parsed(clean('<defs><linearGradient id="grad"/><rect id="a" width="1" height="1"/></defs><rect width="1" height="1" fill="url(#grad)"/><rect width="1" height="1" fill="url( \'#grad\')"/><use href="#a"/>'));
    expect(out.querySelector("[id=p1-grad]")).not.toBeNull();
    expect(out.querySelector("[id=p1-a]")).not.toBeNull();
    const fills = [...out.querySelectorAll("rect[fill]")].map((r) => r.getAttribute("fill"));
    expect(fills).toEqual(["url(#p1-grad)", "url(#p1-grad)"]);
    expect(out.querySelector("use")?.getAttribute("href")).toBe("#p1-a");
  });
  test("two pictures that both define shape keep their ids apart", () => {
    const one = parsed(sanitizeFigure(wrap('<defs><rect id="shape" width="1" height="1"/></defs><use href="#shape"/>'), "p1"));
    const two = parsed(sanitizeFigure(wrap('<defs><rect id="shape" width="9" height="9"/></defs><use href="#shape"/>'), "p2"));
    expect(one.querySelector("rect")?.id).toBe("p1-shape");
    expect(two.querySelector("rect")?.id).toBe("p2-shape");
    expect(one.querySelector("use")?.getAttribute("href")).toBe("#p1-shape");
    expect(two.querySelector("use")?.getAttribute("href")).toBe("#p2-shape");
  });
});

describe("fragment references in any case and spacing (W1-R1-1)", () => {
  test.each(['URL(#g)', "Url( '#g' )", 'url (#g)'])("fill=%s is prefixed", (fill) => {
    const out = parsed(clean(`<defs><linearGradient id="g"/></defs><rect width="1" height="1" fill="${fill}"/>`));
    expect(out.querySelector("[id=p1-g]")).not.toBeNull();
    expect(out.querySelector("rect")?.getAttribute("fill")).toBe("url(#p1-g)");
  });
  test("hexadecimal colors are left unchanged", () => {
    const rect = parsed(clean('<rect width="1" height="1" fill="#123456" stroke="#abc"/>')).querySelector("rect");
    expect(rect?.getAttribute("fill")).toBe("#123456");
    expect(rect?.getAttribute("stroke")).toBe("#abc");
  });
  test.each(["URL(#a)", 'Url( "#a" )', "url (#a)"])("prefixedReference(%s)", (value) => {
    expect(prefixedReference(value, "p1")).toBe("url(#p1-a)");
  });
});

describe("prefixedReference", () => {
  test.each([
    ["#a", "#p-a"],
    ["url(#a)", "url(#p-a)"],
    ["url( #a )", "url(#p-a)"],
    ["url('#a')", "url(#p-a)"],
    ['url("#a")', "url(#p-a)"],
    ["none", "none"],
    ["url(#a) url(#b)", "url(#p-a) url(#p-b)"],
  ])("%s", (value, expected) => {
    expect(prefixedReference(value, "p")).toBe(expected);
  });
});

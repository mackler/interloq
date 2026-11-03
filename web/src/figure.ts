// A question's picture as the page shows it (issue #98): an agent's SVG, sanitized here and nowhere else. An edge of the
// page, like web/src/markdown.ts: the sanitizer is a private DOMPurify instance made from the window by
// makeFigureSanitizer, its hook registered on that instance only; the imported DOMPurify singleton is never configured.
//
// The policy is written out, not inherited from DOMPurify's profiles: what is permitted is exactly what the two lists
// below hold. A picture is shapes, text and paint servers. DOMPurify's ALLOW_DATA_ATTR and ALLOW_ARIA_ATTR default to
// true and would admit every data-* and aria-* attribute beside the list (an aria-labelledby may name an id outside the
// picture, which the prefixing below does not rewrite), so both are turned off; the accessible name of a picture is its
// wrapper's aria-label in OptionFigure, never the SVG's own.
// - Excluded because they run code: script, every event-handler attribute, foreignObject (which hosts HTML).
// - Excluded because they fetch: image, feImage, an href or xlink:href that is not a reference inside the image, and
//   any url(...) or src(...) in an attribute value that does not name a fragment of the image.
// - Excluded because CSS may fetch or rewrite: the style element and the style attribute. A backslash in any attribute
//   value is refused, since a CSS escape can spell url( (u\72l(...)) and no permitted attribute needs one.
// - Excluded because they rewrite attributes after sanitizing: animate, animateMotion, animateTransform, set, discard.
// - Excluded because they navigate or embed: a, iframe. Filters are left out with every other element not listed.
//
// Ids are document-wide. Two pictures inlined in one page that both define id="shape" would let one picture's use or
// url(#shape) resolve to the other's definition, and the difference the question turns on would disappear. So every id
// of a picture is prefixed with its instance's prefix, and every reference inside it with the same prefix; a reference
// to an id the picture does not define then dangles within its own picture and never reaches another.
import DOMPurify, { type Config, type WindowLike } from "dompurify";

/** The elements a picture may hold: shapes, text and paint servers. */
export const FIGURE_ALLOWED_TAGS: readonly string[] = [
  "svg", "g", "defs", "title", "desc", "symbol", "use",
  "rect", "circle", "ellipse", "line", "polyline", "polygon", "path",
  "text", "tspan",
  "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern", "marker",
];
/** The attributes a picture may carry: geometry, paint and text presentation, and references inside the picture. */
export const FIGURE_ALLOWED_ATTRS: readonly string[] = [
  "xmlns", "xmlns:xlink", "viewBox", "preserveAspectRatio", "width", "height",
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "dx", "dy", "points", "d", "transform",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity",
  "font-family", "font-size", "font-weight", "font-style", "text-anchor", "dominant-baseline",
  "id", "href", "xlink:href",
  "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform",
  "clip-path", "clipPathUnits", "mask", "patternUnits", "patternTransform",
  "marker-start", "marker-mid", "marker-end", "markerWidth", "markerHeight", "refX", "refY", "orient", "markerUnits",
];

/** DOMPurify's name of a text node: a list of tags that leaves it out removes every text, a picture's labels included. */
const TEXT_NODE = "#text";
/** A url(...) or src(...) whose argument is not a fragment of the picture: it would fetch. */
const OUTSIDE_REFERENCE = /(?:url|src)\s*\((?!\s*['"]?\s*#)/iu;
/** A url(#id) in any case, quoting and whitespace, as CSS reads it. */
const FRAGMENT_URL = /url\s*\(\s*(['"]?)\s*#([^'")\s]+)\s*\1\s*\)/giu;
/** Whether an attribute may keep its value: references stay inside the picture, and nothing can spell a fetch. */
const keepsValue = (name: string, value: string): boolean => {
  if (value.includes("\\")) return false;
  if ((name === "href" || name === "xlink:href") && !value.startsWith("#")) return false;
  return !OUTSIDE_REFERENCE.test(value);
};
/** A paint or other attribute value with every url(#x) written url(#<prefix>-x); a color such as #123456 is unchanged. */
export const prefixedUrls = (value: string, prefix: string): string =>
  value.replace(FRAGMENT_URL, (_m, _q: string, id: string) => `url(#${prefix}-${id})`);
/** An href value with the instance's prefix: `#x` becomes `#<prefix>-x`; any other value as prefixedUrls writes it. */
export const prefixedReference = (value: string, prefix: string): string =>
  value.startsWith("#") ? `#${prefix}-${value.slice(1)}` : prefixedUrls(value, prefix);
/** An attribute's value with the instance's prefix: an id prefixed, an href as a reference, every other value's url(#…). */
const prefixedAttribute = (name: string, value: string, prefix: string): string =>
  name === "id" ? `${prefix}-${value}` : name === "href" || name === "xlink:href" ? prefixedReference(value, prefix) : prefixedUrls(value, prefix);

/** The whole sanitizing policy as DOMPurify's options: the two lists, text, and no attribute outside them. */
const FIGURE_SANITIZE_OPTIONS: Config & { readonly RETURN_DOM_FRAGMENT: true } = {
  ALLOWED_TAGS: [...FIGURE_ALLOWED_TAGS, TEXT_NODE],
  ALLOWED_ATTR: [...FIGURE_ALLOWED_ATTRS],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  KEEP_CONTENT: false,
  RETURN_DOM_FRAGMENT: true,
};

/** The sanitizer of a window: the picture's markup with the instance's prefix, or "" where its root is not svg. */
export const makeFigureSanitizer = (root: WindowLike): ((svg: string, prefix: string) => string) => {
  const purify = DOMPurify(root);
  purify.addHook("uponSanitizeAttribute", (_node, data) => {
    if (!keepsValue(data.attrName, data.attrValue)) data.keepAttr = false;
  });
  return (svg, prefix) => {
    const fragment = purify.sanitize(svg, FIGURE_SANITIZE_OPTIONS);
    const top = fragment.firstElementChild;
    if (top === null || top.tagName.toLowerCase() !== "svg") return "";
    for (const element of [top, ...top.querySelectorAll("*")]) {
      for (const attribute of [...element.attributes]) {
        const value = prefixedAttribute(attribute.name, attribute.value, prefix);
        if (value !== attribute.value) element.setAttribute(attribute.name, value);
      }
    }
    return top.outerHTML;
  };
};

/** The page's one figure sanitizer, made at the browser boundary when the module loads. */
export const sanitizeFigure: (svg: string, prefix: string) => string = makeFigureSanitizer(window);

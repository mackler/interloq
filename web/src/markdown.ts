// Markdown of the agents, rendered and sanitised in the browser (decision Q1: marked + dompurify).
// An edge of the page (finding 14 of docs/gui-review.md): the sanitizer is a private instance made from the window
// by `makeRenderer`, and its link hook is registered on that instance only; the imported DOMPurify singleton is never
// configured, so no other consumer of the library is affected.

import DOMPurify, { type WindowLike } from "dompurify";
import { marked } from "marked";

/** A renderer over its own sanitizer: marked's output with every script, event handler and unsafe URL removed. */
export const makeRenderer = (root: WindowLike): ((markdown: string) => string) => {
  const purify = DOMPurify(root);
  // Every link leaves the page without access to it.
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  return (markdown) => purify.sanitize(marked.parse(markdown, { async: false, gfm: true }), { ADD_ATTR: ["target"] });
};

/**
 * The elements a plain piece of a question may produce (decision Q2 of the task of issue #36): inline formatting only.
 * A block an agent writes into a piece (a paragraph, a list, a heading, a table, raw HTML) is removed and its text
 * kept, so a piece never opens a block inside the paragraph that holds it.
 */
export const INLINE_TAGS: readonly string[] = ["em", "strong", "code", "a", "del", "br"];
/**
 * A renderer of one plain piece over its own sanitizer: marked's inline output, allowed only INLINE_TAGS. Each piece is
 * rendered on its own, so an emphasis left open in one piece cannot format the next.
 */
export const makeInlineRenderer = (root: WindowLike): ((markdown: string) => string) => {
  const purify = DOMPurify(root);
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  return (markdown) => purify.sanitize(marked.parseInline(markdown, { async: false, gfm: true }), { ALLOWED_TAGS: [...INLINE_TAGS], ALLOWED_ATTR: ["href", "title", "target", "rel"], KEEP_CONTENT: true });
};

/** HTML for `{@html}`: the page's one renderer, made at the browser boundary when the module loads. */
export const render: (markdown: string) => string = makeRenderer(window);
/** HTML for `{@html}` of one plain piece: the page's inline renderer. */
export const renderInline: (markdown: string) => string = makeInlineRenderer(window);

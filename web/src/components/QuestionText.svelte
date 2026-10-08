<script lang="ts">
  // A question's text as the agent wrote it (issue #36, S13 of its task): blocks and pieces, rendered directly, so that
  // nothing is searched for and nothing is converted after sanitizing. A paragraph, a list nested by level, a code block
  // shown exactly, the program's own document as whole Markdown; within them a plain piece is inline Markdown only
  // (renderInline: its own sanitizer, inline elements only), a code piece its text exactly, and a piece that refers to an
  // explanation a focusable word that carries it. One TermTooltip opens on hover and on keyboard focus of such a word;
  // Escape or leaving closes it [recognition rather than recall: the explanation is where the word is read; help and
  // documentation]. S42: Tab on the word enters the tooltip, Tab there leaves past the word, Shift+Tab and Escape return
  // to it. The explanation costs no space until the reader asks for it: there is no list of terms beside the question.
  import type { ShownExplanation } from "../../../src/question.ts";
  import { type Attached, normalizedRuns, type Piece, type RunItem, type ShownBlock } from "../../../src/pieces.ts";
  import { render, renderInline } from "../markdown.ts";
  import { TOOLTIP_GRACE_MS } from "../time.ts";
  import TermTooltip from "./TermTooltip.svelte";
  import { focusablesOf, nextFocusable } from "../focus.ts";

  type Props = { blocks?: readonly ShownBlock[]; pieces?: readonly Piece[]; explanations: readonly ShownExplanation[]; class?: string };
  let { blocks, pieces, explanations, class: className = "" }: Props = $props();
  // The open tooltip: its anchor, a word that refers to an explanation, and that explanation.
  let open = $state<{ anchor: HTMLElement; ref: string } | null>(null);
  const id = `term-tip-${Math.random().toString(36).slice(2)}`;
  let leaving: ReturnType<typeof setTimeout> | null = null;
  const stay = () => {
    if (leaving !== null) clearTimeout(leaving);
    leaving = null;
  };
  // The timer is the component's edge: cleared when the component is destroyed.
  $effect(() => stay);
  const anchorOf = (target: EventTarget | null): HTMLElement | null => (target instanceof HTMLElement ? target.closest<HTMLElement>(".term") : null);
  const show = (anchor: HTMLElement | null) => {
    if (anchor === null || anchor.dataset.ref === undefined) return;
    stay();
    open?.anchor.removeAttribute("aria-describedby");
    anchor.setAttribute("aria-describedby", id);
    open = { anchor, ref: anchor.dataset.ref };
  };
  const entries = $derived(open === null ? [] : explanations.filter((e) => e.id === open?.ref).slice(0, 1));
  const close = () => {
    stay();
    open?.anchor.removeAttribute("aria-describedby");
    open = null;
  };
  // S42 (W2-R1-5, P3-R1-3): the tooltip is rendered in the document's body, so the natural tab order would pass it by.
  // Focus is routed as for a disclosure: Tab on a word whose tooltip is open enters the tooltip; Tab there leaves to what
  // follows the word (never back into the tooltip); Shift+Tab and Escape there return to the word, which then does not
  // reopen it.
  const tipElement = (): HTMLElement | null => document.getElementById(id);
  let returning: HTMLElement | null = null;
  const onFocusIn = (target: EventTarget | null) => {
    const anchor = anchorOf(target);
    if (anchor !== null && anchor === returning) {
      returning = null;
      return;
    }
    returning = null;
    show(anchor);
  };
  const onFocusOut = (e: FocusEvent) => {
    if (anchorOf(e.target) === null) return;
    const to = e.relatedTarget;
    const tip = tipElement();
    if (to instanceof Node && (to === open?.anchor || (tip !== null && tip.contains(to)))) return;
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") return close();
    if (e.key !== "Tab" || e.shiftKey || open === null || e.target !== open.anchor) return;
    const tip = tipElement();
    if (tip === null) return;
    e.preventDefault();
    stay();
    tip.focus();
  };
  const toAnchor = () => {
    const anchor = open?.anchor ?? null;
    close();
    if (anchor === null) return;
    returning = anchor;
    anchor.focus();
  };
  const past = (e: KeyboardEvent) => {
    const anchor = open?.anchor ?? null;
    const tip = tipElement();
    if (anchor === null || tip === null) return close();
    const target = nextFocusable(focusablesOf(document), anchor, (el) => tip.contains(el));
    if (target === null) return close();
    e.preventDefault();
    close();
    target.focus();
  };
  const leaveTip = (e: FocusEvent) => {
    const to = e.relatedTarget;
    const tip = tipElement();
    if (to instanceof Node && (to === open?.anchor || (tip !== null && tip.contains(to)))) return;
    close();
  };
  const leave = () => {
    stay();
    leaving = setTimeout(close, TOOLTIP_GRACE_MS);
  };
  /**
   * A run of lists nested by their levels (normalizedRuns of src/pieces.ts): each item with the blocks that interrupt the
   * list after it (a multi-line value, its escapes note; W2-R1-1, P3-R1-1) and the items that follow it at a deeper level.
   */
  type Tree = { pieces: readonly Piece[]; attached: readonly Attached[]; children: Tree[] };
  const nest = (items: readonly RunItem[]): Tree[] => {
    const root: Tree[] = [];
    const stack: { level: number; children: Tree[] }[] = [{ level: -1, children: root }];
    for (const item of items) {
      while (stack.length > 1 && stack[stack.length - 1].level >= item.level) stack.pop();
      const node: Tree = { pieces: item.pieces, attached: item.attached, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push({ level: item.level, children: node.children });
    }
    return root;
  };
</script>

<!-- A word that refers to an explanation takes focus, so that its explanation is reached by keyboard (S42): the anchor
     of a tooltip, as TermTooltip is focusable for scrolling. -->
{#snippet line(ps: readonly Piece[])}{#each ps as p, i (i)}{#if p.ref !== "" && !p.code}<!-- svelte-ignore a11y_no_noninteractive_tabindex --><span class="term" data-ref={p.ref} tabindex="0">{p.text}</span>{:else if p.code}{#if p.ref !== ""}<!-- svelte-ignore a11y_no_noninteractive_tabindex --><code class="term" data-ref={p.ref} tabindex="0">{p.text}</code>{:else}<code>{p.text}</code>{/if}{:else}{@html renderInline(p.text)}{/if}{/each}{/snippet}
{#snippet attachedBlock(block: Attached)}{#if block.kind === "paragraph"}<p>{@render line(block.pieces)}</p>{:else}<pre><code>{block.text}</code></pre>{/if}{/snippet}
{#snippet tree(nodes: readonly Tree[])}<ul>{#each nodes as node, i (i)}<li>{@render line(node.pieces)}{#each node.attached as block, j (j)}{@render attachedBlock(block)}{/each}{#if node.children.length > 0}{@render tree(node.children)}{/if}</li>{/each}</ul>{/snippet}

<svelte:element
  this={pieces !== undefined ? "span" : "div"}
  class="qtext {className}"
  role="presentation"
  onmouseover={(e: MouseEvent) => show(anchorOf(e.target))}
  onmouseout={(e: MouseEvent) => anchorOf(e.target) !== null && leave()}
  onfocusin={(e: FocusEvent) => onFocusIn(e.target)}
  onfocusout={onFocusOut}
  onkeydown={onKey}
  >{#if pieces !== undefined}{@render line(pieces)}{:else}{#each normalizedRuns(blocks ?? []) as block, i (i)}{#if block.kind === "paragraph"}<p>{@render line(block.pieces)}</p>{:else if block.kind === "list"}{@render tree(nest(block.items))}{:else if block.kind === "code"}<pre><code>{block.text}</code></pre>{:else}<div class="document">{@html render(block.markdown)}</div>{/if}{/each}{/if}</svelte:element>{#if open !== null && entries.length > 0}<TermTooltip {id} {entries} anchor={open.anchor} onEnter={stay} onLeave={leave} onReturn={toAnchor} onPast={past} onFocusOut={leaveTip} />{/if}

<style>
  /* A sentence of pieces sits in its line box as the text around it does, so that it adds no height of its own. */
  span.qtext { vertical-align: top; }
  .qtext :global(.term) { text-decoration: underline dotted; text-underline-offset: 0.2em; cursor: help; border-radius: var(--m3-shape-extra-small, 4px); }
  .qtext :global(.term:focus-visible) { outline: 2px solid var(--m3c-secondary); outline-offset: 2px; }
  .qtext :global(p:first-child), .qtext :global(ul:first-child), .qtext :global(pre:first-child) { margin-top: 0; }
  .qtext :global(p:last-child), .qtext :global(ul:last-child), .qtext :global(pre:last-child) { margin-bottom: 0; }
  .qtext :global(pre) { overflow-x: auto; }
</style>

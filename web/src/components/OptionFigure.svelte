<script lang="ts">
  // An option's picture on its card (issue #98, requirements Q1): drawn under the option's label and description, the
  // card's full width with its height following the picture's aspect ratio, shrinking with its card in a narrow window.
  // Its markup is shown only through sanitizeFigure of web/src/figure.ts, with a prefix unique to this instance, so that
  // the ids of several pictures on one page never meet. A screen reader reads the alt text; the picture's own text is
  // hidden from it. Where the sanitizer leaves nothing, the alt text is shown in its place.
  // A span styled as a block, since the card is a button and may hold only phrasing content.
  import type { Figure } from "../../../src/figure.ts";
  import { sanitizeFigure } from "../figure.ts";

  type Props = { figure: Figure };
  let { figure }: Props = $props();
  const prefix = $props.id();
  const markup = $derived(sanitizeFigure(figure.svg, prefix));
</script>

<span class="figure" role="img" aria-label={figure.alt} data-option-figure>
  {#if markup === ""}{figure.alt}{:else}<span class="drawing" aria-hidden="true">{@html markup}</span>{/if}
</span>

<style>
  .figure { display: block; margin-block-start: 0.5rem; max-width: 100%; }
  .drawing { display: block; }
  .figure :global(svg) { display: block; width: 100%; height: auto; max-width: 100%; }
</style>

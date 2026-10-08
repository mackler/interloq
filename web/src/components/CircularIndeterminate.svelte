<script lang="ts">
  // Issue #50: M3's indeterminate circular progress indicator, by hand (m3-svelte has none): an arc that turns without
  // end, no value; since issue #89 at a fixed length, the rotation alone (web/src/theme.css). It takes the place of a running step's mark, in the mark's box, so it says "this
  // step is being worked on" on the step itself and nothing about how much remains. With reduced motion it is the static
  // glyph (web/src/theme.css).
  type Props = { label: string; glyph: string };
  let { label, glyph }: Props = $props();
</script>

<span class="circular-indeterminate" role="progressbar" aria-label={label}>
  <svg viewBox="0 0 24 24" aria-hidden="true"><circle class="track" cx="12" cy="12" r="9" /><circle class="arc" cx="12" cy="12" r="9" /></svg>
  <span class="glyph" data-glyph aria-hidden="true">{glyph}</span>
</span>

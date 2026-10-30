<script lang="ts">
  // Issue #131 (requirements Q4): the switch that lets Interloq prepare the marked items' questions unattended, above the
  // Refinement tab's list, symmetric with the chain's control on the Implementation tab: M3's switch and one status line.
  // It asks no confirmation (behavior 1) and asserts only what the status says: off, preparing an item, nothing left, or
  // why the marked items could not be listed [visibility of system status]. No cost appears.
  import { Switch } from "m3-svelte";
  import { PREPARATION_SWITCH_LABEL, preparationStatusText } from "../../../src/prompts.ts";
  import type { PreparationView } from "../../../src/preparationSwitch.ts";

  let { view, onChange }: { view: PreparationView; onChange: (enabled: boolean) => void } = $props();
</script>

<section class="preparation" aria-label={PREPARATION_SWITCH_LABEL}>
  <label class="switch m3-font-label-large"><Switch name="preparation" checked={view.settings.enabled} onchange={(e: Event) => onChange((e.currentTarget as HTMLInputElement).checked)} />{PREPARATION_SWITCH_LABEL}</label>
  <p class="status m3-font-body-medium" role="status">{preparationStatusText(view.status)}</p>
</section>

<style>
  .preparation { display: flex; flex-direction: column; gap: 0.5rem; max-width: 56rem; width: 100%; margin: 1rem auto 0; padding: 0.75rem 1rem; box-sizing: border-box; border-radius: var(--m3-shape-medium, 12px); background: var(--m3c-surface-container-low); color: var(--m3c-on-surface); }
  .switch { display: flex; align-items: center; gap: 0.75rem; }
  .status { margin: 0; overflow-wrap: anywhere; }
</style>

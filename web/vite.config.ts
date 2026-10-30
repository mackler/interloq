// The browser build of the web GUI and its component tests. Every path is relative to `root`, this directory:
// `npm run build` writes web/dist (the server refuses to start without web/dist/index.html), and Vitest finds
// the tests under src/.
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { functionsMixins } from "vite-plugin-functions-mixins";
import { defineConfig } from "vitest/config";

/** The components whose CSS Vitest injects, so that jsdom computes their styles. */
const INJECTED_CSS = ["TimelineRail.svelte", "ItemList.svelte", "ScrollableTabs.svelte"];

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // m3-svelte writes its styles with CSS @function and @mixin, which this plugin resolves at build time.
  // Under Vitest, the progress rail's styles are injected with the component, so that jsdom computes its indentation
  // (issue #116), and so are the item list's, so that the tests read its rows' real CSS (issue #125), and so are the scrollable tabs', so that the tests read the CSS that lets the row scroll
  // sideways (issue #202); every other
  // component's CSS stays out of the tests, as before.
  plugins: [
    svelte(process.env.VITEST ? { dynamicCompileOptions: ({ filename }) => (INJECTED_CSS.some((name) => filename.endsWith(`/${name}`)) ? { css: "injected" } : undefined) } : {}),
    functionsMixins({ deps: ["m3-svelte"] }),
  ],
  build: { outDir: "dist", emptyOutDir: true },
  // Under Vitest, Svelte's browser build, so that components can be mounted in jsdom.
  resolve: process.env.VITEST ? { conditions: ["browser"] } : undefined,
  // testTimeout sized for a loaded machine (a shared CI runner): a passing test is no slower, only a hang reports later.
  // It is 120 s because under npm test's load two property tests took 41 s and 51 s (the suite run of 18 Oct 2026 in
  // issue #172's implementation run), past the earlier 30 s.
  // maxWorkers is half the cores because npm test runs this stage beside the others, and Vitest waits only a fixed 60 s
  // for a forked worker to start, which a fork per core missed under that load (the suite run of 18 Oct 2026 in issue
  // #172's implementation run); testTimeout does not govern that wait. test/ci.test.ts checks it is set here alone.
  test: { environment: "jsdom", include: ["src/**/*.test.ts"], setupFiles: ["src/test-setup.ts"], testTimeout: 120_000, maxWorkers: "50%" },
});

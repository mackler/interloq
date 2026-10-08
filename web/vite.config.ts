// The browser build of the web GUI and its component tests. Every path is relative to `root`, this directory:
// `npm run build` writes web/dist (the server refuses to start without web/dist/index.html), and Vitest finds
// the tests under src/.
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { functionsMixins } from "vite-plugin-functions-mixins";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // m3-svelte writes its styles with CSS @function and @mixin, which this plugin resolves at build time.
  // Under Vitest, the progress rail's styles are injected with the component, so that jsdom computes its indentation
  // (issue #116); every other component's CSS stays out of the tests, as before.
  plugins: [
    svelte(process.env.VITEST ? { dynamicCompileOptions: ({ filename }) => (filename.endsWith("/TimelineRail.svelte") ? { css: "injected" } : undefined) } : {}),
    functionsMixins({ deps: ["m3-svelte"] }),
  ],
  build: { outDir: "dist", emptyOutDir: true },
  // Under Vitest, Svelte's browser build, so that components can be mounted in jsdom.
  resolve: process.env.VITEST ? { conditions: ["browser"] } : undefined,
  // testTimeout sized for a loaded machine (a shared CI runner): a passing test is no slower, only a hang reports later.
  test: { environment: "jsdom", include: ["src/**/*.test.ts"], setupFiles: ["src/test-setup.ts"], testTimeout: 30_000 },
});

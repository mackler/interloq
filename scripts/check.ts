// `npm run check` (issue #105): the three type checks share nothing, so they run together. Each one's output is
// printed whole when it ends, a failure of one does not stop the others, and the exit code is 1 if any failed.

import { fileURLToPath } from "node:url";
import { report, runStages, spawnStage, type Stage, type Stages, summary } from "./test-all.ts";

const stage = (script: string): Stage => ({ name: script, script });
/** The program's configuration, the page's, and the `.svelte` components. */
export const checkStages: Stages = { kind: "parallel", parallel: [stage("check:program"), stage("check:web"), stage("check:svelte")] };

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  void runStages(checkStages, spawnStage(npm, (s) => ["run", "--silent", s.script]), report).then((outcome) => {
    process.stdout.write(`\n${summary("npm run check", outcome)}\n`);
    process.exitCode = outcome.code;
  });
}

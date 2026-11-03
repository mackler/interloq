// Issue #39: a Node test reporter that prints nothing and, where INTERLOQ_STAGE_REPORT_DIR names a directory, writes
// there `node-test.json`, the counts of the run's final test:summary event (the one with no file; Node emits one per
// file and one for the run). `npm run test:unit` adds it beside the spec reporter, so its printed output is unchanged;
// src/runnerCounts.ts's nodeTestCounts reads the file.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestEvent } from "node:test/reporters";
import { STAGE_REPORT_VARIABLE } from "../src/runnerCounts.ts";

export const NODE_TEST_REPORT = "node-test.json";

export default async function* nodeTestCounts(source: AsyncIterable<TestEvent>): AsyncGenerator<string, void> {
  const dir = process.env[STAGE_REPORT_VARIABLE];
  for await (const event of source) {
    if (event.type !== "test:summary" || event.data.file !== undefined || dir === undefined || dir === "") continue;
    // The counts whole: Node 26 gives `failed` beside the fields @types/node declares, and nodeTestCounts decodes them.
    writeFileSync(join(dir, NODE_TEST_REPORT), `${JSON.stringify(event.data.counts)}\n`);
  }
}

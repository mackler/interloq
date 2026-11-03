// A fake of the process boundary of scripts/test-all.ts, shared by the tests of npm test and npm run check (issue #105).

import assert from "node:assert/strict";
import { type Stage, type StageResult, stageReport } from "../scripts/test-all.ts";

/** A fake process boundary whose stages end only when the test ends them. */
export const controlled = () => {
  const started: string[] = [];
  const pending = new Map<string, (code: number, reportText: string | null) => void>();
  const start = (stage: Stage): Promise<StageResult> =>
    new Promise((resolve) => {
      started.push(stage.name);
      pending.set(stage.name, (code, reportText) => resolve({ stage, code, output: `${stage.name} output`, report: stageReport(stage, code, reportText) }));
    });
  /** Ends a stage with its exit code and the text of its runner's report, or none. */
  const end = async (name: string, code: number, reportText: string | null = null) => {
    const resolve = pending.get(name);
    assert.ok(resolve !== undefined, `${name} was not started`);
    pending.delete(name);
    resolve(code, reportText);
    await new Promise((r) => setImmediate(r));
  };
  return { started, start, end };
};
export const tick = () => new Promise((r) => setImmediate(r));

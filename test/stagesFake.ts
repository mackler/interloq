// A fake of the process boundary of scripts/test-all.ts, shared by the tests of npm test and npm run check (issue #105).

import assert from "node:assert/strict";
import type { Stage, StageResult } from "../scripts/test-all.ts";

/** A fake process boundary whose stages end only when the test ends them. */
export const controlled = () => {
  const started: string[] = [];
  const pending = new Map<string, (code: number) => void>();
  const start = (stage: Stage): Promise<StageResult> =>
    new Promise((resolve) => {
      started.push(stage.name);
      pending.set(stage.name, (code) => resolve({ stage, code, output: `${stage.name} output` }));
    });
  const end = async (name: string, code: number) => {
    const resolve = pending.get(name);
    assert.ok(resolve !== undefined, `${name} was not started`);
    pending.delete(name);
    resolve(code);
    await new Promise((r) => setImmediate(r));
  };
  return { started, start, end };
};
export const tick = () => new Promise((r) => setImmediate(r));

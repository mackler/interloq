import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Result } from "effect";
import { decodeConfigText, mergeConfig } from "../src/config.ts";
import { excluded } from "../src/snapshot.ts";

// Issue #77: the incremental type check writes a build info file during a check, and a check runs inside planning and
// execution calls. The project snapshot must not see it, or the guards of behaviours 3 and 5 halt the run. Two
// independent protections: ignorePaths (what `excluded` applies) and .gitignore (git status never lists the file).
const root = path.resolve(import.meta.dirname, "..");
const configs = ["tsconfig.json", "web/tsconfig.json"] as const;

/** The build info file of a TypeScript configuration, relative to the repository root; TypeScript's default where unset. */
const buildInfoOf = (config: string): string => {
  const json = JSON.parse(fs.readFileSync(path.join(root, config), "utf8")) as { compilerOptions?: { tsBuildInfoFile?: string } };
  const dir = path.dirname(path.join(root, config));
  const file = json.compilerOptions?.tsBuildInfoFile ?? "tsconfig.tsbuildinfo";
  return path.relative(root, path.resolve(dir, file)).split(path.sep).join("/");
};

const decoded = (file: string): Partial<ReturnType<typeof mergeConfig>> => {
  const result = decodeConfigText(file, fs.readFileSync(file, "utf8"));
  assert.ok(Result.isSuccess(result), `${file} does not decode`);
  return result.success;
};

const ownConfig = path.join(root, "plan-review", "config.json");

for (const config of configs) {
  test(`the build info file of ${config} is excluded from the project snapshot by the ignorePaths a run here uses`, (t) => {
    if (!fs.existsSync(ownConfig)) {
      t.skip("plan-review/config.json does not exist on this machine (as in CI): there is no run's configuration to check");
      return;
    }
    const sharedFile = path.join(root, "config.json");
    const ignorePaths = mergeConfig(fs.existsSync(sharedFile) ? decoded(sharedFile) : {}, decoded(ownConfig)).ignorePaths;
    const file = buildInfoOf(config);
    assert.ok(excluded(file, ignorePaths), `${file} is not excluded by ignorePaths ${JSON.stringify(ignorePaths)}`);
  });

  test(`the build info file of ${config} is ignored by git`, () => {
    const file = buildInfoOf(config);
    const result = spawnSync("git", ["check-ignore", "-q", "--no-index", file], { cwd: root });
    assert.equal(result.status, 0, `${file} is not ignored by git`);
  });
}

import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { claudeEnv } from "../src/claude.ts";

// Issue #78: the environment of a Claude Code call keeps every inherited entry except BASH_MAX_TIMEOUT_MS, which it sets.
const KEY = "BASH_MAX_TIMEOUT_MS";
test("property: claudeEnv keeps every inherited entry but the ceiling's, and sets the ceiling as a decimal string", () => {
  fc.assert(
    fc.property(fc.dictionary(fc.oneof(fc.string(), fc.constant(KEY)), fc.option(fc.string(), { nil: undefined })), fc.integer({ min: 1, max: 2 ** 31 }), (inherited, ceiling) => {
      const env = claudeEnv(inherited, ceiling);
      assert.equal(env[KEY], String(ceiling));
      for (const [k, v] of Object.entries(inherited)) if (k !== KEY) assert.equal(env[k], v);
      assert.deepEqual(Object.keys(env).sort(), [...new Set([...Object.keys(inherited), KEY])].sort());
    }),
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { GITHUB_TOKEN_VARIABLE, TRELLO_KEY_VARIABLE, TRELLO_TOKEN_VARIABLE, githubCredential, trelloCredential } from "../src/trackerConfig.ts";

// Issue #120, part 1: the tracker's credential comes from the environment, given as a parameter; an absent or blank
// variable is refused with its name and never a value.

test("an absent or blank variable is TrackerCredentialMissing naming the variable", () => {
  for (const env of [{}, { [GITHUB_TOKEN_VARIABLE]: "" }, { [GITHUB_TOKEN_VARIABLE]: "  \n" }, { [GITHUB_TOKEN_VARIABLE]: undefined }]) {
    const result = githubCredential(env);
    assert.ok(Result.isFailure(result), JSON.stringify(env));
    assert.equal(result.failure._tag, "TrackerCredentialMissing");
    assert.equal(result.failure.variable, "INTERLOQ_GITHUB_TOKEN");
  }
});

test("a set variable is the token", () => {
  const result = githubCredential({ [GITHUB_TOKEN_VARIABLE]: "github_pat_x", OTHER: "y" });
  assert.ok(Result.isSuccess(result));
  assert.equal(result.success, "github_pat_x");
});

// The Trello tracker's key and token travel together: one absent or blank is refused with that variable's name.
const KEY = { [TRELLO_KEY_VARIABLE]: "trello-key" };
const TOKEN = { [TRELLO_TOKEN_VARIABLE]: "trello-token" };

test("a Trello key or token absent or blank is TrackerCredentialMissing naming that variable, the key first", () => {
  const cases: ReadonlyArray<[Readonly<Record<string, string | undefined>>, string]> = [
    [TOKEN, "INTERLOQ_TRELLO_KEY"],
    ...["", "  ", "\n"].map((blank): [Readonly<Record<string, string>>, string] => [{ ...TOKEN, [TRELLO_KEY_VARIABLE]: blank }, "INTERLOQ_TRELLO_KEY"]),
    [KEY, "INTERLOQ_TRELLO_TOKEN"],
    ...["", "  ", "\n"].map((blank): [Readonly<Record<string, string>>, string] => [{ ...KEY, [TRELLO_TOKEN_VARIABLE]: blank }, "INTERLOQ_TRELLO_TOKEN"]),
    [{}, "INTERLOQ_TRELLO_KEY"],
  ];
  for (const [env, variable] of cases) {
    const result = trelloCredential(env);
    assert.ok(Result.isFailure(result), JSON.stringify(env));
    assert.equal(result.failure._tag, "TrackerCredentialMissing");
    assert.equal(result.failure.variable, variable, JSON.stringify(env));
  }
});

test("a Trello key and token both set are the credential", () => {
  const result = trelloCredential({ ...KEY, ...TOKEN, OTHER: "y" });
  assert.ok(Result.isSuccess(result));
  assert.deepEqual(result.success, { key: "trello-key", token: "trello-token" });
});

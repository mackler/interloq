import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { GITHUB_TOKEN_VARIABLE, GITLAB_TOKEN_VARIABLE, githubCredential, gitlabCredential } from "../src/trackerConfig.ts";

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

// The GitLab tracker's token (the GitLab adapter, requirement Q1): an absent or blank variable is refused with its name.
test("an absent or blank INTERLOQ_GITLAB_TOKEN is TrackerCredentialMissing naming the variable", () => {
  for (const env of [{}, { [GITLAB_TOKEN_VARIABLE]: "" }, { [GITLAB_TOKEN_VARIABLE]: "  " }, { [GITLAB_TOKEN_VARIABLE]: "\n" }, { [GITLAB_TOKEN_VARIABLE]: undefined }]) {
    const result = gitlabCredential(env);
    assert.ok(Result.isFailure(result), JSON.stringify(env));
    assert.equal(result.failure._tag, "TrackerCredentialMissing");
    assert.equal(result.failure.variable, "INTERLOQ_GITLAB_TOKEN");
  }
});

test("a set INTERLOQ_GITLAB_TOKEN is the token, other variables ignored", () => {
  const result = gitlabCredential({ [GITLAB_TOKEN_VARIABLE]: "glpat-x", [GITHUB_TOKEN_VARIABLE]: "github_pat_x", OTHER: "y" });
  assert.ok(Result.isSuccess(result));
  assert.equal(result.success, "glpat-x");
});

// The tracker's credentials (issue #120, part 1): one per tracker, read from an environment given as a parameter, so
// that no module but the live binding (src/trackerLive.ts) mentions process.env. Pure. No credential is a config key.
import { type Brand, Result } from "effect";
import { TrackerCredentialMissing } from "./errors.ts";

/** The GitHub tracker's bearer token: a fine-grained token with Issues read and write on the project's repository. */
export const GITHUB_TOKEN_VARIABLE = "INTERLOQ_GITHUB_TOKEN";
/**
 * The GitLab tracker's token: a project access token of the one GitLab project, with the `api` scope and the Planner
 * role (the developer's answer Q1 in the requirements of the GitLab adapter); read by gitlabCredential.
 */
export const GITLAB_TOKEN_VARIABLE = "INTERLOQ_GITLAB_TOKEN";

/** A GitHub token: a text with a character other than whitespace, built by githubCredential alone. */
export type GithubToken = Brand.Branded<string, "GithubToken">;
/** A GitLab token: a text with a character other than whitespace, built by gitlabCredential alone. */
export type GitlabToken = Brand.Branded<string, "GitlabToken">;
export type Environment = Readonly<Record<string, string | undefined>>;

/** A variable's value when it is set and not blank; otherwise the failure naming the variable, never a value. */
const nonBlankVariable = (env: Environment, variable: string): Result.Result<string, TrackerCredentialMissing> => {
  const value = env[variable];
  return value === undefined || value.trim() === "" ? Result.fail(new TrackerCredentialMissing({ variable })) : Result.succeed(value);
};

/** The GitHub token from the environment; an absent or blank variable is refused with its name. */
export const githubCredential = (env: Environment): Result.Result<GithubToken, TrackerCredentialMissing> => Result.map(nonBlankVariable(env, GITHUB_TOKEN_VARIABLE), (value) => value as GithubToken);

/** The GitLab token from the environment; an absent or blank variable is refused with its name. */
export const gitlabCredential = (env: Environment): Result.Result<GitlabToken, TrackerCredentialMissing> => Result.map(nonBlankVariable(env, GITLAB_TOKEN_VARIABLE), (value) => value as GitlabToken);

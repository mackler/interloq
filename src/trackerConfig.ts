// The tracker's credentials (issue #120, part 1): one per tracker, read from an environment given as a parameter, so
// that no module but the live binding (src/trackerLive.ts) mentions process.env. Pure. No credential is a config key.
import { type Brand, Result } from "effect";
import { TrackerCredentialMissing } from "./errors.ts";

/** The GitHub tracker's bearer token: a fine-grained token with Issues read and write on the project's repository. */
export const GITHUB_TOKEN_VARIABLE = "INTERLOQ_GITHUB_TOKEN";
/** The Trello tracker's API key and token, for the Trello adapter of a later task; nothing reads them yet. */
export const TRELLO_KEY_VARIABLE = "INTERLOQ_TRELLO_KEY";
export const TRELLO_TOKEN_VARIABLE = "INTERLOQ_TRELLO_TOKEN";

/** A GitHub token: a text with a character other than whitespace, built by githubCredential alone. */
export type GithubToken = Brand.Branded<string, "GithubToken">;
export type Environment = Readonly<Record<string, string | undefined>>;

/** The GitHub token from the environment; an absent or blank variable is refused with its name. */
export const githubCredential = (env: Environment): Result.Result<GithubToken, TrackerCredentialMissing> => {
  const value = env[GITHUB_TOKEN_VARIABLE];
  return value === undefined || value.trim() === "" ? Result.fail(new TrackerCredentialMissing({ variable: GITHUB_TOKEN_VARIABLE })) : Result.succeed(value as GithubToken);
};

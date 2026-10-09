// The tracker's credentials (issue #120, part 1): one per tracker, read from an environment given as a parameter, so
// that no module but the live binding (src/trackerLive.ts) mentions process.env. Pure. No credential is a config key.
import { type Brand, Result } from "effect";
import { TrackerCredentialMissing } from "./errors.ts";

/** The GitHub tracker's bearer token: a fine-grained token with Issues read and write on the project's repository. */
export const GITHUB_TOKEN_VARIABLE = "INTERLOQ_GITHUB_TOKEN";
/** The Trello tracker's API key and token, with read and write scope on the board; read by trelloCredential. */
export const TRELLO_KEY_VARIABLE = "INTERLOQ_TRELLO_KEY";
export const TRELLO_TOKEN_VARIABLE = "INTERLOQ_TRELLO_TOKEN";

/** A GitHub token: a text with a character other than whitespace, built by githubCredential alone. */
export type GithubToken = Brand.Branded<string, "GithubToken">;
/** A Trello API key and a Trello token: texts with a character other than whitespace, built by trelloCredential alone. */
export type TrelloKey = Brand.Branded<string, "TrelloKey">;
export type TrelloToken = Brand.Branded<string, "TrelloToken">;
/** The key and the token together, since Trello needs both on every request. */
export type TrelloCredential = Readonly<{ key: TrelloKey; token: TrelloToken }>;
export type Environment = Readonly<Record<string, string | undefined>>;

/** A variable's value when it is set and not blank; otherwise the failure naming the variable, never a value. */
const nonBlankVariable = (env: Environment, variable: string): Result.Result<string, TrackerCredentialMissing> => {
  const value = env[variable];
  return value === undefined || value.trim() === "" ? Result.fail(new TrackerCredentialMissing({ variable })) : Result.succeed(value);
};

/** The GitHub token from the environment; an absent or blank variable is refused with its name. */
export const githubCredential = (env: Environment): Result.Result<GithubToken, TrackerCredentialMissing> => Result.map(nonBlankVariable(env, GITHUB_TOKEN_VARIABLE), (value) => value as GithubToken);

/** The Trello key and token from the environment; the key is read first, and an absent or blank variable is refused with its name. */
export const trelloCredential = (env: Environment): Result.Result<TrelloCredential, TrackerCredentialMissing> =>
  Result.flatMap(nonBlankVariable(env, TRELLO_KEY_VARIABLE), (key) => Result.map(nonBlankVariable(env, TRELLO_TOKEN_VARIABLE), (token) => ({ key: key as TrelloKey, token: token as TrelloToken })));

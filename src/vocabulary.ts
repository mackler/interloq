/**
 * The program's own words, and the substitutes a question must not write for them (issue #166, the developer's
 * instruction of 19 Oct 2026: "I want the questions to avoid made-up terms like 'build' for implemented"). Pure, with
 * no imports, so that `src/prompts.ts` and `src/question.ts` both read it without an import cycle; each entry's names
 * are literals here, and `test/vocabulary.test.ts` checks them against their sources.
 */

/** Where a name of the program comes from. */
export type VocabularySource = "itemState" | "runMode" | "phase" | "executionStatus" | "disposition";

/** One of the program's names for a thing, with the substitutes a question must not write for it. */
export type ProgramWord = Readonly<{
  source: VocabularySource;
  names: readonly [string, ...string[]];
  substitutes: readonly [string, ...string[]];
}>;

export const PROGRAM_WORDS: readonly ProgramWord[] = [
  {
    source: "itemState",
    names: ["implementing", "implemented"],
    substitutes: ["build", "builds", "building", "built", "being built", "partly built"],
  },
];

/** A substitute found in a text: the text as it stands, and the names the program has for it. */
export type SubstituteFound = Readonly<{ found: string; names: ProgramWord["names"] }>;

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every substitute of the table, longest first, so that a phrase is matched before a word inside it. */
const LISTED: readonly Readonly<{ substitute: string; names: ProgramWord["names"] }>[] = PROGRAM_WORDS.flatMap((w) =>
  w.substitutes.map((substitute) => ({ substitute, names: w.names })),
).sort((a, b) => b.substitute.length - a.substitute.length);

/** One alternation of every substitute, a phrase's spaces matching any run of whitespace, never inside a longer word or identifier (a letter, digit or underscore on either side is no match). */
const PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${LISTED.map((l) => l.substitute.split(" ").map(escaped).join("\\s+")).join("|")})(?![\\p{L}\\p{N}_])`,
  "giu",
);

const namesOf = (found: string): ProgramWord["names"] | undefined => {
  const normal = found.toLowerCase().replace(/\s+/gu, " ");
  return LISTED.find((l) => l.substitute === normal)?.names;
};

/**
 * Every listed substitute the text uses as a whole word or phrase, case-insensitive, each distinct one once in order of
 * first occurrence, `found` as it stands in the text.
 */
export const substitutesIn = (text: string): readonly SubstituteFound[] =>
  [...text.matchAll(PATTERN)]
    .map((m) => m[0])
    .filter((f, i, all) => all.findIndex((g) => g.toLowerCase() === f.toLowerCase()) === i)
    .flatMap((f) => {
      const names = namesOf(f);
      return names === undefined ? [] : [{ found: f, names }];
    });

const listed = (items: readonly string[]): string =>
  items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;

const SOURCE_TEXTS: Readonly<Record<VocabularySource, (names: ProgramWord["names"]) => string>> = {
  itemState: () => "an item whose run is implementing it is implementing, and one whose run finished is implemented",
  runMode: (names) => `a run is a ${listed(names)} run`,
  phase: (names) => `the phase is ${listed(names)}`,
  executionStatus: (names) => `the status is ${listed(names)}`,
  disposition: (names) => `the answer is ${listed(names)}`,
};

/** The table as one sentence for the prompts, built from `PROGRAM_WORDS` alone, so the prompt and the check agree. */
export const programWordsText = (): string =>
  `Interloq's own words: ${PROGRAM_WORDS.map((w) => `${SOURCE_TEXTS[w.source](w.names)}; never write ${listed(w.substitutes)} for ${listed(w.names)}`).join("; ")}.`;

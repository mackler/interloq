// Prompt texts. All paths are relative to the project directory.

import { pathOf, recordPath } from "./artifacts.ts";
import { FILE_CHANGE_FIELD, type Block, type Explanation, type LogEntry, type Piece, type PieceOption, type Review } from "./schema.ts";
import type { ShownBlock } from "./pieces.ts";
import type { InterviewStage } from "./uiEvents.ts";
import type { PauseOrigin, QuestionOrigin } from "./question.ts";

const SEVERITY = `Severity: blocking = the work cannot succeed with the file as written; major = the file as written will produce a defect or omits something required; minor = everything else.`;

/** Rules for the use of an issue log. They are the same for every reviewed file. */
function logRules(logFile: string, idPrefix: string, round: number): string {
  return `plan-review/${logFile} is a JSON object whose 'entries' list every issue raised in earlier rounds with the planner's disposition and rationale, in order.
Every entry has id, phase, round, source, problem, action, rationale and superseded. An entry with superseded = true has been replaced by a later entry with the same id; use the later entry.
An entry with source 'review' is an issue you raised: it also has severity, location, evidence, the planner's action ('accepted', 'partially_accepted', 'rejected', 'no_change_needed' or 'clarification_requested'), and duplicate_of and reverses, each the id of an earlier issue or null.
An entry with source 'self_correction' records a correction that the planner made to its own earlier work (action 'accepted', 'plan_error' or 'correction_disputed').
Every entry with source 'review' or 'self_correction' also has ${FILE_CHANGE_FIELD}: what the program measured in the reviewed file during the planner's response in that round, for all of that round's entries together: changed (true or false), and the numbers of lines added and removed; null where nothing was measured. It is the program's measurement, not the planner's claim. If an 'accepted' or 'partially_accepted' entry's rationale describes amendments that ${FILE_CHANGE_FIELD} does not bear out, raise it as an issue.
An entry with source 'user' (action 'decided_by_user') contains a decision of the user on that issue, which must be followed.
The rationale of every entry is addressed to you; read it irrespective of the action.
plan-review/reviewer-feedback.md contains feedback from the planner that concerns no single issue; take it into account.
For an entry with action 'clarification_requested', the rationale contains a question to you: if the issue is valid, raise it again under the same id and answer the question in the evidence field; if the question shows the issue to be mistaken, omit the issue.
plan-review/user-decisions.md contains input and decisions by the user, which must be followed; do not raise an issue that contradicts them.
Do not repeat an issue whose action is 'accepted' unless the file still contains the defect.
Do not repeat an issue whose action is 'rejected', 'no_change_needed', or 'partially_accepted', under the same or a different wording, unless you can state a specific error in the rationale; in that case reuse the original id and state the error in the evidence field.
Do not raise an issue whose correction would undo the correction made for an accepted issue in the log; if you consider an accepted correction wrong, reuse the id of that issue and state the error in the evidence field.
${SEVERITY}
Return an empty issues array when no issue is found.
New issues receive ids of the form ${idPrefix}-R${round}-1, ${idPrefix}-R${round}-2, and so on.`;
}

function laterRound(file: string, logFile: string, idPrefix: string, round: number): string {
  return `The planner has answered your issues; the answers are in plan-review/${logFile}, and plan-review/${file} may have been amended.
Read both files again and review plan-review/${file} again under the same rules as before. New issues receive ids of the form ${idPrefix}-R${round}-1, ${idPrefix}-R${round}-2, and so on.`;
}

/** The heading of the explanations of terms: in the terminal (decision Q6) and in a relayed question's text (S13). */
export const TERMS_HEADING = "Terms:";
/**
 * The words an option's description must follow correctly (issue #59, S16 of the task of issue #36); never displayed.
 * The rule for writing an option and the reviewer's criterion both quote it.
 */
export const OPTION_DIFFERENCE_PREAMBLE = "This choice differs from the others, because if you make this choice, then unlike any other choices, ...";
/** One rule for a question put to the user: its id, the writer's imperative, and the reviewer's criterion (S1). */
export type QuestionRule = Readonly<{ id: string; rule: string; criterion: string }>;
/**
 * The one statement of the rules for every question put to the user (issues #34, #36, #58, #59; requirements items 2 and
 * 3). The prompt that asks an agent for a question carries `questionWritingRules()`, and the review that approves one
 * carries `questionReviewCriteria()`, both rendered from this array; `validateQuestion` in src/question.ts checks the
 * mechanical part under the same ids.
 */
export const QUESTION_RULES: readonly QuestionRule[] = [
  {
    id: "selfContained",
    rule: "Make every question self-contained: it depends on nothing outside itself and its own options. Use no 'also', 'that', 'the above', 'as discussed' or other pointer to earlier material; where the question depends on an earlier decision, state that decision in its own words.",
    criterion: "a question depends on something outside itself and its own options: an 'also', 'that', 'the above' or 'as discussed', or an earlier decision pointed at instead of stated.",
  },
  {
    id: "nameThings",
    rule: "Name every thing the question is about at its first mention: not 'the file', 'the response', 'the reviewer' or 'the call' where the reader cannot know which one is meant, but 'the file being reviewed, the plan' or 'Claude Code's response to a review'.",
    criterion: "a question leaves a thing unnamed at its first mention ('the file', 'the response', 'the call') where the reader cannot know which one is meant.",
  },
  {
    id: "noIdentifiers",
    rule: "Do not use an identifier of a program (a tool name, a field name, a type, a file name, a status value, a function) without explaining it in ordinary words in the text itself.",
    criterion: "a question uses an identifier of a program (a tool name, a field name, a type, a file name, a status value, a function) without explaining it in ordinary words.",
  },
  {
    id: "noLiterals",
    rule: "Do not use a literal from the code where a word of English is meant: write 'running', not 'started'.",
    criterion: "a question uses a literal from the code where a word of English is meant, such as 'started' for 'running'.",
  },
  {
    id: "kindBeforeNumber",
    rule: "Never refer to an issue, a question, an option, a decision, a phase, a cycle or a commit by its number alone: the kind comes first and the identifier second ('Issue #6', 'phase 2', 'commit 44d39a9'). Where the reader cannot follow a reference, say what it is instead of pointing at it.",
    criterion: "a question refers to an issue, a question, an option, a decision, a phase, a cycle or a commit by its number alone, without the kind before it, or points at a reference the reader cannot follow instead of saying what it is.",
  },
  {
    id: "oneWord",
    rule: "Use one word for one thing within a question.",
    criterion: "a question uses two different words for one thing.",
  },
  {
    id: "noInternalTerms",
    rule: "Do not use a term of the program's internals (a report, a refusal, a disposition, a cycle, a phase, a session, a call) as though it were ordinary English. Where the program's behavior is the subject, state it in ordinary words.",
    criterion: "a question uses a term of the program's internals (a report, a refusal, a disposition, a cycle, a phase, a session, a call) as though it were ordinary English.",
  },
  {
    id: "questionLast",
    rule: "Put what the reader needs first and the question last: the interrogative sentence is the last sentence, the one the reader reaches immediately before the options, and it ends with a question mark.",
    criterion: "the interrogative sentence of a question is not its last sentence, immediately before the options.",
  },
  {
    id: "context",
    rule: "Precede every question with a context paragraph that states: the software components involved, each named with a description of one to three words; what each does, or could do, in the situation the question and its options describe; where in the application they are; when, during the operation of the program, they act or would act; and the purpose of that behavior, in computing terms and in human terms.",
    criterion: "a question's context paragraph is missing, or omits one of its five points: the software components involved, each with a description of one to three words; what each does, or could do, in the situation the question and its options describe; where in the application they are; when, during the operation of the program, they act or would act; the purpose of that behavior, in computing terms and in human terms.",
  },
  {
    id: "contextNoAnnouncement",
    rule: "The context paragraph begins with the first thing it describes; never open it by counting or classifying what follows ('Two parts are involved', 'Three components take part'). An opening sentence is right when it says what kind of thing these are and how they concern the reader, as 'Interloq has two interfaces and you may use either' does.",
    criterion: "a context paragraph opens by counting or classifying what follows ('Two parts are involved') instead of with the first thing it describes.",
  },
  {
    // Issue #91 (5 Oct 2026): the context states the situation and what turns on the choice.
    id: "contextBearsOnChoice",
    rule: "The context paragraph states the present situation and what turns on the choice. It includes the five points required of a context paragraph only as far as they serve that, and leaves out a point that does not bear on the choice; where the two rules disagree, this one governs. It does not recount how the situation was learned (a test run, what was measured, what was tried first); it states a decision taken elsewhere as part of the situation and offers no evidence for it; and it shows no code, file contents or instruction unless the reader is deciding what that text says. Keep a sentence only if it would be different were the reader to choose another option, or if the reader needs it to tell the options apart.",
    criterion: "a sentence of the context neither would differ under another option nor helps the reader tell the options apart: it recounts how the situation was learned, argues for a decision taken elsewhere instead of stating it, shows code, a file's contents or an instruction the reader is not deciding about, or states a point that does not bear on the choice. Where this and the criterion of the five points of a context paragraph disagree, this one governs: a point of the five left out because it does not bear on the choice is not an issue.",
  },
  {
    id: "purposeOwner",
    rule: "Where the context states a purpose, name what the purpose belongs to (the question, a component, or the program): not 'The point is that you can look a word up', but 'Binding each explanation to its word is what allows you to find out what a word means without leaving the question.'",
    criterion: "a statement of purpose leaves unstated what the purpose belongs to, as 'The point is that …' or 'The purpose is that …' does.",
  },
  {
    id: "askWhatUserWants",
    rule: "Ask what the user wants, not how the program is: 'How do you want the terminal to show term explanations?', not 'How does the terminal show term explanations?'. The question is asked because the behavior has not been decided, so the present tense describes something that does not exist.",
    criterion: "the question sentence asks about the program in the present tense ('How does …', 'What does … show') instead of asking what the user wants ('How do you want …').",
  },
  {
    // Issue #92 (5 Oct 2026): a question asks which outcome the reader wants, not how the program is arranged.
    id: "askOutcome",
    rule: "Ask which outcome the reader wants. Never ask where a line of code goes, which module holds a value, or which of two arrangements of the same program to adopt: where two implementations are being chosen between, name the outcomes that differ and make those outcomes the options; how the program is arranged then follows from the answer. A question in the right tense can still break this rule.",
    criterion: "a question asks where code goes, which module holds a value, or which arrangement of the same program to adopt, instead of which of the outcomes that differ the reader wants.",
  },
  {
    id: "determinateOptions",
    rule: "Give every option a meaning that cannot be taken two ways and that says what produces its outcome, so that the arguments for and against it can be worked out from what the option says, as docs/decision-making.md requires of an analysis.",
    criterion: "an option could be taken two ways, or states an outcome without saying what produces it, so that the arguments for and against it cannot be worked out from what it says, as docs/decision-making.md requires of an analysis.",
  },
  {
    id: "optionDifferences",
    rule: `Write each option's description so that it states only how that option differs from the other options: it must read correctly after these words, which are never shown to the user: "${OPTION_DIFFERENCE_PREAMBLE}" An aspect that two options share is described in neither of them. Where an option differs from some of the others but not all, it names which ones before stating that difference. Where it has several differences, state them in descending order of how many other options they distinguish it from.`,
    criterion: `an option's description does not read correctly after "${OPTION_DIFFERENCE_PREAMBLE}", describes an aspect it shares with another option, states a difference from only some options without naming them first, or does not order its differences by how many other options they distinguish it from.`,
  },
  {
    // Issue #92 (5 Oct 2026): each option says what choosing it changes for the reader.
    id: "readerConsequence",
    rule: "In each option's description, state what choosing it changes for the reader, in terms the reader can act on: time spent or saved, work that falls to someone later, a risk carried, money, or what the reader must do differently while a run is going; not only what the program would do differently. Where you decide whether to ask and no such difference can be named for the options, do not ask: settle the matter yourself and say what you settled.",
    criterion: "an option states only what the program would do and not what choosing it changes for the reader (time, work that falls to someone later, a risk, money, or what the reader must do differently during a run), or a question is asked whose options differ in none of these, which the writer should have settled and reported instead.",
  },
  {
    // Issue #93 (5 Oct 2026): a conclusion states its warrant.
    id: "statedWarrant",
    rule: "Where a sentence draws a conclusion ('so', 'therefore', 'which means', 'hence', 'thus'), state its warrant: the general principle that carries the grounds to the claim, and with it any fact that principle rests on which the reader cannot be expected to know. A conclusion whose warrant does not fit in one sentence belongs to a decision taken elsewhere: state that decision as the situation instead of arguing it.",
    criterion: "a sentence draws a conclusion ('so', 'therefore', 'which means', 'hence', 'thus') without the principle that carries the grounds to the claim, or without a fact that principle rests on which the reader cannot be expected to know, or argues a conclusion whose warrant does not fit in one sentence instead of stating it as a decision taken elsewhere.",
  },
  {
    // Issue #59 (5 Oct 2026): a fact about how the software is developed says that is what it is.
    id: "developmentFacts",
    rule: "Where the text states a fact about how the software is developed, built, tested or released, say that this is what it is, and never leave it in the same tense as a fact about the running program; where the reader needs its timing, name the occasion (at a commit, on every push, when someone asks for it) instead of the bare present tense. Not 'The adapter builds the options of each call and is tested against a fake of the library', which puts what happens while the program runs and what happens on a developer's machine in one tense, with nothing marking the change.",
    criterion: "a fact about how the software is developed, built, tested or released is stated, unmarked, in the same tense as a fact about the running program, or without its occasion (at a commit, on every push, when someone asks for it) where the reader needs its timing.",
  },
  {
    // Issue #59 (5 Oct 2026): the reader's own instructions are named as the reader's.
    id: "readerInstructions",
    rule: "Where the text rests on an instruction the reader wrote, state the instruction in the reader's own terms and say that it is the reader's own. Never refer to the reader's instructions by an internal name ('the repository's rules', 'the repository's instructions', 'the project's rules', 'the rules'), and never attribute an action to them: a rule does nothing; the run does something because the reader asked for it.",
    criterion: "the text refers to the reader's own instructions by an internal name ('the repository's rules', 'the repository's instructions', 'the project's rules', 'the rules') instead of stating them as the reader's own, or attributes an action to them.",
  },
  {
    // Issue #59 (5 Oct 2026): no passive without an actor where the reader needs to know who acts.
    id: "namedActor",
    rule: "Where a sentence says that something happens to the reader, to the program or to a record, and the reader needs to know who does it (who shows, who writes, who decides, who refuses), name the actor. The passive is allowed where the actor does not matter to the reader. Not 'its text is shown to you before it is written', which hides three actors in nine words.",
    criterion: "a sentence leaves out who acts where the reader needs to know it: who shows, who writes, who decides or who refuses.",
  },
  {
    id: "terms",
    rule: "List in explanations every word or phrase that a reader who has never seen this codebase may not know (the program's vocabulary, an SDK's, a third-party library's), each with a plain, non-empty explanation: a definition in ordinary words, not a cross-reference; and let every piece of the text that uses it, wherever it occurs, refer to that explanation.",
    criterion: "a word or phrase that a reader who has never seen this codebase may not know has no explanation, or a piece that uses it does not refer to it, or its explanation is empty, a cross-reference, or does not make it intelligible.",
  },
];
/** The rules as the writer of a question reads them. */
export function questionWritingRules(): string {
  return `Rules for every question put to the user. A reader who has never seen this codebase must be able to understand and answer it; the rules apply to its context, its question, its options and its explanations alike.
${QUESTION_RULES.map((r) => `- ${r.rule}`).join("\n")}`;
}
/** The rules as the reviewer of a question reads them. */
export function questionReviewCriteria(): string {
  return `A reader who has never seen this codebase must be able to understand and answer every question put to the user. Raise an issue when:
${QUESTION_RULES.map((r) => `- ${r.criterion}`).join("\n")}
${QUESTION_FORMAT.filter((c) => c.kind === "prose").map((c) => `- ${c.criterion}`).join("\n")}`;
}

/**
 * The line openings that the clause `inline` names to the writers as examples of what a plain piece never opens (issue
 * #94): a heading, a block quote, the list markers, a tilde fence, an HTML block, an indented code block (four spaces or a
 * tab). piecesMarkdown of src/pieces.ts writes each of them so that it is shown as its characters.
 */
export const PLAIN_BLOCK_OPENERS: readonly string[] = ["#", ">", "-", "+", "*", "1.", "1)", "~~~", "<div>", "    ", "\t"];
/** An opener as the clause `inline` names it: whitespace in words, any other opener between quotation marks. */
export const blockOpenerName = (opener: string): string => (opener === "\t" ? "a tab" : opener === "    " ? "four spaces" : `'${opener}'`);

/**
 * One clause of how a question's text is written as pieces (S4 of the task of issue #36): a data clause the validation
 * of src/question.ts enforces, or a prose clause that is stated to the writers and to the reviewers and not checked,
 * since checking it would mean reading Markdown (its effect on the display is tested in the page).
 */
export type FormatClause = Readonly<{ id: string; kind: "data" | "prose"; text: string; criterion: string }>;
/** The one statement of how a question's text is written as pieces and blocks (S4; decisions Q1 and Q2 of the task). */
export const QUESTION_FORMAT: readonly FormatClause[] = [
  {
    id: "blocks",
    kind: "data",
    text: 'Write a context (and any details) as a list of blocks, each with its kind: a paragraph (kind "paragraph", with its pieces), a bulleted list (kind "list", with its items, each with its level, 0 at the top and one more per nesting, and its pieces), or a code block (kind "code", with its text, a value shown exactly).',
    criterion: "",
  },
  {
    // W2-R1-1, P3-R1-1 (S26): how normalizedRuns of src/pieces.ts lays out a list interrupted by other blocks.
    id: "interrupted",
    kind: "data",
    text: "A code block or a paragraph that stands between two lists is shown inside the last item of the list before it, and the list after it continues that list at its levels: to show a multi-line value of a list item, put its code block right after the list that ends with that item, and continue the remaining items in a new list.",
    criterion: "",
  },
  {
    id: "pieces",
    kind: "data",
    text: 'Write every text (the question, each paragraph and list item, each option\'s label and description) as a sequence of pieces, each with text, ref and code. A plain piece has ref "" and code false; the pieces\' texts, joined one after another, are the sentence.',
    criterion: "",
  },
  {
    id: "refPiece",
    kind: "data",
    text: "A word or phrase that needs an explanation is a piece of its own whose ref is the id of that explanation and whose text is the words exactly as they stand in the sentence, never empty: \"execution calls\" and \"Execution call\" are two pieces that refer to one explanation.",
    criterion: "",
  },
  {
    id: "explanations",
    kind: "data",
    text: "explanations: one list per question, referred to from all of its parts. Each entry has an id unique in the question, term (the name of the word or phrase, as a reader would look it up) and explanation, neither empty, and at least one piece refers to it. Every question carries all of its own explanations, even where an earlier question explained the same term.",
    criterion: "",
  },
  {
    id: "code",
    kind: "data",
    text: "A piece with code true, and a code block, shows a literal value (a command, a file name, a setting) exactly as it is; never add a ref to it.",
    criterion: "",
  },
  {
    // W3-R1-1 (S29): a code span shows a line break as a space, so a value of several lines is a code block.
    id: "codeLine",
    kind: "data",
    text: "A code piece holds one line: a value of several lines is a code block, never a code piece.",
    criterion: "",
  },
  {
    // W5-R1-1 (S33): two code spans written side by side are read as one span holding their backticks.
    id: "codeAdjacent",
    kind: "data",
    text: "Two code pieces never stand next to each other, not even with an empty piece between them: one value is one code piece, and two values have words between them.",
    criterion: "",
  },
  {
    // S37 (the developer's decision of 4 Oct 2026): piecesMarkdown of src/pieces.ts escapes every backtick of a plain piece.
    // Issue #94 (5 Oct 2026): plainMarkdown of src/pieces.ts writes what would open a block at the start of a line as its characters.
    id: "inline",
    kind: "prose",
    text: `A plain piece carries emphasis and links only, never code: each begins and ends inside that one plain piece, and a backtick in a plain piece is shown as a backtick character. A plain piece never opens a block: whatever a line begins with (${PLAIN_BLOCK_OPENERS.map(blockOpenerName).join(", ")}) is shown as those characters, so a heading, a list, a quotation or a code block is written as a block of its kind, never as Markdown in a piece. Every literal value (a command, a file name, a setting) is its own code piece. A piece that refers to an explanation carries no formatting at all.`,
    criterion: "a literal value is written between backticks in a plain piece rather than as its own code piece, a piece's emphasis or link does not begin and end inside that one plain piece, a piece that refers to an explanation carries formatting, or a plain piece relies on Markdown that opens a heading, a list, a quotation or a code block.",
  },
];
/** The format as the writer of a question reads it (S4). */
export const QUESTION_TEXT_FORMAT = `How the text of a question is written:
${QUESTION_FORMAT.map((c) => `- ${c.text}`).join("\n")}`;

/** Some clauses of the format, by id, as a writer reads them. */
const formatClauses = (ids: readonly string[]): string => QUESTION_FORMAT.filter((c) => ids.includes(c.id)).map((c) => `- ${c.text}`).join("\n");

/**
 * The clauses that bind one kind of reply beyond the format (S6, S9): an agreed question's wording kept by the call that
 * divides it into pieces (decision Q1), and a context call's literals, options and supplied references (decisions F1 and
 * G-R1-1). The repair prompt cites them by id like the rules.
 */
export const KEEP_WORDING = "Keep the wording of each agreed question exactly: every field's words, joined in order, and its blocks, their kinds and list levels, must be what plan-review/questions.json holds; only the division into pieces and the references to explanations are yours.";
export const KEEP_LITERALS =
  "Keep every value of the details exactly as it is, in its order and in its form, and add none: every code block and every code piece (a text, a number, a name), and every phrase in parentheses that stands for a value (yes or no, none, an empty list, object or text, whitespace alone), each still code or still a phrase as it was given. Add no explanation to any of them.";
export const KEEP_OPTIONS = "Keep every option, in its position: you may rephrase its label and description, but not add, remove or reorder options.";
export const KEEP_SUPPLIED_REFS =
  "Keep every code piece that Interloq supplied with a ref (the name of a tool's setting that Interloq explains) exactly as supplied and in its place, with its ref and with an explanation of that id. No other piece carries that ref, in any part of the question: add no ref to any other code piece or code block, even one of the same text.";
const BOUND_CLAUSES: Readonly<Record<string, string>> = { keepWording: KEEP_WORDING, keepLiterals: KEEP_LITERALS, keepOptions: KEEP_OPTIONS, keepSuppliedRefs: KEEP_SUPPLIED_REFS };
/** The text of a rule, a format clause or a bound clause, by its id. */
const ruleTextOf = (id: string): string => QUESTION_RULES.find((r) => r.id === id)?.rule ?? QUESTION_FORMAT.find((c) => c.id === id)?.text ?? BOUND_CLAUSES[id] ?? "";

/**
 * The mechanically checkable part of the rules (S2, S3 of the task of issue #36): each kind of problem that the
 * validation finds, with the id of the rule, format clause or bound clause it breaks. The repair prompt cites its text.
 */
export const QUESTION_PROBLEM_KINDS = [
  "blankContext",
  "notLast",
  "unknownRef",
  "unusedExplanation",
  "duplicateExplanation",
  "blankTerm",
  "blankExplanation",
  "blankTermPiece",
  "refOnCode",
  "multiLineCode",
  "adjacentCode",
  "bareNumber",
  "unknownQuestion",
  "wordingChanged",
  "literalChanged",
  "optionsChanged",
  "suppliedRefDropped",
] as const;
export type QuestionProblemKind = (typeof QUESTION_PROBLEM_KINDS)[number];
export const QUESTION_PROBLEM_RULE: Readonly<Record<QuestionProblemKind, string>> = {
  blankContext: "context",
  notLast: "questionLast",
  unknownRef: "refPiece",
  unusedExplanation: "explanations",
  duplicateExplanation: "explanations",
  blankTerm: "explanations",
  blankExplanation: "terms",
  blankTermPiece: "refPiece",
  refOnCode: "code",
  multiLineCode: "codeLine",
  adjacentCode: "codeAdjacent",
  bareNumber: "kindBeforeNumber",
  unknownQuestion: "keepWording",
  wordingChanged: "keepWording",
  literalChanged: "keepLiterals",
  optionsChanged: "keepOptions",
  suppliedRefDropped: "keepSuppliedRefs",
};
/** One problem of a question: its kind and what it concerns (an explanation, a field, the bare reference), or "". */
export type QuestionProblem = Readonly<{ kind: QuestionProblemKind; subject: string }>;
/** The problems of the questions of one reply, each question named by where it is ("questions_for_user 1", "Q3"). */
export type QuestionProblems = readonly Readonly<{ where: string; problems: readonly QuestionProblem[] }>[];
/** One problem in one sentence. */
export function questionProblemText(problem: QuestionProblem): string {
  const subject = JSON.stringify(problem.subject);
  switch (problem.kind) {
    case "blankContext":
      return "the context paragraph is empty";
    case "notLast":
      return "the question does not end with its interrogative sentence and a question mark";
    case "unknownRef":
      return `a piece refers to ${subject}, which is the id of no entry of explanations`;
    case "unusedExplanation":
      return `the explanation of ${subject} is referred to by no piece`;
    case "duplicateExplanation":
      return `the id ${subject} is given to more than one explanation`;
    case "blankTerm":
      return `the explanation ${subject} has an empty term`;
    case "blankExplanation":
      return `the term ${subject} has an empty explanation`;
    case "blankTermPiece":
      return `a piece that refers to ${subject} has no words`;
    case "refOnCode":
      return `the literal value ${subject} refers to an explanation`;
    case "multiLineCode":
      return `the code piece ${subject} holds more than one line`;
    case "adjacentCode":
      return `the code piece ${subject} stands right after another code piece`;
    case "bareNumber":
      return `${subject} is a number without the kind of thing it numbers before it`;
    case "unknownQuestion":
      return `the explanations name ${subject}, which is not the id of a question of plan-review/questions.json`;
    case "wordingChanged":
      return `the words or blocks of its field ${subject} differ from the agreed question`;
    case "literalChanged":
      return "a literal value of the details was changed, removed, added or moved";
    case "optionsChanged":
      return "the options were added, removed or reordered";
    case "suppliedRefDropped":
      return `the name ${subject}, which Interloq supplied with its explanation, lost its reference`;
  }
}
const questionProblemLines = (questions: QuestionProblems): readonly string[] => questions.map((q) => `${q.where}: ${q.problems.map(questionProblemText).join("; ")}.`);
/** The halt of QuestionInvalid. */
export function questionInvalidText(questions: QuestionProblems): string {
  return `a question for the user is invalid: ${questionProblemLines(questions).join(" ")}`;
}
/** The validation repair turn of a reply whose questions break a rule (S2): what was wrong, and the rules broken, verbatim. */
export function questionRepairPrompt(questions: QuestionProblems): string {
  const ids = [...new Set(questions.flatMap((q) => q.problems.map((p) => QUESTION_PROBLEM_RULE[p.kind])))];
  const rules = ids.map(ruleTextOf).filter((t) => t !== "").map((t) => `- ${t}`);
  return `Your structured output matched the schema, but the program cannot accept its questions for the user:
${questionProblemLines(questions).join("\n")}
The rules they break:
${rules.join("\n")}
Return the complete output again, corrected. Do not modify any file.`;
}

/** How a question for the user is filled (decision Q1 of the decision-support task), with the rules of every question (S1). */
export const QUESTION_OPTIONS_RULE = `Each entry of questions_for_user has a context, a question, explanations and options. When the question is a choice, give two or more mutually exclusive options, each with a short label and a description; otherwise return an empty options array.
${QUESTION_TEXT_FORMAT}
${questionWritingRules()}`;

/** Rules for Claude Code's answer to a review. 'amendment' names what an accepted issue requires. */
function respondRules(amendment: string): string {
  return `plan-review/user-decisions.md contains input and decisions by the user, which must be followed.
Evaluate each issue critically against the codebase; do not assume the reviewer is correct.
Choose one action for each issue.
'accepted': the issue is valid and ${amendment}.
'partially_accepted': a part of the issue is valid; act on that part and state in the rationale which part you do not accept and why.
'rejected': the issue is mistaken; no amendment.
'no_change_needed': the concern is valid, but the file already satisfies it or it is outside the task; no amendment; state where the file satisfies it or why it is outside the task.
'clarification_requested': you cannot evaluate the issue without an answer from the reviewer; no amendment; put the question in the rationale.
Every rationale is addressed to the reviewer and is returned to the reviewer irrespective of the action; use it for any feedback on the issue, including feedback on an accepted issue.
Put in reviewer_feedback any feedback to the reviewer that concerns no single issue, for example a wrong assumption that several issues share; otherwise return an empty string.
If an issue repeats an earlier issue under a different id, set duplicate_of to the earlier id; otherwise set it to an empty string.
If acting on an issue would undo a correction that you made for an earlier accepted issue, do not act on it: set action to 'rejected', set reverses to the id of the earlier issue, and explain the conflict in the rationale; the user will decide. Otherwise set reverses to an empty string.
Independently of the current issues: if you determine that one of your earlier dispositions, or a part of the file, was wrong, report it in self_corrections with an explanation addressed to the reviewer.
Use new_action 'accepted' with the id of an issue that you rejected earlier and now accept; act on it.
Use new_action 'rejected' with the id of an accepted issue whose correction you now consider wrong; do not act on it, the user will decide.
Use new_action 'plan_error' with an empty id for an error that concerns no issue; correct it.
Return an empty self_corrections array when there is none.
Return exactly one disposition per issue id. Put in questions_for_user only questions that the user alone can answer.
${QUESTION_OPTIONS_RULE}
Do not use the AskUserQuestion tool.`;
}

// ---- question list ------------------------------------------------------------------------------

/** The prefix of an agreed question's id (Q1, Q2, …) and of a follow-up's id (F1, F2, …), issue #35 (Q6). */
export const AGREED_QUESTION_PREFIX = "Q";
export const FOLLOW_UP_PREFIX = "F";
export function questionListPrompt(task: string): string {
  return `Do not write a plan yet. Read the task below and inspect the codebase without changing anything.
Return in 'questions' the questions whose answers you need from the user before you can write an implementation plan for the task.
Include a question only if its answer affects the plan and neither the task text nor the codebase nor the project documentation determines it.
Each entry has these fields. id: ${AGREED_QUESTION_PREFIX}1, ${AGREED_QUESTION_PREFIX}2, and so on. context: the context paragraph that precedes the question, as the rules below describe it, as blocks. question: one decision per question, as pieces. reason: why the plan depends on the answer, and why the codebase does not determine it, with the files you inspected, as blocks. proposed_answers: two to four answers that are feasible in this codebase, each with a label and a description, as pieces. default_answer: the words of the label of the proposed answer that you would assume if the user expressed no preference.
How the text of an entry is written:
${formatClauses(["blocks", "pieces", "code", "inline"])}
- Every piece is plain here: ref "" everywhere. The explanations are written after the list is agreed, by dividing its text into pieces that refer to them, its wording unchanged.
${questionWritingRules()}
The rules apply to the question, its reason, its proposed answers and its default alike. Write the list so that it needs as few explanations as possible.
Return an empty list if no question is needed. Do not modify any file. Do not use the AskUserQuestion tool.
Task: ${task}`;
}

export function questionReviewPrompt(round: number): string {
  if (round > 1) return laterRound(pathOf({ kind: "questions" }), pathOf({ kind: "log", subject: "questions" }), "Q", round);
  return `Review the question list in plan-review/questions.json against the task text in the same file and against the codebase. Do not modify any file.
The planner will ask the user these questions in an interview and will then write an implementation plan from the answers.
Raise an issue when: a question whose answer the plan needs is missing; a question is unnecessary because the task text or the codebase determines the answer (name the file); a question is ambiguous or combines several decisions; a reason is wrong; a feasible answer is missing from the proposed answers, or a proposed answer is not feasible in this codebase; a default contradicts the task or the codebase.
${questionReviewCriteria()}
These criteria apply to the question, its context, its reason, its proposed answers and its default alike. Any question in the list may be put to decision support, which works out the arguments for and against each proposed answer, so hold every proposed answer to that standard.
Put the question id, or 'list' for an issue that concerns the list as a whole, in the location field.
${logRules(pathOf({ kind: "log", subject: "questions" }), "Q", round)}`;
}

export function questionRespondPrompt(round: number): string {
  return `plan-review/question-review/review-${round}.json contains a review of the question list in plan-review/questions.json.
${respondRules("you amend the question list for it")}
Return in 'questions' the complete question list after your amendments, including the entries that did not change. Do not modify any file.`;
}

// ---- the explanations of the terms (S17, issue #36) --------------------------------------------------------------------

/** The rule of the terms, as QUESTION_RULES states it: what the terms subject writes and reviews. */
const termsRule = (): string => QUESTION_RULES.find((r) => r.id === "terms")?.rule ?? "";
/**
 * The call that writes the explanations of the agreed questions' terms (S17, decision Q8): a fresh session, after the
 * question review has converged, against the final wording. The entry of each question lists its terms.
 */
export function termsPrompt(task: string): string {
  return `plan-review/questions.json contains the task and the question list that Claude Code and Codex have agreed. The questions will be put to the user, who may never have seen this codebase. Explain the terms of each question. You may read the project to understand it; do not modify any file, and do not use the AskUserQuestion tool.
${termsRule()}
Return in 'entries' one entry per question of the list: its id; its explanations; and its context, question, reason and proposed_answers as the list holds them, divided into pieces so that every piece whose words need an explanation refers to it. A term may occur in any of these fields; each question carries all of its own explanations, since each question is read on its own. The explanations are shown on the words themselves.
${KEEP_WORDING}
${QUESTION_TEXT_FORMAT}
${questionWritingRules()}
An entry whose question needs no explanation has an empty explanations list and its fields as they are.
Task: ${task}`;
}
/** Codex's review of the explanations (S17): the criteria of every question, as they apply to the terms. */
export function termsReviewPrompt(round: number): string {
  if (round > 1) return laterRound(pathOf({ kind: "terms" }), pathOf({ kind: "log", subject: "terms" }), "T", round);
  return `Review the explanations of terms in plan-review/terms.json against the agreed question list in plan-review/questions.json and against the codebase. Do not modify any file. The list itself is agreed; review the explanations.
Each entry of terms.json names a question by its id and holds its explanations, each with its id, term and explanation, and the question's context, question, reason and proposed answers divided into pieces; a piece whose ref is an explanation's id is the words that explanation explains. The user reads each explanation on those words while he answers the question; he may never have seen this codebase. The wording of the question is agreed and cannot change; only its division into pieces and the explanations can.
${questionReviewCriteria()}
Raise an issue about the explanations only: a word or phrase the reader may not know that has no explanation in a question in which it occurs, or a piece that uses it and does not refer to it; an explanation that is wrong, a cross-reference, uses another unexplained term, or does not make its term intelligible to a reader who has never seen this codebase.
Put the question id, with the term, in the location field.
${logRules(pathOf({ kind: "log", subject: "terms" }), "T", round)}`;
}
export function termsRespondPrompt(round: number): string {
  return `${recordPath({ kind: "review", subject: "terms", round })} contains a review of the explanations of terms in plan-review/terms.json.
${respondRules("you amend the explanations for it")}
Return in 'entries' the complete explanations after your amendments, including the entries that did not change, each question divided into pieces with its wording unchanged; the program writes them. Do not modify any file.
${KEEP_WORDING}`;
}
export const termsApplyDecisionsPrompt = `plan-review/user-decisions.md has new entries. Read the file.
Return in 'entries' the complete explanations of plan-review/terms.json, amended where a decision requires it, each question divided into pieces with its wording unchanged; the program writes them. Do not modify any file.
${KEEP_WORDING}`;

export const questionApplyDecisionsPrompt = `plan-review/user-decisions.md has new entries. Read the file.
Return in 'questions' the complete question list of plan-review/questions.json, amended where a decision requires it. Do not modify any file.`;

// ---- interview ----------------------------------------------------------------------------------

const INTERVIEW_RULES = `Rules for the interview.
Each of your turns produces these output fields. message_to_user: what you say to the user in this turn, in plain text without Markdown tables: the record of his earlier answer, an answer to his question, a remark. The question you ask now is not repeated in it; the program shows that question below your message.
current_question: the question this message asks the user to answer now, or every field an empty string or an empty list when the message asks none. Its id is the agreed question's id, the id you assign to a follow-up question, or in a second interview the id of the accepted issue. For an agreed question of plan-review/questions.json, give only its id and leave its other fields empty: the program shows the agreed question as it was reviewed, with its context, its terms and its proposed answers. For any other question, give its context, its text, its explanations and its options: the context paragraph as blocks, the question alone as pieces (without the record of an earlier answer, without the options and without the default), the explanations its pieces refer to, and each option with a short label and a description as pieces, the default marked in its description; all of them under the rules below.
${QUESTION_TEXT_FORMAT}
asked_ids: the ids of every question you have asked so far: the agreed questions you have asked, and an id ${FOLLOW_UP_PREFIX}1, ${FOLLOW_UP_PREFIX}2, … that you assign to each follow-up question. answered_ids: the ids of the questions, agreed or follow-up, that the user has answered so far. complete: true only when every agreed question has been answered and you need nothing further from the user. summary: an empty string while complete is false.
When complete is true, summary contains the complete requirements document in Markdown: the task; every decision with the id of its question; the further information and constraints that the user gave; and open points, each with the default that will be assumed.
Ask one question per message. The user may answer with the number of an option, its label, or free text.
${questionWritingRules()}
You may ask any follow-up question that the conversation makes necessary. The user may raise any subject and may ask you questions; answer them, and inspect the codebase without changing it where that is needed.
Do not use the AskUserQuestion tool; the program relays the conversation. Do not modify any file. Do not write a plan.`;

export const interviewOpenPrompt = `Conduct an interview with the user. plan-review/questions.json contains the task and the agreed questions. Cover every agreed question, in the order of the list unless the conversation makes another order more useful.
${INTERVIEW_RULES}
Begin now with your first message to the user.`;

export function interviewGapsPrompt(reviewFile: string, ids: string[]): string {
  return `The reviewer has examined plan-review/requirements.md, the confirmed result of the interview. ${reviewFile} contains the review. You accepted these issues: ${ids.join(", ")}.
Conduct a second interview with the user on those points only. Treat each accepted issue as an agreed question; use the issue ids in asked_ids and answered_ids.
${INTERVIEW_RULES}
When complete is true, summary contains the complete revised requirements document, not only the changes.
Begin now with your first message to the user.`;
}

export const interviewDonePrompt = `The user ends the interview now. Return complete = true. In the summary, list every agreed question that was not answered under 'Open points', with the default that will be assumed.`;

export function interviewUserMessage(text: string): string {
  return `User: ${text}`;
}

export function interviewNotConfirmed(text: string): string {
  return `The user does not confirm the summary and writes:\n${text}\nContinue the conversation. Return complete = true with the revised summary when the point is resolved.`;
}

// ---- requirements -------------------------------------------------------------------------------

export function requirementsReviewPrompt(round: number): string {
  if (round > 1) return laterRound(pathOf({ kind: "requirements" }), pathOf({ kind: "log", subject: "requirements" }), "G", round);
  return `Review plan-review/requirements.md. It is the result of an interview between the planner and the user, confirmed by the user. plan-review/questions.json contains the task and the questions that were agreed before the interview. Do not modify any file.
The planner will write an implementation plan from the task and this file.
Raise an issue when: an agreed question has no clear answer in the file; two statements in the file contradict each other; a statement cannot be followed in this codebase (name the file); a decision that the plan needs is still absent.
Put the question id or the heading in the location field.
${logRules(pathOf({ kind: "log", subject: "requirements" }), "G", round)}`;
}

export function requirementsRespondPrompt(round: number): string {
  return `plan-review/requirements-review/review-${round}.json contains a review of plan-review/requirements.md.
${respondRules("the point must be put to the user; the program will conduct a second interview on the accepted issues, so do not amend the file yourself")}
Do not modify any file.`;
}

export const requirementsApplyDecisionsPrompt = `plan-review/user-decisions.md has new entries. Read the file and amend plan-review/requirements.md where a decision requires it. Do not modify any other file.
Return an empty questions_for_user array.`;

// ---- plan ---------------------------------------------------------------------------------------

/**
 * How every call that creates or changes the plan returns it (issue #6, F1): whole, as data; the program writes plan.json
 * and plan.md from it.
 */
/**
 * The longest a single shell command of Claude Code may run, in milliseconds (issue #78; requirements Q4 and Q7: 20
 * minutes, fixed in the code). Every call passes it as BASH_MAX_TIMEOUT_MS (`claudeEnv` in src/claude.ts), and the
 * planning prompts forbid a step to end with a command expected to run longer. prototypes/proto-bash-timeout.ts showed
 * on 5 Oct 2026 (Agent SDK 0.3.283) that the setting, passed through Options.env, takes effect in the bundled CLI.
 */
export const COMMAND_CEILING_MS = 1_200_000;

/** The rule of every prompt that asks for the whole plan (issue #78): no step outlasts one shell command. */
export const PLAN_STEP_DURATION_RULE = `A single shell command may run for at most ${COMMAND_CEILING_MS / 60_000} minutes. No step may end with a command expected to run longer than that, such as a full test suite that may outlast it; a step's verification runs only the suites its change touches.`;
/** The execution prompt's sentences on long commands (issue #78, requirements Q6). */
export const BACKGROUND_SUITE_SENTENCE = `A shell command may run in the foreground for up to ${COMMAND_CEILING_MS / 60_000} minutes, with the Bash tool's timeout set to ${COMMAND_CEILING_MS}. Start a command that may run longer than a few minutes, such as a full test suite, in the background with the Bash tool, and wait for it to end before you report the step done. While it runs, read and search, but do not edit any file: the suites read the working tree, and a result must belong to the files as they were when it started.`;

export const PLAN_FORMAT = `Return the complete plan in the field 'plan': its stages in order, each with its number and a title, and in each stage its steps in order, each with an id, its number within the stage, a short label of one line, and its full text in Markdown. Return the whole plan every time, including the parts that did not change. The program writes plan-review/plan.json and plan-review/plan.md from it; do not write either file.`;
/** The rule of step identity (G-R1-1), which validatePlan in src/plan.ts enforces and the repair turn repeats. */
export const PLAN_ID_RULE = `Every step has an id (S1, S2, …) that is unique across the plan. A step that stays in the plan keeps its id in every revision, and a new step gets an id not used before in this plan. A step whose status in plan-review/plan.json is 'done' stays in the plan, with its id, label and text unchanged; it may move to another stage. Stage and step numbers are for display only.`;
/** The statuses of plan.json as the agents read them. */
const PLAN_STATUSES = `Each step of plan-review/plan.json has a status that the program records: a step with status 'done' is implemented, a step with status 'unfinished' was begun and not completed, and a step with status 'pending' is not yet begun.`;

export function initialPlanPrompt(task: string, withRequirements: boolean): string {
  const requirements = withRequirements
    ? "plan-review/requirements.md contains the user's confirmed answers and decisions from the interview. The plan must follow it.\n"
    : "";
  return `Produce an implementation plan for the task below. Investigate the codebase as needed.
${requirements}${PLAN_FORMAT}
${PLAN_STEP_DURATION_RULE}
${PLAN_ID_RULE}
Do not modify any file. Do not implement anything.
Put in questions_for_user only questions that the user alone can answer and without whose answer the plan cannot be written; otherwise return an empty array.
${QUESTION_OPTIONS_RULE}
Task: ${task}`;
}

export const revisePlanPrompt = `Execution has stopped. The last entry of plan-review/user-decisions.md contains the user's input for this stop.
Revise the plan in plan-review/plan.json for the remaining work: keep the steps with status 'done', and change, add, or remove the other steps as the user's input and the current state of the codebase require.
${PLAN_STATUSES}
${PLAN_FORMAT}
${PLAN_STEP_DURATION_RULE}
${PLAN_ID_RULE}
If no change to the plan is required, return it as it is. Do not modify any file. Do not implement anything.
Put in questions_for_user only questions that the user alone can answer and without whose answer the plan cannot be revised; otherwise return an empty array.
${QUESTION_OPTIONS_RULE}`;

export const planApplyDecisionsPrompt = `plan-review/user-decisions.md has new entries. Read the file and amend the plan in plan-review/plan.json where a decision requires it.
${PLAN_FORMAT}
${PLAN_STEP_DURATION_RULE}
${PLAN_ID_RULE}
Do not modify any file.
Return an empty questions_for_user array.`;

export function planReviewPrompt(phase: number, round: number, withRequirements: boolean): string {
  const prefix = `P${phase}`;
  if (round > 1) return laterRound(pathOf({ kind: "planFile" }), pathOf({ kind: "log", subject: { plan: phase } }), prefix, round);
  const requirements = withRequirements
    ? "plan-review/requirements.md contains the user's confirmed answers and decisions. It must be followed; raise an issue when a plan step contradicts it or omits something it requires.\n"
    : "";
  return `Review the implementation plan in plan-review/plan.json against the codebase. Do not modify any file.
${requirements}${PLAN_STATUSES} Steps with status 'done' are already implemented in the codebase; review the remaining steps, and review whether the remaining steps are consistent with the implemented state.
Put the step's id in the location field.
${logRules(pathOf({ kind: "log", subject: { plan: phase } }), prefix, round)}`;
}

export function planRespondPrompt(phase: number, round: number): string {
  return `plan-review/planning-${phase}/review-${round}.json contains a review of the plan in plan-review/plan.json.
${respondRules("you amend the plan for it")}
${PLAN_FORMAT}
${PLAN_STEP_DURATION_RULE}
${PLAN_ID_RULE}
Do not modify any file.`;
}

/** The in-process tool of an execution call (issue #6, Q2): its server, its name, its statuses and its description. */
export const REPORT_STEP_SERVER = "interloq";
export const REPORT_STEP_TOOL = "report_step";
/** The name under which Claude Code calls the tool, and under which hooks and permissions see it. */
export const REPORT_STEP_TOOL_NAME = `mcp__${REPORT_STEP_SERVER}__${REPORT_STEP_TOOL}`;
export const REPORT_STEP_STATUSES = ["started", "done"] as const;
export const REPORT_STEP_DESCRIPTION = `Report the progress of a step of the plan in plan-review/plan.json: call it with the step's id and ${REPORT_STEP_STATUSES.map((s) => `'${s}'`).join(" when you begin the step, and ")} when the step is complete and verified.`;
/** report_step's answers: the step recorded, or an id that is not in the plan (Q3: nothing changes, the run goes on). */
export function stepRecordedText(id: string, status: string): string {
  return `Recorded: step ${id} is ${status}.`;
}
export function unknownStepText(id: string, ids: readonly string[]): string {
  return `No step of the plan has the id ${JSON.stringify(id)}; nothing was recorded. The ids of the plan are: ${ids.join(", ") || "(none)"}.`;
}
/** report_step's answer when the report could not be written; the call is ended with the error. */
export const STEP_NOT_RECORDED = "The report could not be recorded; the program ends this call.";
/** The denial of an edit of plan.json or plan.md (issue #6, F1): the program writes both from the plan Claude Code returns. */
export const PLAN_FILES_DENIED = "plan-review/plan.json and plan-review/plan.md are written by the program from the plan you return; do not edit them.";
/** The validation repair turn of a plan (issue #6, G-R1-1): what was wrong, and the rule. */
export function planRepairPrompt(problems: PlanProblems): string {
  return `Your structured output matched the schema, but the program cannot accept the plan:
${planProblemLines(problems).join("\n")}
${PLAN_ID_RULE}
Return the complete output again, corrected. Do not modify any file.`;
}

/**
 * What Claude Code is told about a step it resumes (issue #53, G-R1-1): the page marks a step current only on a report,
 * so a step resumed after another was started is reported started again.
 */
export const resumeStepSentence = `When you resume a step after you have started another, report it with the status '${REPORT_STEP_STATUSES[0]}' again.`;
/**
 * A relayed question's text as its shape composes it (S8 of the task of issue #36; behavior 4): the question as a JSON
 * object with its context, its question, its explanations and its options, as pieces.
 */
export type RelayedParts = Readonly<{ context: readonly Block[]; question: readonly Piece[]; explanations: readonly Explanation[]; options: readonly PieceOption[] }>;
export function relayedQuestionText(parts: RelayedParts): string {
  return JSON.stringify({ context: parts.context, question: parts.question, explanations: parts.explanations, options: parts.options });
}
/** The example of RELAYED_SHAPE: a question with one explanation and two options, in the shape it states. */
export const RELAYED_EXAMPLE: RelayedParts = {
  context: [{ kind: "paragraph", pieces: [{ text: "<the context paragraph>", ref: "", code: false }] }],
  question: [
    { text: "<the question, where a word such as ", ref: "", code: false },
    { text: "<a term>", ref: "t1", code: false },
    { text: " needs its explanation>?", ref: "", code: false },
  ],
  explanations: [{ id: "t1", term: "<a term>", explanation: "<its explanation>" }],
  options: [
    { label: [{ text: "<the first option's label>", ref: "", code: false }], description: [{ text: "<its description>", ref: "", code: false }] },
    { label: [{ text: "<the second option's label>", ref: "", code: false }], description: [{ text: "<its description>", ref: "", code: false }] },
  ],
};
/**
 * The shape of a question Claude Code asks with AskUserQuestion (S8, behavior 4): the whole question travels as a JSON
 * object in the question's text, which parseRelayedQuestion in src/question.ts reads; the example is the composer's own
 * output.
 */
export const RELAYED_SHAPE = `Write the text of each question you ask with the AskUserQuestion tool as one JSON object, and nothing else, with the fields context, question, explanations and options:
${QUESTION_TEXT_FORMAT}
- options: the same options as the tool's options, in the same order, each with its label and description as pieces whose words, joined, are exactly the tool option's label and description.
For example:
${relayedQuestionText(RELAYED_EXAMPLE)}`;
export const executePrompt = `The plan in plan-review/plan.json has been reviewed. Implement its remaining steps: the steps whose status is 'pending' or 'unfinished'. You may work them in any order, with one step open at a time: report a step done before you start another. Steps with status 'done' are implemented; a step with status 'unfinished' was begun and not completed.
Report your progress with the tool ${REPORT_STEP_TOOL}: when you begin a step, call it with the step's id and the status '${REPORT_STEP_STATUSES[0]}'; when the step is complete and verified, call it with the step's id and the status '${REPORT_STEP_STATUSES[1]}'. ${resumeStepSentence} The program records the status in plan-review/plan.json; do not edit plan-review/plan.json or plan-review/plan.md, and do not change the plan.
If you need information or a decision from the user, or if a remaining step proves to be wrong, do not continue on an assumption: ask with the AskUserQuestion tool. After you have asked, make no tool call other than the final structured output; end your turn with status 'needs_input'.
${RELAYED_SHAPE}
${questionWritingRules()}
${BACKGROUND_SUITE_SENTENCE}
If you cannot continue for another reason, for example a command that fails and that you cannot correct or a denied permission, stop and return status 'blocked' with the description in the question field.
When every step is completed and verified, return status 'finished'.
In every case put a summary of the work done in summary and a description of the steps not yet completed in remaining_work.`;

// ---- repair of an invalid structured reply ------------------------------------------------------

/** One repair turn in the same session or thread. `issue` is the formatted decode error. */
export function repairReplyPrompt(issue: string): string {
  return `Your structured output did not match the required schema:
${issue}
Return the complete output again, corrected. Do not modify any file.`;
}

/** The heading in conversation.md of a corrective turn's reply (issue #30). */
export function correctiveTurnHeading(attempt: number, round: number): string {
  return `Corrective turn ${attempt}, cycle ${round}`;
}
/** The ids a corrective turn may change, as its prompt and its repair name them. */
const correctableIds = (ids: readonly string[]): string => ids.join(", ");
/**
 * The corrective turn (issue #30): a response accepted issues in full or in part, and the reviewed file did not change.
 * correctiveValidation in src/round.ts accepts exactly the changes this prompt allows.
 */
export function correctivePrompt(fileLabel: string, round: number, acceptedIds: readonly string[]): string {
  return `plan-review/${fileLabel} did not change during your response to the review of cycle ${round}, although you accepted ${correctableIds(acceptedIds)} in full or in part.
Either apply the amendments you described, or change the action of those dispositions and give the reason in the rationale.
Return the complete response again in the same form as before; where your response carries the plan, the question list or the analysis, return it whole, with the amendments applied.
Only the action and the rationale of ${correctableIds(acceptedIds)} may differ from your previous response. Return every other disposition, every duplicate_of and reverses, the self_corrections, the reviewer_feedback and the questions_for_user exactly as before.
Do not modify any file.`;
}
/** What a corrective reply changed that it may not (CorrectionInvalid), as the halt describes it. */
export function correctionInvalidText(changedIds: readonly string[], other: readonly string[]): string {
  const parts = [
    ...(changedIds.length === 0 ? [] : [`the corrective reply changed the dispositions of ${changedIds.join(", ")}, which it was not allowed to change`]),
    ...(other.length === 0 ? [] : [`the corrective reply changed ${other.join(", ")}`]),
  ];
  return parts.join("; ");
}
/** The repair turn of a corrective reply that changed what it may not. */
export function correctionRepairPrompt(error: Readonly<{ changedIds: readonly string[]; other: readonly string[] }>, acceptedIds: readonly string[]): string {
  return `Your structured output matched the schema, but the program cannot accept it: ${correctionInvalidText(error.changedIds, error.other)}.
Only the action and the rationale of ${correctableIds(acceptedIds)} may differ from your previous response; everything else must be returned exactly as before.
Return the complete output again, corrected. Do not modify any file.`;
}

// ---- prompts to the user ------------------------------------------------------------------------
// The texts the program shows when it waits for the user. src/userPrompts.ts maps each to its widget.

/**
 * The input hints (S8): the line under a question that says how to answer it in the terminal, one fixed text per kind
 * of prompt, without parameters, so that src/userPrompts.ts recognizes the kind by it. The question itself, its context
 * and its options are presented before it (`questionLines` in src/render.ts); the page shows its own controls instead.
 */
/** A decision at a pause (behaviour 7) or on a question from Claude Code. */
export const decisionPrompt = "Answer with the number or label of an option, or in your own words; Enter = continue without deciding; q = end the run > ";
/** The round limit, with the choice to proceed without convergence. The user reads "cycles" (issue #14). */
export const limitPrompt = "p = proceed without convergence; a number = that many more cycles; 0 = stop the run; q = end the run > ";
/** The round limit of a subject without a proceed choice (the work review, Q13). */
export const limitNoProceedPrompt = "A number = that many more cycles; 0 = stop the run; q = end the run > ";
/** The user's input at a stop of an execution phase whose report carried none. */
export const execInputPrompt = "Your answer for Claude Code (q = end the run) > ";
/** The answer to a question that Claude Code asked with AskUserQuestion. */
export const optionOrTextPrompt = "Answer with the number of an option, or in your own words (q = end the run) > ";
/** A permission request of Claude Code. */
export const permissionPrompt = "y = allow; anything else = do not allow (q = end the run) > ";
/** A message of the interview. */
export const interviewMessagePrompt = "You > ";
/** The confirmation of the interview's summary. */
export const confirmSummaryPrompt = "Enter = confirm the summary; any other text continues the conversation > ";

// ---- status lines to the user (issue #14: "Gather Requirements", "Implementation", "cycle") -----------------------

/** The start of the question phase. */
export const questionListLine = "Gather Requirements: Claude Code formulates the question list ...";
/** The start and the end of an execution phase, under its label (issue #6: numbered only when the run holds two). */
export function implementationBeganLine(label: string, permissionMode: string): string {
  return `\n${label}: Claude Code implements the plan (permission mode ${permissionMode}) ...`;
}
export function implementationEndedLine(label: string, status: string): string {
  return `\n${label} ended with status: ${status}`;
}
/** The start of a planning phase: the first plan, or a revision. */
export function planningBeganLine(label: string, first: boolean): string {
  return first ? `${label}: requesting the initial plan from Claude Code ...` : `\n${label}: Claude Code revises the plan ...`;
}
/** The start of a work review. */
export function workReviewBeganLine(label: string): string {
  return `\n${label}: Codex reviews the changes to the project since the run began ...`;
}
/** The plan could not be written when an execution call ended by a failure or an interruption (issue #6, G-R1-2). */
export function planNotEndedLine(reason: string): string {
  return `\nThe plan's steps could not be recorded at the end of the implementation: ${reason}`;
}
/** The end of a finished run. */
export function taskFinishedLine(phases: number): string {
  return `\nClaude Code reports that the task is finished after ${phases} implementation phase(s).`;
}
/** An AskUserQuestion stop of an execution call. */
export const IMPLEMENTATION_STOPPED_LINE = "\nClaude Code has stopped implementation with a question.";
/** The proceed choices of the subjects at the cycle limit (the work review has none). */
export const PROCEED_TO_CLARIFICATION = "proceed to the clarification with the question list as it is";
export const PROCEED_TO_PLANNING = "proceed to planning with the requirements as they are";
export const PROCEED_TO_IMPLEMENTATION = "proceed to implementation with the plan as it is";
/** The "p" choice at the cycle limit of the terms review (S17). */
export const PROCEED_TO_CLARIFICATION_WITH_TERMS = "proceed to the clarification with the explanations as they are";
/** The start of the terms' writing (S17), as the terminal says it. */
export const termsLine = "\nGather Requirements: Claude Code explains the terms of the agreed questions ...";
/** The "p" choice at the cycle limit of a decision loop (D10 of the decision-support plan). */
export const PROCEED_TO_CHOICE = "proceed to your choice with the analysis as it is";
/** The review loop's lines: a cycle's review and response. */
export function cycleReviewLine(heading: string, n: number): string {
  return `\n${cycleHeading(heading, n)}: Codex review ...`;
}
export function cycleResponseLine(heading: string, n: number): string {
  return `${cycleHeading(heading, n)}: Claude Code response ...`;
}
/** The counts listed at the cycle limit. */
export function cycleCountsLines(heading: string, counts: readonly number[], costs: readonly (number | null | undefined)[]): readonly string[] {
  return [`\nCounted issues and reported Claude Code usage per cycle of ${heading}:`, ...counts.map((c, i) => `  cycle ${i + 1}: counted issues = ${c}, total_cost_usd = ${costs[i] ?? "not reported"}`)];
}
/** Behaviour 7's pauses in the user's words: identical content, idle cycles, an unexplained change. */
export function identicalContentLine(fileLabel: string, cycle: number, seen: string): string {
  return `\n${fileLabel} after cycle ${cycle} is identical to ${fileLabel} after ${seen} (cycle 0 is the state at the start).`;
}
export function observedAfter(cycle: number, afterDecision: boolean): string {
  return afterDecision ? `cycle ${cycle} (after the user's decision)` : `cycle ${cycle}`;
}
export function alternatingSubject(fileLabel: string): string {
  return `which of the two alternating versions of ${fileLabel} is correct`;
}
export function idleSubject(idle: number): string {
  return `the issues of the last ${idle} cycles that produced no amendment`;
}
export function unexplainedChangeSubject(fileLabel: string, heading: string, cycle: number): string {
  return `the unexplained change to ${fileLabel} in ${cycleHeading(heading, cycle)}`;
}

/** The halt at the cycle limit, and a cycle whose round failed validation, as the user reads them (issue #14, W1-R1-1). */
export function cycleLimitStopText(heading: string): string {
  return `stopped by the user at the cycle limit of ${heading}`;
}
export function analysisInvalidText(parts: readonly string[]): string {
  return `the decision analysis is invalid: ${parts.join("; ")}`;
}
/** What the validation of a plan found (the fields of PlanInvalid in src/errors.ts, which imports this module). */
export type PlanProblems = Readonly<{ duplicateIds: readonly string[]; emptyIds: number; removedDone: readonly string[]; changedDone: readonly string[] }>;
/** The problems of an invalid plan, one sentence each, naming the offending ids (issue #6, G-R1-1). */
export function planProblemLines(problems: PlanProblems): readonly string[] {
  return [
    ...(problems.duplicateIds.length === 0 ? [] : [`More than one step has the id ${problems.duplicateIds.join(", ")}; ids must be unique across the plan.`]),
    ...(problems.emptyIds === 0 ? [] : [`${problems.emptyIds} step(s) have an empty id; every step needs an id.`]),
    ...(problems.removedDone.length === 0 ? [] : [`The done step(s) ${problems.removedDone.join(", ")} are missing; a done step stays in the plan.`]),
    ...(problems.changedDone.length === 0 ? [] : [`The label or text of the done step(s) ${problems.changedDone.join(", ")} changed; a done step keeps its label and text.`]),
  ];
}
export function planInvalidText(problems: PlanProblems): string {
  return `the plan is invalid: ${planProblemLines(problems).join(" ")}`;
}
export function decisionFormatUnreadableText(file: string, message: string): string {
  return `the decision-making format ${file} could not be read: ${message}`;
}
export function cycleInvalidText(parts: readonly string[]): string {
  return `the cycle is invalid: ${parts.join("; ")}`;
}

// ---- work review ----------------------------------------------------------------------------------

/** What the work review of phase k ended with: convergence, or leaving for a planning phase in a round. */
export type WorkReviewEnd = "converged" | Readonly<{ revisedInRound: number }>;

export function workReviewPrompt(phase: number, round: number, withRequirements: boolean): string {
  const prefix = `W${phase}`;
  const log = pathOf({ kind: "log", subject: { work: phase } });
  const changes = pathOf({ kind: "changes", phase });
  if (round > 1)
    return `plan-review/${changes} has been rewritten from the current project for this round.
${laterRound(changes, log, prefix, round)}`;
  const requirements = withRequirements
    ? "plan-review/requirements.md contains the user's confirmed answers and decisions. Raise an issue when the work contradicts it or omits something it requires of a completed step.\n"
    : "";
  return `Review the work done in the project since the run began. plan-review/${changes} is the diff of the project against its state at the start of the run (new files in full, committed changes included); read it and the project itself. Do not modify any file.
Review the work against the plan in plan-review/plan.json. ${PLAN_STATUSES} Steps with status 'done' are implemented; review their work against the plan. Missing work of a step with another status is not an issue.
${requirements}Raise an issue for work that does not implement a completed step, contradicts the plan or the requirements, or introduces a defect.
Put the file path, with a line number where it helps, in the location field.
${logRules(log, prefix, round)}`;
}

/**
 * What a response to a review is given besides the round (decision Q1 of the stage-A task): the review of the round,
 * the subject's log entries, and the change record of a work review (null for the other subjects).
 */
export type RespondContext = Readonly<{ review: Review; log: readonly LogEntry[]; changes: string | null }>;

/**
 * A work response is read-only (finding 1 of docs/gui-review.md): it may call no tool, so the prompt carries the
 * review, the entries of this work review's phase in the work-review log, and changes.diff verbatim.
 */
export function workRespondPrompt(phase: number, round: number, context: RespondContext): string {
  const entries = context.log.filter((e) => e.phase === phase);
  return `plan-review/${pathOf({ kind: "review", subject: { work: phase }, round })} contains a review of the work done in the project (the diff in plan-review/${pathOf({ kind: "changes", phase })}).
You cannot use any tool in this response: the review, the earlier entries of this work review's log and the diff are below, and what you did in the execution phase is in your context. Answer with the final structured output only.
${respondRules("the correction will be made in a later execution phase after the plan has been revised; do not modify any file")}
Every correction, including one that a self-correction calls for, is made in a later execution phase; state in the rationale what the correction requires.
Do not modify any file.

The review (${pathOf({ kind: "review", subject: { work: phase }, round })}):
${JSON.stringify(context.review, null, 2)}

The earlier entries of work review ${phase} in plan-review/${pathOf({ kind: "log", subject: { work: phase } })}:
${entries.length === 0 ? "(none)" : JSON.stringify(entries, null, 2)}

The diff (plan-review/${pathOf({ kind: "changes", phase })}):
${context.changes ?? "(not available)"}`;
}

export function revisePlanAfterExecutionPrompt(phase: number, end: Readonly<{ stopped: boolean; workReview: WorkReviewEnd }>): string {
  const stop = end.stopped ? "\nExecution stopped. The last entry of plan-review/user-decisions.md contains the user's input for this stop." : "";
  const review =
    end.workReview === "converged"
      ? `\nWork review ${phase} found no issue in the work so far.`
      : `\nWork review ${phase} ended in round ${end.workReview.revisedInRound} with accepted issues or a user decision: plan-review/${pathOf({ kind: "round", subject: { work: phase }, round: end.workReview.revisedInRound })}, plan-review/${pathOf({ kind: "log", subject: { work: phase } })} and the last entries of plan-review/user-decisions.md.`;
  return `Execution phase ${phase} has ended.${stop}${review}
Revise the plan in plan-review/plan.json: keep the steps with status 'done', add steps that correct the accepted issues and follow the decisions, and change, add, or remove the other steps as the current state of the codebase requires.
${PLAN_STATUSES} An unfinished step counts as remaining.
${PLAN_FORMAT}
${PLAN_STEP_DURATION_RULE}
${PLAN_ID_RULE}
If no change to the plan is required, return it as it is. Do not modify any file. Do not implement anything.
Put in questions_for_user only questions that the user alone can answer and without whose answer the plan cannot be revised; otherwise return an empty array.
${QUESTION_OPTIONS_RULE}`;
}

/**
 * A prompt to the user in the web page's words: the same question without the terminal's key conventions, which
 * the page's buttons replace (plan step 4.7). `kind` is the prompt's kind in src/userPrompts.ts.
 */
export function pagePromptText(kind: string, offeredText: string): string {
  const text = withoutOffer(offeredText).text;
  switch (kind) {
    case "decision":
      return "Choose an option, answer in your own words, or continue without deciding.";
    case "limit":
      return "Proceed without convergence, add cycles, or stop the run.";
    case "limitNoProceed":
      return "Add cycles, or stop the run.";
    case "execInput":
      return "Your input for Claude";
    case "optionOrText":
      return "Choose one of the options, or type your own answer.";
    case "permission":
      return "Allow this action?";
    case "interviewMessage":
      return "Your reply";
    case "confirmSummary":
      return "Confirm the summary, or write what should change.";
    default:
      return text.replace(/\s*>\s*$/, "").trim();
  }
}

/** The name of a conversation with the user as both interfaces show it (issue #21, Q5 follow-up). */
export function clarificationHeading(stage: InterviewStage): string {
  switch (stage) {
    case "clarification":
      return "Clarification";
    case "followUp":
      return "Follow-up clarification";
  }
}
/**
 * The labels of the controls that are not options of a question (issue #25, S23), each saying what it does: finishing
 * the clarification starts planning; ending the run ends it (the records are kept); what each sends is unchanged.
 */
export const END_CLARIFICATION = "Finish clarification and start planning";
export const END_RUN_LABEL = "End the run";
export const CONTINUE_WITHOUT_DECIDING = "Continue without deciding";
export const CONFIRM_SUMMARY_LABEL = "Confirm";
/** The interview's opening help (finding 8 of docs/gui-review.md), for the terminal or the page. */
export function interviewHelp(heading: string, ui: "terminal" | "page"): string {
  return ui === "terminal"
    ? `\n${heading}. Commands: /done = end the clarification; /quit = end the run; """ on its own line starts and ends a message of several lines.`
    : `${heading}. /done ends the clarification, /quit ends the run; Shift+Enter starts a new line.`;
}

// ---- the page's help and notices (W2-R1-4) --------------------------------------------------------------------------
// Texts that the web page shows the user besides the prompts: the answer field's hint, the notices, the compact
// layout's progress line and badge. Field and button labels stay in the components.

/** The opening line of the page's message about a plan written in a planning phase (issue #5: the page says "Claude"), under the phase's label (issue #6). */
export function planWrittenHeading(label: string): string {
  return `Claude wrote the plan (${label}).`;
}
/** The heading of the summary Claude proposes at the end of an interview, in the page. */
export const SUMMARY_PROPOSED_HEADING = "Summary proposed by Claude:";
/** The start form's description, in parts: plain text, a path, and the name of a button. */
export const START_FORM_DESCRIPTION: readonly Readonly<{ text: string; style: "plain" | "code" | "strong" }>[] = [
  { text: "Claude writes a plan, Codex reviews it until no issue remains, Claude implements it, and Codex reviews the work; the page asks you only where a decision is needed. The records are kept in the project's ", style: "plain" },
  { text: "plan-review/", style: "code" },
  { text: " directory. ", style: "plain" },
  { text: "Stop task", style: "strong" },
  { text: " ends a task like Ctrl+C in the terminal.", style: "plain" },
];

/**
 * The name of a phase as both interfaces show it (issue #14): the first phase gathers the requirements, and an
 * execution phase implements the plan. The records keep their own names (question-review/, execution-<k>/). Issue #6:
 * `count` is how many phases of the kind the run holds, begun or foreseen; with one, the phase carries no number.
 */
export function phaseLabel(kind: "questions" | "planning" | "execution" | "work", n: number, count: number): string {
  const numbered = (name: string) => (count === 1 ? name : `${name} ${n}`);
  switch (kind) {
    case "questions":
      return "Gather Requirements";
    case "planning":
      return numbered("Planning");
    case "execution":
      return numbered("Implementation");
    case "work":
      return numbered("Work review");
  }
}
/** The purpose of an agent call as the activity line names it: the events keep the program's words (issues #14, #21). */
export function purposeLabel(purpose: string): string {
  return purpose === "interview" ? "clarification" : purpose === "execution" ? "implementation" : purpose === "context" ? "explaining a question" : purpose;
}
/** A cycle of a review loop in the user's words (issue #14): the records and the events say "round". */
export function cycleHeading(heading: string, n: number): string {
  return `${heading}, cycle ${n}`;
}

/** The label that opens a phase's band in a chat panel (issue #15): the phase's name and the time it began. */
export function phaseBandLabel(name: string, clock: string): string {
  return `${name} · ${clock}`;
}

/** The hint under the answer field. */
export function answerHint(free: "line" | "message"): string {
  return free === "line" ? "Enter sends." : "Enter sends; Shift+Enter starts a new line.";
}
/** The accessible name of the agent's options, the cards above the fixed choices (issue #12). */
export const PROPOSED_ANSWERS_LABEL = "Proposed answers";
/** Another tab answered the prompt this tab had an unsent draft for (finding 5). */
export function draftWithdrawnNotice(text: string): string {
  return `This question was answered in another tab; your unsent text was discarded: «${text}»`;
}
/** The server is ending (finding 15). */
export const SERVER_CLOSED_NOTICE = "The server has ended. The page reconnects when it is started again.";
/** The heading of the answers the page could not send (G-R1-1, P1-R1-2 of the defects' plan). */
export const UNSENT_HEADING = "Not sent";
const NOT_SENT_SUBJECT: Record<"answer" | "stop" | "start" | "list" | "ui", string> = {
  answer: "Your answer was not sent",
  ui: "Opening or closing an entry of the analysis was not sent",
  stop: "Stop was not sent",
  start: "The new task was not sent",
  list: "The directory listing was not requested",
};
const NOT_SENT_REASON: Record<"ended" | "restarted" | "disconnected", string> = {
  ended: "the run has ended",
  restarted: "the server has been restarted since",
  disconnected: "the page is no longer connected to the server",
};
/**
 * An action that was not sent: queued while disconnected and overtaken by the reconnection, or refused because the page
 * has stopped reconnecting. A disconnected answer says where its text is: in the answer field, or quoted and kept.
 */
export function notSentNotice(kind: "answer" | "stop" | "start" | "list" | "ui", reason: "ended" | "restarted" | "disconnected", quoted?: string): string {
  const base = `${NOT_SENT_SUBJECT[kind]}: ${NOT_SENT_REASON[reason]}.`;
  if (kind !== "answer" || reason !== "disconnected") return base;
  return quoted === undefined ? `${base} Its text is still in the answer field.` : `${base} Its text is kept under “${UNSENT_HEADING}”: «${quoted}»`;
}
/** How much of a decode reason the notice shows; the console has it in full. */
const REASON_LENGTH = 200;
/** A frame of the server the page could not read (defect B of docs/page-question-phase-defects.md, decision Q2). */
export function protocolErrorNotice(reason: string): string {
  const shown = reason.length > REASON_LENGTH ? `${reason.slice(0, REASON_LENGTH)}…` : reason;
  return `The page could not read a message from the server; reconnecting. Reason: ${shown}`;
}
/** The page has stopped reconnecting after three frames in a row it could not read (decision Q5). */
export const CONNECTION_FAILED_NOTICE =
  "The page has stopped reconnecting: it could not read the server's messages three times in a row. Nothing you do here is sent any more, and your typed text is kept. Reload the page once the server has been fixed.";
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
/**
 * A cycle of a review loop in the progress rail (issue #14, Q1): the issues its review raised, and the counted ones
 * when they differ; the cycle alone until its review arrives. No limit: the user may grant more cycles.
 */
export function cycleLine(n: number, raised: number | null, counted: number | null): string {
  if (raised === null) return `cycle ${n}`;
  return `cycle ${n}: ${count(raised, "issue", "issues")}${counted !== null && counted !== raised ? ` (${counted} counted)` : ""}`;
}
/**
 * The one line of a finished review loop (issue #14, Q2 and G-R1-1; issue #28: "n issues resolved in m cycles"): the corrections of its cycles, resolved when the
 * loop converged or the user proceeded, due when it left for a revision (even 0, when a decision of the user ended it).
 */
export function loopSummary(cycles: number, corrections: number, result: "converged" | "proceed" | "revise"): string {
  const n = count(cycles, "cycle", "cycles");
  switch (result) {
    case "converged":
      return `${count(corrections, "issue", "issues")} resolved in ${n}`;
    case "proceed":
      return `${count(corrections, "issue", "issues")} resolved in ${n}, proceeded without convergence`;
    case "revise":
      return `${count(corrections, "correction", "corrections")} due after ${n}`;
  }
}
/** A stage of the plan as plan.md and the progress rail name it (issue #6): "Stage 1: the schema and its records". */
export function stageHeading(n: number, title: string): string {
  return `Stage ${n}: ${title}`;
}
/** A step of the plan as the progress rail names it (issue #6): "1. Structured user questions (Q1)". */
export function planStepLabel(n: number, label: string): string {
  return `${n}. ${label}`;
}
/**
 * What each mark of a phase or step says to assistive technology in the progress rail (issue #6: ahead, not reached;
 * skipped: a step whose phase ended without needing it).
 */
export const TIMELINE_STATE_LABEL: Record<"ahead" | "active" | "done" | "stopped" | "notReached" | "skipped", string> = {
  ahead: "ahead",
  active: "in progress",
  done: "done",
  stopped: "stopped",
  notReached: "not reached",
  skipped: "not needed",
};
/** What each mark of a step of the plan says (issue #6, G-R1-2): a started step is current only while an execution call runs. */
export const PLAN_STEP_STATE_LABEL: Record<"done" | "current" | "unfinished" | "pending", string> = {
  done: "done",
  current: "in progress",
  unfinished: "begun, not finished",
  pending: "not begun",
};
/** The accessible name of the busy indicator (issue #42): it says that an agent works, and nothing about how far. */
export const AGENT_WORKING_LABEL = "An agent is working";
/** The indicator of the activity line while the program waits to retry a call (issue #26, W1-R1-4). */
export const RETRY_WAITING_LABEL = "Waiting to retry the connection";
/** The measured time of the current agent call beside the busy indicator (issue #42, Q7): m:ss, or h:mm:ss from one hour on. */
export function runningFor(ms: number): string {
  return `running for ${durationText(ms)}`;
}
/** A measured duration (issues #42, #50): m:ss, or h:mm:ss from one hour on. */
export function durationText(ms: number): string {
  const total = Math.floor(ms / 1000);
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
/** A finished or stopped phase's duration beside its name in the progress rail (issue #50, Q2). */
export function phaseTook(ms: number): string {
  return `took ${durationText(ms)}`;
}
/** The active phase's time since it began, beside its name in the progress rail (issue #50, Q2). */
export function phaseElapsed(ms: number): string {
  return `${durationText(ms)} so far`;
}
/**
 * The accessible name of a running step's indicator (issue #50): the step's state as its mark said it, and that an
 * agent is working on it.
 */
export function stepWorkingLabel(step: "phaseStep" | "planStep"): string {
  return `${step === "phaseStep" ? TIMELINE_STATE_LABEL.active : PLAN_STEP_STATE_LABEL.current}: ${AGENT_WORKING_LABEL}`;
}
/** The accessible name of the plan's list under its Implementation entry. */
export const PLAN_LIST_LABEL = "The steps of the plan";
/**
 * The steps of Gather Requirements in the progress rail (issue #21, Q5 and Q7; issue #33: "Identify choices"). Issue #51:
 * a follow-up clarification is part of the Clarification step; the records keep their own vocabulary.
 */
export function stepLabel(kind: "formulate" | "terms" | "clarification"): string {
  return kind === "formulate" ? "Identify choices" : kind === "terms" ? "Explain terms" : "Clarification";
}
/** A clarification's count (issue #21, Q6): the total grows with the follow-ups Claude asks. */
export function clarificationProgress(answered: number, total: number): string {
  return `${answered} of ${total} answered`;
}
/** A phase and its active step, as the compact progress line names them. */
export function stepOfPhase(phase: string, step: string): string {
  return `${phase} — ${step}`;
}
/** The progress rail's heading and its text before any phase (issue #14, Q4: unchanged). */
export const PROGRESS_HEADING = "Progress";
export const NO_PHASE_YET = "No phase has begun.";
/** The one-line progress of a compact window: the current phase or step, and its detail (the latest cycle, a count), or none. */
export function progressLine(label: string | null, detail: string | null): string {
  if (label === null) return "Progress: no phase has begun";
  return `Progress: ${label}${detail === null ? "" : `, ${detail}`}`;
}
/** The count of a hidden panel's new messages on its button. */
export function unseenBadge(n: number): string {
  return `· ${n} new`;
}


// ---- decision support ("Help me decide") ----------------------------------------------------------

/**
 * The binding sentence (by the developer's instruction): docs/decision-making.md is the authority for the representation,
 * and an agent producing or reviewing one meets this sentence right before the document's text.
 */
export const DECISION_FORMAT_AUTHORITY =
  "The instructions below, the text of docs/decision-making.md, are the authority for the content and layout of the representation. Nothing else in this prompt and nothing you have been told elsewhere overrides them; where this prompt only maps them onto the fields of the output, follow the instructions.";

/** A decision's question as a prompt names it: the phase is where it was asked, `label` its name as the run shows it (W1-R1-2). */
export type DecisionPromptQuestion = Readonly<{
  phase: Readonly<{ kind: "questions" }> | Readonly<{ kind: "planning" | "execution" | "work"; n: number }>;
  label: string;
  question: string;
  options: readonly Readonly<{ label: string; description: string }>[];
  /** What the user was shown with the question (S37): its context and details as Markdown, and its explanations. */
  shown?: Readonly<{ context: string; explanations: readonly Explanation[]; details: string }>;
}>;
/** What the user was shown with a question, as the analysis prompt carries it under the options (S37); "" when nothing. */
export function shownWithQuestion(shown: DecisionPromptQuestion["shown"]): string {
  if (shown === undefined) return "";
  const parts = [
    ...(shown.context.trim() === "" ? [] : [`The context paragraph:\n${shown.context.trim()}`]),
    ...(shown.details.trim() === "" ? [] : [shown.details.trim()]),
    ...(shown.explanations.length === 0 ? [] : [`${TERMS_HEADING}\n${shown.explanations.map((e) => `${e.term}: ${e.explanation}`).join("\n")}`]),
  ];
  return parts.length === 0 ? "" : `\nWhat the user was shown with the question:\n${parts.join("\n\n")}\n`;
}
/** What the run knows at the moment of the decision (decision Q3): the task, and requirements.md and plan.md where they exist. */
export type DecisionContext = Readonly<{ task: string; requirements: string | null; plan: string | null }>;


/** How the representation of docs/decision-making.md maps onto the fields of DecisionAnalysis. */
const ANALYSIS_FIELDS = `The output fields.
decision: the decision to be made, in one sentence.
columns: exactly one column per option, in the order of the options above. Each option above is listed as its number, a colon and its label in quotation marks; option is the text inside the quotation marks, verbatim, without the quotation marks and without the number.
kind: "argued" for an option you argue from, with its advantages and disadvantages; kind: "unclear" for an option whose meaning is unclear, as the instructions define it, with no arguments and the field unclear: what is unclear about the option and which readings are possible.
advantages and disadvantages: the entries of the option's column. Each entry has an id that is unique in the whole representation (E1, E2, and so on), a title (one complete sentence that states the outcome and its effect on persons), and one field per element: comparative_condition, starting_cause, intermediate_steps, threshold, effect_on_persons, reason_the_effect_matters, and extent with its four parts per_person, persons_affected, likelihood and timing. Each element has text, its sentences, and counterarguments, the arguments that dispute that element, in order.
Each argument has an id that is unique in the whole representation (A1, A2, and so on), text, equivalent_to and replies. The replies of a counterargument are its defenses, and the replies of a defense are the further counterarguments to it, without limit. The first counterargument at an element begins with "But," and each further one at that element with "Also,"; the first defense of a counterargument begins with "On the other hand," and each further one with "Also,"; the first counterargument to a defense begins with "Then again," and each further one with "Also,".
equivalent_to: when an argument is equivalent to an entry of any column, or is a reversal that is listed in full as an entry, write in text the one sentence that states the argument and its effect on persons and set equivalent_to to that entry's id; otherwise set it to an empty string.
Do not write the headings "Advantages:" and "Disadvantages:", the labels "Advantage 1:", "Disadvantage 1:" and so on, or any equivalence symbol (*, †, ‡, §, ‖, ¶) into any text: the program places the headings, the labels of the entries and the symbols (the symbols from equivalent_to).
recommendation: an option and a reason. To recommend no option, set both to empty strings. To recommend one, set option to the text inside the quotation marks of that option's label, verbatim, without the number, and state in reason the comparison that the instructions require under "Recommendation".`;

/**
 * One option as the prompts of a decision present it (issue #37): its number outside the label, and the label as a JSON
 * string, so that neither the number nor surrounding text can be taken for part of the label.
 */
export function optionLine(i: number, option: Readonly<{ label: string; description: string }>): string {
  return `${i + 1}: ${JSON.stringify(option.label)}${option.description === "" ? "" : ` — ${option.description}`}`;
}

/** The call that produces the analysis of a decision (a planning call: plan-review/ only, behavior 3). */
export function decisionAnalysisPrompt(format: string, question: DecisionPromptQuestion, context: DecisionContext): string {
  const options = question.options.map((o, i) => optionLine(i, o)).join("\n");
  const requirements = context.requirements === null ? "plan-review/requirements.md does not exist yet." : `plan-review/requirements.md:\n${context.requirements}`;
  const plan = context.plan === null ? "plan-review/plan.md does not exist yet." : `plan-review/plan.md:\n${context.plan}`;
  return `The user must answer a question that offers a choice between options, and has asked for a representation of the arguments for and against each option before choosing. Produce that representation as the structured output.
You may read the project to understand the system; do not modify any file, and do not use the AskUserQuestion tool. Everything you reason from must be in the project or in this prompt; state any other information as unknown, as the instructions require.

${DECISION_FORMAT_AUTHORITY}

${format}

The decision: ${question.question}
The options, in this order:
${options}
${shownWithQuestion(question.shown)}
The context of the decision. The run is in ${question.label}.
The task of the run: ${context.task}
${requirements}
${plan}

${ANALYSIS_FIELDS}`;
}

/** What the validation of an analysis found (the fields of AnalysisInvalid in src/errors.ts, which imports this module). */
export type AnalysisProblems = Readonly<{
  columns: Readonly<{ expected: readonly string[]; got: readonly string[] }> | null;
  duplicateIds: readonly string[];
  emptyIds: number;
  recommendation: Readonly<{ given: string; matches: readonly string[] }> | null;
  blankUnclear: readonly string[];
}>;
/** The validation repair turn of an analysis (issue #37, decision Q1): what was wrong, and the exact option labels. */
export function analysisRepairPrompt(problems: AnalysisProblems, options: readonly Readonly<{ label: string; description: string }>[]): string {
  const found = [
    ...(problems.columns === null ? [] : [`The columns name the options ${problems.columns.got.map((g) => JSON.stringify(g)).join(", ") || "(none)"}; exactly one column per option is required, in the order below.`]),
    ...(problems.duplicateIds.length === 0 ? [] : [`More than one entry or argument has the id ${problems.duplicateIds.join(", ")}; every id must be unique in the whole representation.`]),
    ...(problems.emptyIds === 0 ? [] : [`${problems.emptyIds} empty id(s); every entry and argument id must be non-empty.`]),
    ...(problems.recommendation === null
      ? []
      : [
          problems.recommendation.matches.length > 1
            ? `The recommendation names ${JSON.stringify(problems.recommendation.given)}, which matches more than one option; name exactly one.`
            : `The recommendation names ${JSON.stringify(problems.recommendation.given)}, which is not an option.`,
        ]),
    ...problems.blankUnclear.map((option) => `The column of ${JSON.stringify(option)} is marked unclear but does not state what is unclear and which readings are possible.`),
  ];
  return `Your structured output matched the schema, but the program cannot accept it:
${found.join("\n")}
The options, in this order, each as its number, a colon and its label in quotation marks:
${options.map((o, i) => optionLine(i, o)).join("\n")}
The option of each column, in this order, must be the text inside the quotation marks, verbatim, without the quotation marks and without the number. If you recommend an option, the recommendation's option must be one of those texts, in the same way. To recommend no option, leave the recommendation's option and reason empty.
Return the complete output again, corrected. Do not modify any file.`;
}

/** Codex's review of decision k's analysis, against the format and the question. */
export function decisionReviewPrompt(format: string, k: number, round: number): string {
  const prefix = `D${k}`;
  const analysis = pathOf({ kind: "analysis", decision: k });
  const log = pathOf({ kind: "log", subject: { decision: k } });
  const own = `plan-review/${log} holds the issues of every decision of the run; the issues of this decision are the entries whose ids begin with ${prefix}-, and only those concern this review.`;
  if (round > 1) return `${own}\n${laterRound(analysis, log, prefix, round)}`;
  return `Review the representation of the arguments for and against the options of a decision in plan-review/${analysis} (its field 'analysis'). The question and its options are in plan-review/${pathOf({ kind: "decisionQuestion", decision: k })}. Do not modify any file.
The representation must follow the instructions below. The program renders it: it places the headings "Advantages:" and "Disadvantages:" and the labels of the entries ("Advantage 1:", "Disadvantage 1:"), offsets each counterargument from the element it disputes, and assigns the equivalence symbols from the field equivalent_to, which names the id of the equivalent entry; do not raise an issue about those. A column of kind "unclear" is how the representation states, in place of an option's arguments, what is unclear about the option and which readings are possible; review whether the option is in fact unclear in that sense and whether the statement says so. Counterarguments, defenses and counterarguments to a defense that stand together begin with "But,", "On the other hand," or "Then again," for the first and "Also," for each further one.

${DECISION_FORMAT_AUTHORITY}

${format}

Raise an issue for every departure from these instructions, for example: an element absent or false in an entry; an entry whose effect on persons is not stated; an entry placed in a column contrary to the placement rules; an outcome listed that is the same under every option; a counterargument that disputes no element of its entry or is not placed at the element it disputes, or that does not begin with the required words; a reversal not listed in full as an entry; an argument equivalent to an entry that repeats its content instead of referring to it; a claim of a measurement, figure, source or property that is invented, or an unknown value assumed instead of stated as unknown; an argument, counterargument or defense that an informed person could make and that is missing; a column missing or not matching an option; a recommendation that is not supported by the comparison that "Recommendation" requires. The context of the run is in the project and under plan-review/.
Put the entry id or the argument id, with the column's option, in the location field.
${own}
${logRules(log, prefix, round)}`;
}

/** Claude Code's response to a review of decision k: the dispositions and the complete amended analysis. */
export function decisionRespondPrompt(k: number, round: number): string {
  return `plan-review/${pathOf({ kind: "review", subject: { decision: k }, round })} contains a review of the representation in plan-review/${pathOf({ kind: "analysis", decision: k })}, which you produced under the instructions of docs/decision-making.md given earlier in this session.
${respondRules("you amend the analysis for it")}
Return in 'analysis' the complete analysis after your amendments, including the parts that did not change; the program writes it. Do not modify any file.`;
}

/** The call that applies the user's decisions at a pause of decision k's review. */
export function decisionApplyDecisionsPrompt(k: number): string {
  return `plan-review/user-decisions.md has new entries. Read the file.
Return in 'analysis' the complete analysis of plan-review/${pathOf({ kind: "analysis", decision: k })}, amended where a decision requires it; the program writes it. Do not modify any file.`;
}

/**
 * The one status the user reads while the analysis he asked for is prepared (S21, Q4): check 0 while Claude Code writes
 * it, then how many times Codex has checked it so far; never the review loop's cycles.
 */
export function analysisProgressLine(decision: number, question: number | null, check: number): string {
  const which = question === null ? `Your analysis (Decision ${decision})` : `Your analysis for Question ${question} (Decision ${decision})`;
  return check === 0 ? `\n${which} is being written. It will be shown when it is ready.` : `${which} is being written and checked (check ${check} so far). It will be shown when it is ready.`;
}
/** The offer's label (docs/decision-support-design.md, section 1): one per question, never one per option. */
export const HELP_ME_DECIDE = "Help me decide";
/** The line that carries the offer in a prompt text (D1): the terminal shows it, and the page turns it into a button. */
export const OFFER_LINE = `/decide = ${HELP_ME_DECIDE}: work out the arguments for and against each option before you choose`;
/** A prompt with the offer: the offer line, then the prompt. */
export const withOffer = (prompt: string): string => `${OFFER_LINE}\n${prompt}`;
/** The prompt without the offer line, and whether it carried one. */
export const withoutOffer = (text: string): Readonly<{ offered: boolean; text: string }> =>
  text.startsWith(`${OFFER_LINE}\n`) ? { offered: true, text: text.slice(OFFER_LINE.length + 1) } : { offered: false, text };
/** The options of the cycle limit as a decision analyzes them (decision Q6): the count of more cycles is entered after choosing. */
/**
 * The pause of issue #30: a response accepted issues and the reviewed file is still unchanged (after the corrective
 * turn; for the requirements, after the second interview). Its answers are parsed by parseUnchangedAnswer in
 * src/input.ts, and its widget and options derive from these constants.
 */
export const UNCHANGED_RETRY = "Retry";
export const UNCHANGED_PROCEED = "Proceed";
export const UNCHANGED_STOP = "Stop the run";
export const UNCHANGED_ANSWERS = { retry: "r", proceed: "p", stop: "s" } as const;
export const unchangedPrompt = `${UNCHANGED_ANSWERS.retry} = retry; ${UNCHANGED_ANSWERS.proceed} = proceed with the file unchanged; ${UNCHANGED_ANSWERS.stop} = stop the run > `;
export function unchangedOptionDescriptions(interview: boolean): Readonly<{ retry: string; proceed: string; stop: string }> {
  return {
    retry: interview ? "another interview is held on the accepted issues, so that the summary can be amended." : "Claude Code gets one more corrective turn to apply the amendments it described or to change its answers to the issues.",
    proceed: "the answers to the issues stand with the file unchanged, and the next cycle's review goes ahead.",
    stop: "the run ends here, and no further cycle runs.",
  };
}
export function unchangedLine(fileLabel: string, round: number, acceptedIds: readonly string[], corrected: boolean): string {
  return `\nCycle ${round}: Claude Code accepted ${acceptedIds.join(", ")} in full or in part, but ${fileLabel} is unchanged${corrected ? " after a corrective turn" : ""}.`;
}
export function unchangedQuestion(heading: string, fileLabel: string): string {
  return `${heading}: Claude Code accepted issues, but ${fileLabel} is unchanged. How do you want the run to continue?`;
}
export function unchangedDecisionLine(answer: "retry" | "proceed" | "stop", fileLabel: string, round: number, heading: string): string {
  const what = answer === "retry" ? "retry" : answer === "proceed" ? `proceed with ${fileLabel} unchanged` : "stop the run";
  return `**User decision:** ${what} after cycle ${round} of ${heading}.\n\n`;
}

/**
 * The confirmation before a run ends (S24, issue #25): what ends, that the records remain, and the exit code the program
 * then returns, which test/program.test.ts compares with the code it does return. End the run and Stop task are
 * interruptions (130, by the user's decision at the stop of execution phase 1); Stop at the cycle limit is a halt (1).
 */
export function confirmEndText(ending: "endRun" | "stopTask" | "limitStop"): string {
  switch (ending) {
    case "endRun":
      return "End the run? It ends as interrupted by you, with exit code 130, and its records in plan-review/ remain.";
    case "stopTask":
      return "Stop the task? The run ends as interrupted by you, with exit code 130, and its records in plan-review/ remain.";
    case "limitStop":
      return 'Stop the run at the cycle limit? It halts ("HALTED: stopped by the user at the cycle limit") with exit code 1, and its records in plan-review/ remain.';
  }
}
/** The page's confirmation dialog (S25): its headline and the label of the button that confirms. */
export function confirmEndHeadline(ending: "endRun" | "stopTask" | "limitStop"): string {
  return ending === "endRun" ? "End the run?" : ending === "stopTask" ? "Stop the task?" : "Stop the run at the cycle limit?";
}
export function confirmEndAction(ending: "endRun" | "stopTask" | "limitStop"): string {
  return ending === "endRun" ? END_RUN_LABEL : ending === "stopTask" ? "Stop task" : "Stop the run";
}
export const CANCEL_END = "Cancel";
/** The terminal's confirmation: the text and how to answer it. */
export function confirmEndPrompt(ending: "endRun" | "stopTask" | "limitStop"): string {
  return `${confirmEndText(ending)} y = yes; anything else = back to the question > `;
}
/** The answers of the cycle limit's options (S8); a whole number above zero adds that many cycles. */
export const LIMIT_ANSWERS = { proceed: "p", stop: "0" } as const;
export const LIMIT_PROCEED = "Proceed without convergence";
export const LIMIT_STOP = "End the run";
export const LIMIT_MORE = "Continue with more cycles";
export function limitOptionDescriptions(proceed: string | null): Readonly<{ proceed: string; stop: string; more: string }> {
  return {
    proceed: proceed === null ? "" : `the run ${proceed.replace(/^proceed\b/, "proceeds")}.`,
    stop: "the run ends here, and no further cycle runs.",
    more: "Codex and Claude Code continue for more cycles, whose number you enter after choosing this option.",
  };
}
/** The question of the cycle limit for a decision. */
export function limitQuestion(heading: string, limit: number): string {
  return `${heading} has completed ${limit} cycles without convergence. How do you want the run to continue?`;
}
/** The options of a permission request. */
export const PERMISSION_ALLOW = "Allow this";
export const PERMISSION_DENY = "Do not allow this";
/**
 * The options' descriptions state only how each differs from the others (S17, issue #59): each reads after
 * OPTION_DIFFERENCE_PREAMBLE, and what both share, that Claude Code then continues, is in neither.
 */
export const PERMISSION_ALLOW_DESCRIPTION = "the action is performed in the project.";
export const PERMISSION_DENY_DESCRIPTION = "the action is not performed, and Claude Code is told that you denied it.";
/**
 * The fields of a tool's input that Interloq names in plain words (S34, W1-R1-2): the tools Claude Code uses while it
 * carries out the plan. A field not listed is shown under its own name, explained as a term (P2-R1-2).
 */
export const TOOL_INPUT_LABELS: Readonly<Record<string, string>> = {
  file_path: "The file",
  old_string: "The text to be replaced",
  new_string: "The text to put in its place",
  replace_all: "Replace every occurrence",
  content: "The new content of the file",
  command: "The command",
  description: "What Claude Code says the command does",
  pattern: "What to search for",
  path: "Where to search",
  url: "The web address",
  edits: "The changes",
  notebook_path: "The notebook file",
  new_source: "The new content of the cell",
  timeout: "The time limit in milliseconds",
  query: "The search query",
  prompt: "What Claude Code asks about the page",
};
/** The heading of a permission request's input in the question's details (S34). */
export const TOOL_INPUT_HEADING = "What Claude Code would do:";
/** The line of a field Interloq has no words for: its own name, so that two such fields never look alike (P2-R1-2). */
/**
 * S55 (W6-R1-1, P7-R1-1): the name is shown as code, on one line, so that no character of it is interpreted as Markdown
 * or HTML: every line break, and every character S48 escapes, is written as its escape (`shownName`).
 */
export function unknownSettingLabel(key: string): string {
  // S57: the empty name has nothing to show or to mark; an escaped name carries the note that says what its escapes mean.
  if (key === "") return EMPTY_NAME_LABEL;
  const shown = shownName(key);
  return `The tool's setting named ${spanOf(shown.text)}${shown.kind === "escaped" ? ` ${ESCAPED_VALUE_NOTE}` : ""}`;
}
/** The label of a field whose name is empty (S57): plain text, not code, and no term. */
export const EMPTY_NAME_LABEL = "The tool's setting with an empty name";
/** The fixed explanation of such a field's name, which holds when no context call explained it (P2-R1-2). */
export const unknownSettingExplanation =
  "The name that Claude Code's tool gives one of its settings. Interloq has no description of this setting; its meaning is what its name says.";
/** The same for a name shown with escapes (S55): the term is the name as displayed. */
export const unknownSettingEscapedExplanation = `${unknownSettingExplanation} The name is written with escapes, as the note beside it says.`;
/** The phrases shown for a value a code span cannot hold (S45, P4-R1-1): the empty text, and spaces alone. */
export const emptyTextPhrase = "(empty text)";
export function spacesPhrase(n: number): string {
  return `(${n} ${n === 1 ? "space" : "spaces"})`;
}
/**
 * The note beside a value shown with escapes (S48): what each escape stands for. Its escapes are code spans, so that the
 * page, the terminal and conversation.md read them alike.
 */
export const ESCAPED_VALUE_NOTE =
  "(Characters that cannot be shown are written as escapes: `\\n` is a line break (in a value, one at its start or end), `\\r` a carriage return, `\\uXXXX` the character with that hexadecimal code (`\\u0020` a space), and `\\\\` a backslash of the value or name.)";
const WHITESPACE_NAMES: Readonly<Record<string, readonly [string, string]>> = {
  " ": ["space", "spaces"],
  "\t": ["tab", "tabs"],
  "\n": ["line break", "line breaks"],
  "\r": ["carriage return", "carriage returns"],
  "\u00a0": ["non-breaking space", "non-breaking spaces"],
};
/**
 * The phrases that stand for a value of a tool's input that is shown as plain text, not as code (W1-R1-1, S60): a
 * boolean, null, the empty text, an empty list or object, an input with no settings. A number is shown as code.
 */
export const YES_PHRASE = "(yes)";
export const NO_PHRASE = "(no)";
export const NONE_PHRASE = "(none)";
/** Every fixed value phrase; a function, since the S60 phrases are declared further down. */
const fixedValuePhrases = (): readonly string[] => [YES_PHRASE, NO_PHRASE, NONE_PHRASE, emptyTextPhrase, EMPTY_LIST_PHRASE, EMPTY_OBJECT_PHRASE, NO_INPUT_PHRASE];
const hex4 = (ch: string): string => (ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The name of one run of whitespace, one or many, as whitespaceRuns writes it: from WHITESPACE_NAMES, or a code point. */
const RUN_ONE = `(?:${[...Object.values(WHITESPACE_NAMES).map(([one]) => escapeRe(one)), "character U\\+[0-9A-F]{4,6}"].join("|")})`;
const RUN_MANY = `(?:${[...Object.values(WHITESPACE_NAMES).map(([, many]) => escapeRe(many)), "characters U\\+[0-9A-F]{4,6}"].join("|")})`;
const RUN = `(?:1 ${RUN_ONE}|(?:[2-9]|[1-9]\\d+) ${RUN_MANY})`;
/** The phrases whitespaceRuns can write, and nothing else: "(1 space)", "(1 tab, then 2 spaces)". */
const WHITESPACE_PHRASE = `\\(${RUN}(?:, then ${RUN})*\\)`;
/**
 * The value phrase that starts at position `at` of a text, the longest there, or null (W1-R1-1): one of the fixed phrases,
 * or a phrase whitespaceRuns can write, whatever values a request holds, so that a value an agent adds is found too.
 */
export function valuePhraseAt(text: string, at: number): string | null {
  const whitespace = new RegExp(WHITESPACE_PHRASE, "y");
  whitespace.lastIndex = at;
  const found = [...fixedValuePhrases().filter((p) => text.startsWith(p, at)), ...(whitespace.exec(text) ?? [])];
  return found.reduce<string | null>((longest, p) => (longest === null || p.length > longest.length ? p : longest), null);
}
/** A value of whitespace alone, named as its runs in order (S48, P5-R1-1): "(1 tab, then 2 spaces)". */
const whitespaceRuns = (value: string): string => {
  const runs = [...value.matchAll(/(\s)\1*/gu)].map((m) => {
    const [one, many] = WHITESPACE_NAMES[m[1]] ?? [`character U+${hex4(m[1])}`, `characters U+${hex4(m[1])}`];
    const n = [...m[0]].length;
    return `${n} ${n === 1 ? one : many}`;
  });
  return `(${runs.join(", then ")})`;
};
/** The characters a code span or a browser changes or hides (S48): controls but tab and line break, format and invisible characters. */
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;
const SPECIAL_SPACE = /[^\S \t\n]/u;
/**
 * How a string value is shown (S48): as it is; as a phrase, when it is empty or whitespace alone; or with escapes, when
 * it holds a character a code span or a browser would change or hide, or a special space at an edge. With escapes, the
 * value's own backslashes are doubled, a carriage return is `\\r` and any other such character `\\uXXXX`.
 */
export type ShownValue = Readonly<{ kind: "literal" | "escaped" | "phrase"; text: string }>;
export function shownValue(value: string): ShownValue {
  return shownText(value, false);
}
/**
 * A name shown on one line (S55, S57), one-to-one over non-empty names: a name with a backslash, a line break, a hidden
 * character or whitespace alone is escaped (its backslashes doubled, each whitespace character of a whitespace-only name
 * written as its escape); any other name is literal and contains no backslash. Never a phrase, so never blank.
 */
export function shownName(name: string): ShownValue {
  if (/^\s+$/u.test(name)) return { kind: "escaped", text: [...name].map(escapeOf).join("") };
  const shown = shownText(name, true);
  return shown.kind === "literal" && name.includes("\\") ? { kind: "escaped", text: name.replaceAll("\\", "\\\\") } : shown;
}
const escapeOf = (ch: string): string => (ch === "\r" ? "\\r" : ch === "\n" ? "\\n" : `\\u${hex4(ch)}`);
function shownText(value: string, inline: boolean): ShownValue {
  if (value === "") return { kind: "phrase", text: emptyTextPhrase };
  if (/^\s+$/u.test(value)) return { kind: "phrase", text: whitespaceRuns(value) };
  const chars = [...value];
  const lead = (/^\s*/u.exec(value)?.[0] ?? "").length;
  const trail = value.length - (/\s*$/u.exec(value)?.[0] ?? "").length;
  let at = 0;
  const marks = chars.map((ch) => {
    const i = at;
    at += ch.length;
    // S54: a line break at the start or end of a value is lost or merged by the renderer, so it is escaped too.
    return HIDDEN.test(ch) || (inline && ch === "\n") || ((SPECIAL_SPACE.test(ch) || ch === "\n") && (i < lead || i >= trail));
  });
  if (!marks.some((m) => m)) return { kind: "literal", text: value };
  const text = chars.map((ch, i) => (marks[i] ? escapeOf(ch) : ch === "\\" ? "\\\\" : ch)).join("");
  return { kind: "escaped", text };
}
const longestRun = (value: string, ch: string): number => Math.max(0, ...[...value.matchAll(new RegExp(`\\${ch}+`, "g"))].map((m) => m[0].length));
/** A text as a Markdown code span shown exactly (S45): the delimiter one backtick longer than its longest run, padded where an edge is a backtick or a space. */
const spanOf = (text: string): string => {
  const tick = "`".repeat(longestRun(text, "`") + 1);
  const pad = /^[` ]|[` ]$/.test(text) ? " " : "";
  return `${tick}${pad}${text}${pad}${tick}`;
};
/**
 * A single-line value as a Markdown code span (S45, S48): shown exactly, or with escapes (`shownValue`); the empty text
 * and whitespace alone, which a code span cannot show, as phrases.
 */
export function codeSpan(value: string): string {
  const shown = shownValue(value);
  return shown.kind === "phrase" ? shown.text : spanOf(shown.text);
}
/** The fence of a multi-line value's code block (S45): longer than any run of backticks in it, at least three. */
export function codeFence(value: string): string {
  return "`".repeat(Math.max(3, longestRun(value, "`") + 1));
}
/**
 * A code piece's text as a Markdown code span, exactly as it is (S9 of the task of issue #36): the program escapes a
 * value before it becomes a piece (`shownValue`), so the span adds nothing; the empty text is its phrase. A text of
 * spaces alone is not padded, since CommonMark strips no space from such a span (W7-R1-1).
 */
export function exactCodeSpan(text: string): string {
  return text === "" ? emptyTextPhrase : /^ +$/.test(text) ? `\`${text}\`` : spanOf(text);
}
/** The phrases of containers without content (S60, W8-R1-2): plain text, never code, so none looks like a string value. */
export const EMPTY_LIST_PHRASE = "(empty list)";
export const EMPTY_OBJECT_PHRASE = "(empty object)";
export const NO_INPUT_PHRASE = "(no settings)";
const isEmptyObject = (v: unknown): boolean => v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0;
/** The plain label of a field, looked up by own properties only (S55: "constructor" is no label). */
const knownLabel = (key: string): string | null => (Object.hasOwn(TOOL_INPUT_LABELS, key) ? TOOL_INPUT_LABELS[key] : null);
const fieldLabel = (key: string): string => knownLabel(key) ?? unknownSettingLabel(key);
/** The keys of a tool's input, nested ones included, that have no plain label, each once, in order. */
const unknownKeys = (v: unknown): readonly string[] =>
  v === null || typeof v !== "object" ? [] : Array.isArray(v) ? v.flatMap(unknownKeys) : Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [...(knownLabel(k) !== null ? [] : [k]), ...unknownKeys(x)]);
/** The names of the fields without a plain label, as displayed (S55), each once, with the id of its explanation. */
const unknownNames = (input: unknown): readonly Readonly<{ id: string; shown: ShownValue }>[] =>
  [...new Set(unknownKeys(input).filter((k) => k !== "").map(shownName))]
    .filter((shown, i, all) => all.findIndex((o) => o.text === shown.text) === i)
    .map((shown, i) => ({ id: `${TOOL_SETTING_REF}${i + 1}`, shown }));
/** The prefix of the ids of the program's own explanations of a tool's settings, which a context call keeps (S9). */
export const TOOL_SETTING_REF = "setting-";
/** One explanation per field without a plain label (P2-R1-2): its name as displayed, with the fixed explanation. */
export function toolInputExplanations(input: unknown): readonly Explanation[] {
  return unknownNames(input).map(({ id, shown }) => ({ id, term: shown.text, explanation: shown.kind === "literal" ? unknownSettingExplanation : unknownSettingEscapedExplanation }));
}
const plainPiece = (text: string): Piece => ({ text, ref: "", code: false });
const codePiece = (text: string): Piece => ({ text, ref: "", code: true });
/**
 * ESCAPED_VALUE_NOTE as pieces (S37): a plain piece never carries code, so each escape the note explains, a code span of
 * its text, is a code piece of its own, and the words between them plain pieces. piecesMarkdown writes them back as the
 * note's text.
 */
const escapedNotePieces = (lead: string): readonly Piece[] =>
  `${lead}${ESCAPED_VALUE_NOTE}`.split(/`([^`]*)`/).map((text, i) => (i % 2 === 1 ? codePiece(text) : plainPiece(text))).filter((p) => p.code || p.text !== "");
/** A row of a tool's input: a list item at its level, a multi-line value as a code block, or the escapes' note below it. */
type InputRow = Readonly<{ kind: "item"; level: number; pieces: readonly Piece[] }> | Readonly<{ kind: "code"; text: string }> | Readonly<{ kind: "note" }>;
/**
 * A tool's input as the user reads it (S34, S45 to S60), as blocks of the details (S9 of the task of issue #36): each
 * field a list item under its plain label, or its own name as code that refers to its explanation (S55); every text value
 * a code piece shown exactly, or with escapes and their note (S48), a multi-line one a code block (S45); the empty text,
 * whitespace alone, an empty list or object and an input with no settings named by their phrases, as plain text (S60).
 */
export function toolInputBlocks(input: unknown): readonly Block[] {
  const ids = new Map(unknownNames(input).map(({ id, shown }) => [shown.text, id]));
  const labelOf = (key: string): readonly Piece[] => {
    const known = knownLabel(key);
    if (known !== null) return [plainPiece(known)];
    if (key === "") return [plainPiece(EMPTY_NAME_LABEL)];
    const shown = shownName(key);
    return [plainPiece("The tool's setting named "), { text: shown.text, ref: ids.get(shown.text) ?? "", code: true }, ...(shown.kind === "escaped" ? escapedNotePieces(" ") : [])];
  };
  const rows = (label: readonly Piece[], sep: string, v: unknown, level: number): readonly InputRow[] => {
    const item = (...pieces: readonly Piece[]): InputRow => ({ kind: "item", level, pieces: [...label, ...pieces].filter((p) => p.code || p.text !== "") });
    if (typeof v === "string") {
      const shown = shownValue(v);
      if (shown.kind === "phrase") return [item(plainPiece(`${sep}${shown.text}`))];
      const note: readonly InputRow[] = shown.kind === "escaped" ? [{ kind: "note" }] : [];
      if (!shown.text.includes("\n")) return [item(plainPiece(sep), codePiece(shown.text), ...(shown.kind === "escaped" ? escapedNotePieces(" ") : []))];
      return [item(plainPiece(sep.trimEnd())), { kind: "code", text: shown.text }, ...note];
    }
    if (Array.isArray(v) && v.length === 0) return [item(plainPiece(`${sep}${EMPTY_LIST_PHRASE}`))];
    if (isEmptyObject(v)) return [item(plainPiece(`${sep}${EMPTY_OBJECT_PHRASE}`))];
    // W1-R1-1: a number is a literal value, shown as code; a boolean and null are the program's phrases.
    if (typeof v === "boolean") return [item(plainPiece(`${sep}${v ? YES_PHRASE : NO_PHRASE}`))];
    if (typeof v === "number") return [item(plainPiece(sep), codePiece(String(v)))];
    if (v === null || v === undefined) return [item(plainPiece(`${sep}${NONE_PHRASE}`))];
    const head = label.length === 0 ? [] : [item(plainPiece(sep.trimEnd()))];
    if (Array.isArray(v)) return [...head, ...v.flatMap((x, i) => rows([plainPiece(`${i + 1}.`)], " ", x, label.length === 0 ? level : level + 1))];
    return [...head, ...Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => rows(labelOf(k), ": ", x, label.length === 0 ? level : level + 1))];
  };
  if (isEmptyObject(input)) return [{ kind: "paragraph", pieces: [plainPiece(TOOL_INPUT_HEADING)] }, { kind: "paragraph", pieces: [plainPiece(NO_INPUT_PHRASE)] }];
  const all = rows([], "", input, 0);
  // Consecutive items form one list; a code block or the escapes' note ends it.
  const blocks = all.reduce<readonly Block[]>((acc, row) => {
    if (row.kind === "code") return [...acc, { kind: "code", text: row.text }];
    if (row.kind === "note") return [...acc, { kind: "paragraph", pieces: escapedNotePieces("") }];
    const last = acc[acc.length - 1];
    const it = { level: row.level, pieces: row.pieces };
    return last?.kind === "list" ? [...acc.slice(0, -1), { kind: "list", items: [...last.items, it] }] : [...acc, { kind: "list", items: [it] }];
  }, []);
  return [{ kind: "paragraph", pieces: [plainPiece(TOOL_INPUT_HEADING)] }, ...blocks];
}
/** What the context call is asked about the fields without a plain label (P2-R1-2). */
export function unknownSettingsRequest(keys: readonly string[]): string {
  return `Interloq has no description of the settings ${keys.map((k) => `"${k}"`).join(", ")}; they are shown to the user under their own names, each a code piece that refers to Interloq's explanation of it. Keep each of those pieces with its ref, and rewrite the explanation of that id to say in ordinary words what the setting does in this request.`;
}
/** A tool's input in prose (S12): each field on its own line, values as text, never the input's JSON. */
export function toolInputProse(input: unknown): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return proseValue(input);
  if (isEmptyObject(input)) return NO_INPUT_PHRASE;
  return Object.entries(input as Record<string, unknown>).map(([k, v]) => `${k}: ${proseValue(v)}`).join("\n");
}
/** One value of a tool's input in prose (S12); an empty list or object by its phrase (S60). */
const proseValue = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? YES_PHRASE : NO_PHRASE) : Array.isArray(v) && v.length === 0 ? EMPTY_LIST_PHRASE : isEmptyObject(v) ? EMPTY_OBJECT_PHRASE : Array.isArray(v) ? v.map(proseValue).join(", ") : v === null || v === undefined ? NONE_PHRASE : Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k} ${proseValue(x)}`).join("; ");
/**
 * The question of a permission request (S12, S49): the tool and the kind of action, pointing at the input shown above it
 * under TOOL_INPUT_HEADING (the terminal prints the details before the question; the page shows them in the region above
 * it). The input itself is never in the question, so that a long command cannot push the answers out of view.
 */
export function permissionQuestion(tool: string, input: unknown): string {
  const fields = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const shown = `shown above under "${TOOL_INPUT_HEADING}"`;
  const what =
    typeof fields.command === "string"
      ? `run the command ${shown}`
      : typeof fields.file_path === "string" || typeof fields.notebook_path === "string"
        ? `use its tool ${tool} on the file ${shown}`
        : typeof fields.url === "string"
          ? `use its tool ${tool} on the web address ${shown}`
          : `use its tool ${tool} as ${shown}`;
  return `Claude Code wants to ${what}. Do you want to allow it?`;
}
/** The facts of a permission request a context call is given (S12). */
export function permissionFacts(tool: string, input: unknown): string {
  const fields = input !== null && typeof input === "object" && !Array.isArray(input) ? Object.entries(input as Record<string, unknown>) : [];
  const lines = fields.length === 0 ? toolInputProse(input) : fields.map(([k, v]) => `${k}${knownLabel(k) !== null ? ` (${knownLabel(k)})` : ""}: ${proseValue(v)}`).join("\n");
  const unknown = toolInputExplanations(input).map((t) => t.term);
  return `Claude Code, while it carries out the plan, asks to use its tool ${tool} with this input:\n${lines}\nIf the user allows it, the tool runs in the project; if not, Claude Code is told so and continues without it. The user is shown the input under the heading "${TOOL_INPUT_HEADING}".${unknown.length === 0 ? "" : `\n${unknownSettingsRequest(unknown)}`}`;
}
/** The facts of the cycle limit a context call is given (S12). */
export function limitFacts(heading: string, limit: number, counts: readonly number[]): string {
  return `${heading} has had ${limit} rounds of review without convergence; the configuration allows ${limit} before the user is asked. The issues Codex counted in each round: ${counts.join(", ") || "none"}.`;
}
/** The facts of the unchanged pause a context call is given (S12). */
export function unchangedFacts(heading: string, fileLabel: string, accepted: readonly string[]): string {
  return `In ${heading}, Claude Code accepted ${accepted.join(", ")} of Codex's review in full or in part, but ${fileLabel}, the file under review, did not change, also after Claude Code was told so.`;
}
/** The two positions at a disputed pause (decision Q1): what Codex asks for, and what Claude Code holds. */
export const REVIEWER_POSITION = "Follow Codex (the reviewer)";
export const PLANNER_POSITION = "Follow Claude Code (the planner)";

// ---- decision support: the representation as the page and the terminal show it ---------------------

/** The heading above a column's disadvantages (docs/decision-making.md, "Layout and wording"); the renderer places it. */
export const DISADVANTAGES_HEADING = "Disadvantages:";
/** The terminal's mark of a text that argues against the column's option, where the page uses the error color (issue #35, Q9). */
export const OPPOSES_MARKER = "✗ ";
/** The heading above a column's advantages (issue #35). */
export const ADVANTAGES_HEADING = "Advantages:";
/** The label of the n-th entry under each heading (issue #35), numbered from one within each heading of each column. */
export function advantageLabel(n: number): string {
  return `Advantage ${n}:`;
}
export function disadvantageLabel(n: number): string {
  return `Disadvantage ${n}:`;
}
/** The heading of a decision's analysis in the page and the terminal (S22): the decision and the number of its question. */
export function decisionViewHeading(k: number, question: number): string {
  return `Decision ${k}: the analysis of ${questionTitle(question)}`;
}
export const RECOMMENDATION_HEADING = "Recommendation";
/** The terminal's heading of an option's arguments. */
export function optionHeading(n: number, label: string): string {
  return `Option ${n}: ${label}`;
}
export function recommendedOption(option: string): string {
  return `Recommended option: ${option}`;
}
/** Below 390 px the analysis is not laid out (decided 28 Sep 2026). */
export const ENLARGE_WINDOW_NOTICE = "The analysis needs a window at least 390 pixels wide. Widen the window to read it; you can answer the question below without it.";
/** Shown when the columns do not fit side by side (decision Q5). */
export const SCROLL_SIDEWAYS_HINT = "Scroll sideways to see every option.";
/** Issue #87: the accessible name of the mark beside a collapsed entry that hides a contradicting position. */
export const ENTRY_DISPUTED_LABEL = "Contains an argument against this entry";
/** Issue #87: the accessible name of an entry's disclosure button, which says what it opens or closes. */
export const entryToggleName = (label: string, title: string, open: boolean): string => `${open ? "Hide" : "Show"} the reasoning of ${label} ${title}`;
export const SHOW_CONVERSATION = "Show the conversation";
/** The page's question pane (S27): back from the conversation to the pending question. */
export const SHOW_QUESTION = "Back to the question";
/** The note beside a context paragraph the program wrote, in the page's question pane (S27). */
export const PROGRAM_CONTEXT_NOTE = "Written by Interloq";
/** An option answered by typing a number (More cycles at the cycle limit, S8), as the page's pane says it (S27). */
export const NUMERIC_OPTION_NOTE = "Type the number of cycles in the field below.";
export const SHOW_ANALYSIS = "Show the analysis";

// Issue #26: the transport faults and their retries, as the user reads them.

/** The SDK's own reconnection during a call: Codex's notice, or the Agent SDK's api_retry with its attempt and delay. */
export function agentReconnectingLine(agent: string, attempt: number | null, of: number | null, delayMs: number | null, detail: string): string {
  const count = attempt === null ? "" : of === null ? ` ${attempt}` : ` ${attempt} of ${of}`;
  const delay = delayMs === null ? "" : ` in ${Math.round(delayMs / 100) / 10} s`;
  return `${agent}: reconnecting${count}${delay} (${detail})`;
}

/** What an api_retry message of the Agent SDK says of its failed request: the status, when there was a response, and the error. */
export function apiRetryDetail(status: number | null, error: string): string {
  return status === null ? `no response, ${error}` : `status ${status}, ${error}`;
}

/**
 * The pause when the retries of a transport fault are exhausted (issue #26, Q2). Its answers are parsed by
 * parseTransportAnswer in src/input.ts, and its widget and options derive from these constants.
 */
export const TRANSPORT_RETRY_AGAIN = "Retry again";
export const TRANSPORT_STOP = "Stop the run";
export const TRANSPORT_ANSWERS = { retry: "r", stop: "s" } as const;
export const transportPrompt = `${TRANSPORT_ANSWERS.retry} = retry again; ${TRANSPORT_ANSWERS.stop} = stop the run > `;
const agentName = (agent: "claude" | "codex"): string => (agent === "claude" ? "Claude Code" : "Codex");
export function transportOptionDescriptions(): Readonly<{ retry: string; stop: string }> {
  return {
    retry: "the call is made again, with another full set of retries and the waits between them starting again from the shortest.",
    stop: "the run ends here, and no further attempt is made.",
  };
}
/** A retry of the program after a transport fault, as the terminal and conversation.md show it. */
export function transportRetryLine(agent: "claude" | "codex", attempt: number, of: number, delaySeconds: number, fault: string): string {
  return `${agentName(agent)}: connection lost, retry ${attempt} of ${of} in ${delaySeconds} s (${fault})`;
}
/** A call that succeeded after a retry. */
export function transportRecoveredLine(agent: "claude" | "codex"): string {
  return `${agentName(agent)}: connection restored`;
}
/**
 * The question of the pause when the retries are exhausted (S52, W5-R1-1): the agent and the kind of call, both chosen
 * by the program. The attempts and the fault, whose length the program does not choose, are in its details.
 */
export function transportExhaustedQuestion(agent: "claude" | "codex", what: string): string {
  return `${agentName(agent)} could not be reached for ${what}; the attempts and the last error are shown above. Do you want Interloq to retry again, or to stop the run?`;
}
/** The heading of the exhaustion pause's details (S52). */
export const TRANSPORT_FAULT_HEADING = "Why the agent could not be reached:";
/**
 * The exhaustion pause's details (S52, P6-R1-1): the attempts in the program's words, and the last fault. The fault is
 * text of the SDK or the CLI, not Markdown, so it is shown literally, as a tool's input is (S45, S48).
 */
export function transportDetails(attempts: number, fault: string): readonly Block[] {
  const shown = shownValue(fault);
  const lead = `Interloq tried ${attempts} ${attempts === 1 ? "time" : "times"}, waiting longer before each new attempt. The last error, as reported:`;
  const note: readonly Block[] = shown.kind === "escaped" ? [{ kind: "paragraph", pieces: escapedNotePieces("") }] : [];
  const fault_: readonly Block[] =
    shown.kind === "phrase"
      ? [{ kind: "paragraph", pieces: [plainPiece(`${lead} ${shown.text}`)] }]
      : shown.text.includes("\n")
        ? [{ kind: "paragraph", pieces: [plainPiece(lead)] }, { kind: "code", text: shown.text }, ...note]
        : [{ kind: "paragraph", pieces: [plainPiece(`${lead} `), codePiece(shown.text), ...(shown.kind === "escaped" ? escapedNotePieces(" ") : [])] }];
  return [{ kind: "paragraph", pieces: [plainPiece(TRANSPORT_FAULT_HEADING)] }, ...fault_];
}
export function transportDecisionLine(answer: "retry" | "stop", agent: "claude" | "codex", what: string): string {
  return `**User decision:** ${answer === "retry" ? "retry again" : "stop the run"} after ${agentName(agent)} could not be reached for ${what}.\n\n`;
}
/** The halt of AgentUnreachable. */
export function agentUnreachableText(agent: "claude" | "codex", attempts: number, lastFault: string): string {
  return `${agentName(agent)} could not be reached after ${attempts} attempts: ${lastFault}. The records are preserved.`;
}

/** What a retried planning call is, as the exhaustion pause names it. */
export function transportWhat(purpose: "planning" | "interview" | "context"): string {
  return purpose === "interview" ? "an interview turn" : purpose === "context" ? "the explanation of a question" : "a planning call";
}
/** What a retried Codex turn is, as the exhaustion pause names it. */
export function transportReviewWhat(heading: string): string {
  return `the review in ${heading}`;
}

/** What a retried execution call is, as the exhaustion pause names it. */
export const TRANSPORT_WHAT_EXECUTION = "the implementation";
/**
 * The prompt of a resumed execution call after a transport fault (issue #26, Q4): the session continues where it was, and
 * the steps are reported with report_step as before.
 */
export const executionContinuePrompt = `The connection to the model dropped during this execution phase. The work done so far is in the project, and the steps you reported so far are recorded. Continue from where you were: call the tool ${REPORT_STEP_TOOL_NAME} as before when a step begins and when it is done, and return the status report at the end.`;

/** The program's retry on the page's activity line, after the agent's name: a count of attempts, not progress. */
export function retryActivity(attempt: number, of: number, fault: string): string {
  return `connection lost, retry ${attempt} of ${of} (${fault})`;
}
/** The SDK's own reconnection on the page's activity line, after the call's label. */
export function reconnectingActivity(attempt: number | null, of: number | null, detail: string): string {
  const count = attempt === null ? "" : of === null ? ` ${attempt}` : ` ${attempt} of ${of}`;
  return `reconnecting${count} (${detail})`;
}

/** The text of a thrown value in a failure message: its text, with its code where the text does not name it (W1-R1-2). */
export function thrownText(text: string, code: string | null): string {
  if (code === null || text.includes(code)) return text === "" ? "the call failed without a message" : text;
  return text === "" ? code : `${text} (${code})`;
}

// ---- the one presentation of a question (S5–S8, issues #46, #57, #59) -----------------------------------------------

/** The heading of every question the user is asked: its number in the run, one sequence whatever produced it (issue #46). */
export function questionTitle(n: number): string {
  return `Question ${n}`;
}
/** The note beside a context paragraph that the program wrote itself (S7, S10). */
export const CONTEXT_BY_PROGRAM = "written by Interloq";
const agentWords = (agent: "claude" | "codex"): string => (agent === "claude" ? "Claude Code, the coding agent," : "Codex, the reviewing agent,");
/**
 * Where a question came from, in ordinary words (S5): the subdued line under its heading. A question inside decision k
 * says that it belongs to the analysis the user asked for, and why it is asked (issue #57).
 */
export function originLine(origin: QuestionOrigin, decision: number | null): string {
  const within =
    decision === null
      ? ""
      : ` This question belongs to Decision ${decision}, the analysis you asked for with "${HELP_ME_DECIDE}": Claude Code cannot work out the arguments for and against an option whose meaning is undetermined, so it asks you first. The analysis follows once you have answered.`;
  return `${originText(origin)}.${within}`;
}
const originText = (origin: QuestionOrigin): string => {
  switch (origin.kind) {
    case "clarification":
      return "One of the questions Claude Code and Codex agreed to ask you before the plan is written";
    case "followUp":
      return "A further question Claude Code asks you while it clarifies the task";
    case "reply":
      return "Claude Code, the planning agent, waits for your reply while it clarifies the task";
    case "confirmSummary":
      return "Asked at the end of the clarification of the task";
    case "planner":
      return `Asked by Claude Code, the planning agent, during ${origin.heading}`;
    case "relayed":
      return "Asked by Claude Code, the coding agent, while it carries out the plan";
    case "execStop":
      return "Claude Code, the coding agent, has stopped carrying out the plan";
    case "permission":
      return "Claude Code, the coding agent, asks for permission while it carries out the plan";
    case "pause":
      return origin.pause === "unexplained" || origin.pause === "identical" || origin.pause === "idle"
        ? `Asked because the review in ${origin.heading} is not making progress`
        : `Asked because Claude Code and Codex disagree during ${origin.heading}`;
    case "limit":
      return `Asked because ${origin.heading} has used all its rounds of review`;
    case "unchanged":
      return `Asked because Claude Code accepted points of the review in ${origin.heading} but did not change the file`;
    case "transport":
      return `Asked because ${origin.agent === "claude" ? "Claude Code" : "Codex"} could not be reached`;
  }
};

/** The subject of a decision in user-decisions.md and conversation.md, records the agents read: the ids, never the displayed number. */
export function recordSubject(origin: QuestionOrigin, question: string): string {
  const text = question.replace(/\s+/g, " ");
  switch (origin.kind) {
    case "pause":
      return pauseSubject(origin);
    case "planner":
    case "relayed":
      return `question from Claude Code: ${text}`;
    case "clarification":
    case "followUp":
      return `question ${origin.id}: ${text}`;
    default:
      return text;
  }
}
const pauseSubject = (p: PauseOrigin): string => {
  switch (p.pause) {
    case "reraised":
      return `issue ${p.id}, raised again after Claude Code did not accept it in full`;
    case "secondClarification":
      return `issue ${p.id}, for which one clarification exchange did not produce a disposition`;
    case "disputedSelfCorrection":
      return `the accepted correction for ${p.id}, which Claude Code now considers wrong`;
    case "reversal":
      return `issue ${p.id} against the accepted correction for ${p.reverses}`;
    case "repeatedUnderNewId":
      return `issue ${p.id}, a repetition of issue ${p.repeats}`;
    case "unexplained":
      return unexplainedChangeSubject(p.fileLabel, p.heading, p.round);
    case "identical":
      return alternatingSubject(p.fileLabel);
    case "idle":
      return idleSubject(p.idle);
  }
};

/** The question a pause of behaviour 7 asks, its interrogative sentence last (issue #34). */
export function pauseQuestion(p: PauseOrigin): string {
  switch (p.pause) {
    case "reraised":
    case "secondClarification":
    case "reversal":
    case "repeatedUnderNewId":
      return "Codex has raised a point that Claude Code does not accept in full. Whose position do you want to stand, Codex's or Claude Code's?";
    case "disputedSelfCorrection":
      return "Claude Code now considers wrong a correction it made earlier for a point that Codex raised. Do you want the correction to stand, as Codex asked, or to be withdrawn, as Claude Code now holds?";
    case "unexplained":
      return `${p.fileLabel} changed, although Claude Code accepted no point of the review and corrected nothing of its own. What do you want done with the change?`;
    case "identical":
      return `${p.fileLabel} has returned to a version it had before, so the review alternates between two versions. Which of the two versions do you want kept?`;
    case "idle":
      return `Claude Code has accepted no point of the review ${p.idle === 1 ? "in the last cycle" : `in ${p.idle} cycles in a row`}. What do you want Claude Code and Codex to do about the points that led to no change?`;
  }
}
/** An agreed question's default, as its option's description marks it (S18). */
export function defaultMarked(description: string): string {
  return description.trim() === "" ? "(the default)" : `${description} (the default)`;
}
/** What the user reads of an agreed question beside its context (S18): why the plan needs the answer. */
export function agreedDetails(reason: readonly Block[]): readonly Block[] {
  return reason.length === 0 ? [] : [{ kind: "paragraph", pieces: [{ text: AGREED_REASON_HEADING, ref: "", code: false }] }, ...reason];
}
/** The heading of an agreed question's reason in its details (S18). */
export const AGREED_REASON_HEADING = "Why the plan needs your answer:";
/** The question of a clarification turn that asks no particular question: its context is Claude Code's message. */
export const REPLY_QUESTION = "What do you want to reply to Claude Code?";
/** The question of the summary's confirmation. */
export const CONFIRM_SUMMARY_QUESTION = "Claude Code has written this summary of the requirements from the clarification. Do you confirm that it states the requirements correctly?";
/**
 * The question at a stop of an execution phase whose report carried no question the user was asked (S52, W5-R1-1):
 * fixed; Claude Code's description is in its details (`execStopDetails`).
 */
export function execStopQuestion(): string {
  return "Claude Code stopped before the plan was finished, for the reason shown above. What do you want Claude Code to know or do when the plan is revised?";
}
/** The heading of an execution stop's details, and what they say when Claude Code gave no description (S52). */
export const EXEC_STOP_HEADING = "Why Claude Code stopped, in its own words:";
export const EXEC_STOP_NO_DESCRIPTION = "Claude Code gave no description of why it stopped.";
/** An execution stop's details (S52): Claude Code's description, its own prose, rendered as Markdown like all of it (issue #7). */
export function execStopDetails(description: string): readonly ShownBlock[] {
  return [
    { kind: "paragraph", pieces: [{ text: EXEC_STOP_HEADING, ref: "", code: false }] },
    description.trim() === "" ? { kind: "paragraph", pieces: [{ text: EXEC_STOP_NO_DESCRIPTION, ref: "", code: false }] } : { kind: "document", markdown: description.trim() },
  ];
}

/**
 * The fixed context paragraph of a question the program composes (S7, S10): the components, what they do, where they
 * are, when they act and why, filled in with the facts of the case; shown as written by the program.
 */
export function fallbackContext(origin: QuestionOrigin): string {
  const interloq = "Interloq, the orchestrator that runs this task, starts two AI agents in this project and passes their work between them: Claude Code, the planning and coding agent, writes the plan and carries it out, and Codex, the reviewing agent, checks each document and the finished work.";
  switch (origin.kind) {
    case "clarification":
    case "followUp":
      return `${interloq} Before the plan is written, Claude Code asks you questions in a conversation, so that the plan follows your decisions and not its own assumptions.`;
    case "reply":
      return `${interloq} Before the plan is written, Claude Code clarifies the task with you in a conversation.`;
    case "confirmSummary":
      return `${interloq} At the end of the clarification, Claude Code writes a summary of your answers, the requirements document, which Codex then checks and from which the plan is written. Your confirmation makes it the record the plan must follow.`;
    case "planner":
      return `${interloq} While Claude Code writes or revises a document during ${origin.heading}, it may find a decision that only you can make. It asks you here rather than deciding on an assumption, so that the plan follows your choice.`;
    case "relayed":
      return `${interloq} While Claude Code carries out the plan, changing the project's files, it may need a decision it cannot take on its own. It stops and asks you, and the plan is revised and reviewed with your answer before the work continues.`;
    case "execStop":
      return `${interloq} Claude Code stopped carrying out the plan before it was finished (status: ${origin.status}). What you write here is recorded and given to Claude Code, which revises the plan with it; Codex reviews the revision before the work continues.`;
    case "permission":
      return `${interloq} While Claude Code carries out the plan, it asks before it uses a tool that Interloq's permission settings do not allow on their own: here ${origin.tool}, with the input shown below. If you allow it, the tool runs in this project; if not, Claude Code is told so and continues without it. The question protects the project from an action you did not intend.`;
    case "pause":
      return origin.pause === "unexplained" || origin.pause === "identical" || origin.pause === "idle"
        ? `${interloq} During ${origin.heading}, Codex reviews a document in rounds and Claude Code answers each point and amends the document. When the rounds stop making progress, Interloq halts the review and asks you how to continue, so that the agents do not go round in circles at your cost.`
        : `${interloq} During ${origin.heading}, Codex reviews a document in rounds, and Claude Code accepts, rejects or questions each point it raises. When the two keep disagreeing about a point, Interloq stops the review and asks you to settle it, so that the document follows your judgment rather than whichever agent insists longer.`;
    case "limit":
      return `${interloq} During ${origin.heading}, Codex reviews a document in rounds until it raises no further point; the configuration allows ${origin.limit} rounds. They are used up without agreement, so Interloq asks you whether to continue, accept the document as it is, or stop, because further rounds take time and cost money.`;
    case "unchanged":
      return `${interloq} During ${origin.heading}, Claude Code accepted points ${origin.accepted.join(", ")} of Codex's review but did not change ${origin.fileLabel}, the file under review, even after being told so. Interloq asks you how to continue, because an accepted point that changes nothing would otherwise be reviewed again and again.`;
    case "transport":
      return `${interloq} Every call to an agent goes over the network. ${agentWords(origin.agent)} could not be reached for ${origin.what} after ${origin.attempts} attempts; the last error is shown below. Interloq waited and tried again automatically. It now asks you whether to try again or stop the run; the run's records are kept either way.`;
  }
}

// ---- a pause's facts as prose (S11, issue #19) -------------------------------------------------------------------------

/** What Claude Code did with an issue, in words: a disposition's action, never its literal value. */
export function dispositionWords(action: "accepted" | "partially_accepted" | "rejected" | "no_change_needed" | "clarification_requested"): string {
  switch (action) {
    case "accepted":
      return "accepted it";
    case "partially_accepted":
      return "accepted it in part";
    case "rejected":
      return "rejected it";
    case "no_change_needed":
      return "found that no change was needed";
    case "clarification_requested":
      return "asked Codex to clarify it";
  }
}
/** What Claude Code did to its own earlier work, in words. */
export function selfCorrectionWords(action: "accepted" | "plan_error" | "correction_disputed"): string {
  switch (action) {
    case "accepted":
      return "withdrew its earlier rejection and accepted the point";
    case "plan_error":
      return "corrected an error of its own";
    case "correction_disputed":
      return "said that its earlier correction was wrong";
  }
}
/** One earlier entry of an issue's history. */
export function reviewEntryLine(round: number, problem: string, action: string, rationale: string): string {
  return `In cycle ${round}, Codex raised it: ${problem.trim()} — Claude Code ${action}: ${rationale.trim()}`;
}
export function selfCorrectionLine(round: number, action: string, rationale: string): string {
  return `In cycle ${round}, Claude Code ${action}: ${rationale.trim()}`;
}
export function userDecisionLine(round: number, rationale: string): string {
  return `In cycle ${round}, you decided: ${rationale.trim()}`;
}
export const HISTORY_HEADING = "What happened to this point before:";
export const CODEX_SAYS = "Codex says:";
export function claudeAnswers(action: string, rationale: string): string {
  return `Claude Code ${action}: ${rationale.trim()}`;
}
/** The first sentence of each pause's facts. */
export function pauseLead(p: PauseOrigin): string {
  switch (p.pause) {
    case "reraised":
      return `Codex has raised issue ${p.id} again, although Claude Code did not accept it in full.`;
    case "secondClarification":
      return `Claude Code asks for a clarification of issue ${p.id} a second time; one exchange did not settle it.`;
    case "disputedSelfCorrection":
      return `Claude Code now considers wrong the correction it made for issue ${p.id}.`;
    case "reversal":
      return `Codex's issue ${p.id} asks to reverse the correction that was made for issue ${p.reverses}.`;
    case "repeatedUnderNewId":
      return `Codex's issue ${p.id} repeats issue ${p.repeats}, which Claude Code did not accept in full.`;
    case "unexplained":
      return `${p.fileLabel} changed in cycle ${p.round} although Claude Code accepted no issue, corrected nothing of its own and had no decision of yours to apply.`;
    case "identical":
      return `${p.fileLabel} has returned to an earlier version.`;
    case "idle":
      return `Claude Code accepted no issue ${p.idle === 1 ? "in the last cycle" : `in ${p.idle} cycles in a row`}.`;
  }
}
/** Claude Code's own account of a response that changed the file unexplained. */
export function claudeResponseText(text: string): string {
  return text.trim() === "" ? "Claude Code gave no account of its response." : `Claude Code's own account of its response: ${text.trim()}`;
}
export function identicalFacts(fileLabel: string, round: number, seen: string): string {
  return identicalContentLine(fileLabel, round, seen).trim();
}
export const IDLE_ISSUES_HEADING = "The issues of the last cycle that led to no change:";

// ---- the context call (S9, decision Q1) -----------------------------------------------------------------------------

/** What a context call is given: the question the program composed, where it arises, and what the program records of it. */
export type ContextRequest = Readonly<{
  origin: QuestionOrigin;
  decision: number | null;
  question: readonly Piece[];
  options: readonly PieceOption[];
  /** What the question is about, as the program records it (a pause's facts, S11), as blocks; empty when none. */
  details: readonly Block[];
  /** The program's own explanations (of a tool's settings, S55), which the pieces of the details refer to. */
  explanations: readonly Explanation[];
  /** Further facts of the case in prose (the tool and its input, the counts), or "". */
  facts: string;
}>;
/** Whether the request holds a code piece with a ref, which the reply must keep (S9, KEEP_SUPPLIED_REFS). */
const suppliesRefs = (request: ContextRequest): boolean =>
  [...request.question, ...request.options.flatMap((o) => [...o.label, ...o.description]), ...request.details.flatMap((b) => (b.kind === "paragraph" ? b.pieces : b.kind === "list" ? b.items.flatMap((i) => i.pieces) : []))].some(
    (p) => p.code && p.ref !== "",
  );
/**
 * The call that writes the context paragraph of a question the program composed, and returns the whole question as
 * pieces (S9; decisions G-R1-1 and F1): a fresh session that may read the project and change nothing (S33), with the
 * rules of every question and the format of its text. It may rephrase the question, the options and the details; it
 * keeps the options in their positions and every literal value exactly, and the references the program supplied.
 * `contextValidation` in src/questionContext.ts checks the reply against the same clauses.
 */
/** The line before the question as data in a context call's prompt; the JSON follows it on the next line, to the end. */
export const CONTEXT_REQUEST_HEADING = "The question as Interloq wrote it, as data (question, options, details, explanations):";
export function contextPrompt(task: string, request: ContextRequest): string {
  const facts = request.facts.trim() === "" ? "" : `Facts for your understanding, not shown to the user:\n${request.facts}\n`;
  const question = JSON.stringify({ question: request.question, options: request.options, details: request.details, explanations: request.explanations });
  return `Interloq, the program that runs this task, is about to ask the user the question below. Write the context paragraph that the user reads before it, and return the whole question as pieces, with the explanations of the words a reader may not know. You may read the project to understand it; do not modify any file, do not use the AskUserQuestion tool, and do not answer the question.
${questionWritingRules()}
${QUESTION_TEXT_FORMAT}
Return in context your paragraph, which places the reader before he is asked. Return in question, options and details the question, its options and what the user is shown with it: you may rephrase their prose and divide it into pieces that refer to explanations, but keep what they say. ${KEEP_OPTIONS} ${KEEP_LITERALS}${suppliesRefs(request) ? ` ${KEEP_SUPPLIED_REFS}` : ""} Return in explanations every explanation that a piece of your reply refers to.

The task of the run: ${task}

Where the question arises: ${originLine(request.origin, request.decision)}
${facts}
${CONTEXT_REQUEST_HEADING}
${question}`;
}
/** The fallback's note in conversation.md when no context could be written (S10): the question is shown with the program's paragraph. */
export function contextFallbackNote(reason: string): string {
  return `**Context written by Interloq:** the explanation of the next question could not be written (${reason}); it is shown with the program's own paragraph.\n\n`;
}

/** The facts of the transport pause a context call is given (S12). */
export function transportFacts(agent: "claude" | "codex", what: string, attempts: number, fault: string): string {
  return `${agentName(agent)} could not be reached for ${what} after ${attempts} attempts; the last error was: ${fault}. Interloq waited between the attempts, each time twice as long as before. Retry again makes another full set of attempts; Stop the run ends the run and keeps its records.`;
}

/** The facts of a relayed question without the shape that a context call is given (S14, Q2): the plan being carried out. */
export function relayedFacts(plan: string | null): string {
  return `Claude Code asked this question while it carried out the plan, and waits for the answer; the plan is revised and reviewed with the answer before the work continues.\n${plan === null ? "plan-review/plan.md does not exist." : `The plan being carried out (plan-review/plan.md):\n${plan}`}`;
}

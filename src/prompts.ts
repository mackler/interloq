// Prompt texts. All paths are relative to the project directory.

import { pathOf, RECORDS_DIR, recordPath, type RunRoot } from "./artifacts.ts";
import { FILE_CHANGE_FIELD, TASK_DISPUTE_FIELD, type Block, type CommandLine, type StepChecks, type ExecOutcome, type Explanation, type LogEntry, type Piece, type PieceOption, type Review, type TermsMode } from "./schema.ts";
import type { ShownBlock } from "./pieces.ts";
import type { InterviewStage } from "./uiEvents.ts";
import type { AttachedKind, PauseOrigin, QuestionOrigin } from "./question.ts";
import type { Skipped, SkipProblem, TurnProblem } from "./premises.ts";
import type { RunMode } from "./runMode.ts";
import type { NamedEnd } from "./claudeEvents.ts";
import type { ProcessEnd } from "./transport.ts";
import type { ManifestProblem } from "./manifestCheck.ts";
import { checkTotals } from "./stepChecks.ts";
import { type OutsideStop, SUITE_TAIL_LINES, type SuiteFailure, type SuiteOutcome, type SuiteStop, type WorkFailure } from "./suite.ts";
import type { ReviewThread } from "./reviewThread.ts";
import type { NonEmptyPaths } from "./commitCheck.ts";
import type { WriteCheck } from "./errors.ts";
import type { TrackerOperation } from "./trackerRetry.ts";
import { type LimitWaitBasis, USAGE_LIMIT_RETRY_SECONDS } from "./limitReset.ts";

/**
 * The run's records directory as the prompts name it, relative to the project: plan-review/<root> (issue #120). Every
 * prompt that names a record takes the run's root, so that one run's agents read and write their own run's records.
 */
const runDir = (root: RunRoot): string => `${RECORDS_DIR}/${root}`;

const SEVERITY = `Severity: blocking = the work cannot succeed with the file as written; major = the file as written will produce a defect or omits something required; minor = everything else.`;

/** Rules for the use of an issue log. They are the same for every reviewed file. */
function logRules(root: RunRoot, logFile: string, idPrefix: string, round: number): string {
  return `${runDir(root)}/${logFile} is a JSON object whose 'entries' list every issue raised in earlier rounds with the planner's disposition and rationale, in order.
Every entry has id, phase, round, source, problem, action, rationale and superseded. An entry with superseded = true has been replaced by a later entry with the same id; use the later entry.
An entry with source 'review' is an issue you raised: it also has severity, location, evidence, the planner's action ('accepted', 'partially_accepted', 'rejected', 'no_change_needed' or 'clarification_requested'), and duplicate_of and reverses, each the id of an earlier issue or null. ${TASK_DISPUTE_FIELD} is true where the planner marked its disagreement with the issue as about what the task requires, not about how a question is worded; false otherwise.
An entry with source 'self_correction' records a correction that the planner made to its own earlier work (action 'accepted', 'plan_error' or 'correction_disputed').
Every entry with source 'review' or 'self_correction' also has ${FILE_CHANGE_FIELD}: what the program measured in the reviewed file during the planner's response in that round, for all of that round's entries together: changed (true or false), and the numbers of lines added and removed; null where nothing was measured. It is the program's measurement, not the planner's claim. If an 'accepted' or 'partially_accepted' entry's rationale describes amendments that ${FILE_CHANGE_FIELD} does not bear out, raise it as an issue.
An entry with source 'user' (action 'decided_by_user') contains a decision of the user on that issue, which must be followed.
The rationale of every entry is addressed to you; read it irrespective of the action.
${runDir(root)}/reviewer-feedback.md contains feedback from the planner that concerns no single issue; take it into account.
For an entry with action 'clarification_requested', the rationale contains a question to you: if the issue is valid, raise it again under the same id and answer the question in the evidence field; if the question shows the issue to be mistaken, omit the issue.
${runDir(root)}/user-decisions.md contains input and decisions by the user, which must be followed; do not raise an issue that contradicts them.
Do not repeat an issue whose action is 'accepted' unless the file still contains the defect.
Do not repeat an issue whose action is 'rejected', 'no_change_needed', or 'partially_accepted', under the same or a different wording, unless you can state a specific error in the rationale; in that case reuse the original id and state the error in the evidence field.
Do not raise an issue whose correction would undo the correction made for an accepted issue in the log; if you consider an accepted correction wrong, reuse the id of that issue and state the error in the evidence field.
${SEVERITY}
Return an empty issues array when no issue is found.
New issues receive ids of the form ${idPrefix}-R${round}-1, ${idPrefix}-R${round}-2, and so on.`;
}

function laterRound(root: RunRoot, file: string, logFile: string, idPrefix: string, round: number): string {
  return `The planner has answered your issues; the answers are in ${runDir(root)}/${logFile}, and ${runDir(root)}/${file} may have been amended.
Read both files again and review ${runDir(root)}/${file} again under the same rules as before. New issues receive ids of the form ${idPrefix}-R${round}-1, ${idPrefix}-R${round}-2, and so on.`;
}

/**
 * The opening of a later round's prompt in a new Codex thread (issue #165, requirements Q1): the thread has not seen the
 * earlier rounds, so the issue log, which carries them, is named, and the first round's instructions follow.
 */
export const newThreadSentence = (root: RunRoot, logFile: string, round: number): string =>
  `This is round ${round} of this review. Its earlier rounds were held in another conversation, which you cannot see; every issue raised in them, with the planner's disposition and rationale, is in ${runDir(root)}/${logFile}, and the reviewed file may have been amended since. Review the file again in full under the instructions below, taking that log into account.`;

/**
 * A review prompt by its round and thread (issue #165): round 1 is the first round's instructions; a later round in the
 * loop's continued thread is the later-round text, which refers to the instructions the thread holds; a later round in a
 * new thread is `newThreadSentence` and then the first round's instructions built for that round.
 */
const byThread = (round: number, thread: ReviewThread, logFile: string, root: RunRoot, later: () => string, first: () => string): string =>
  round === 1 ? first() : thread === "continued" ? later() : `${newThreadSentence(root, logFile, round)}\n${first()}`;

/**
 * The line said on the page and written to conversation.md when a review's next round starts a new Codex thread
 * (issue #165, the requirements' open point).
 */
export const threadRestartLine = (heading: string, round: number, inputTokens: number, limit: number): string =>
  `${heading}: Codex's last turn took ${inputTokens.toLocaleString("en-US")} input tokens, more than the ${limit.toLocaleString("en-US")} set by codexTurnInputLimit; round ${round} starts a new Codex thread, which reads the issue log instead of the earlier conversation.`;

/** The heading of the explanations of terms: in conversation.md (decision Q6) and in a relayed question's text (S13). */
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
    // Issues #95 and #99 (6 Oct 2026): the one statement of whether to ask, and of the premise a question's options share.
    id: "whetherToAsk",
    rule: "Where you decide whether to ask a question, ask it only if all three hold: its answer changes the plan or the work; nothing available settles it, neither the task text, the codebase, the project documentation, nor an answer the user has already given; and a difference the reader can act on, as stated below for each option, can be named between its options. Where any of the three fails, do not ask: settle the matter yourself and say what you settled. Before asking, state the premise the options share, what is true if any of them is chosen. If the same sources do not settle that premise, the premise is the question, and it is asked first; a question whose options all rest on an unsettled premise is not asked until the premise is.",
    criterion: "a question is asked that the task text, the codebase, the project documentation or an earlier answer of the user settles (name the file or the answer), or whose answer changes neither the plan nor the work, or whose options differ in nothing the reader can act on; or every proposed answer of a question assumes a premise that none of those sources establishes (name the premise and the files that would have settled it), and the premise is not asked first.",
  },
  {
    // Issue #111 (8 Oct 2026): beside whetherToAsk, whose second clause it sharpens. The explanations exist so that a
    // reader who has never seen the code can understand a question; a question that asks him for that knowledge defeats them.
    id: "explainedKnowledge",
    rule: "Never ask the reader for knowledge that the question's own explanations exist to give him: not what a term means or should mean, and not whether a term needs explaining. Either he holds that knowledge, and the explanation is unnecessary for him, or he does not, and he cannot answer. Where a term means something particular in this program, the code settles its meaning, so read the codebase and do not ask, as the second condition of whether to ask requires. A question about which of two wordings helps the reader is not this: there the options differ in how they read, not in what they claim, and he chooses between two texts he can see.",
    criterion: "a question asks the reader what a term means or should mean, or whether a term needs explaining to him, including a term whose meaning in this program the codebase settles; a question that offers two wordings for the reader to choose between, differing in how they read and not in what they claim, is not this.",
  },
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
    // Issue #133, decision Q1 (12 Oct 2026): the history is written apart from the context, and each page shows it under a heading of its own.
    id: "historyApart",
    rule: "Write the history apart from the context. The context states the present situation and the technical background the choice turns on. The history (the field `history`) states what happened before that led to the question: the reader's earlier decisions with their dates, earlier runs or issues, and what was tried; it is empty when there is none. Neither repeats the other. The rule against recounting how the situation was learned applies to the context, not to the history.",
    criterion: "a question's history is written in the context (an earlier decision, run, issue or attempt that led to the question), its background is in the history (the present situation or the technical facts the choice turns on), or one repeats the other.",
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
    rule: "Ask which outcome the reader wants. Never ask where a line of code goes, which module holds a value, or which of two arrangements of the same program to adopt: where two implementations are being chosen between, ask about the outcomes that differ; how the program is arranged then follows from the answer. A question in the right tense can still break this rule.",
    criterion: "a question asks where code goes, which module holds a value, or which arrangement of the same program to adopt, instead of which of the outcomes that differ the reader wants.",
  },
  {
    // Issue #96 (6 Oct 2026): the label names the outcome, the description what produces it.
    id: "determinateOptions",
    rule: "Give every option a meaning that cannot be taken two ways. Its label names the outcome the reader gets, in the reader's terms, never the mechanism that produces it; its description says what produces that outcome, so that the arguments for and against it can be worked out from what the option says, as docs/decision-making.md requires of an analysis. A label that refers to a state in time ('as they are now', 'the current one') says which: the behavior before the change, or the state at the moment of asking.",
    criterion: "a question or an option can be taken two ways (a label such as 'as they are now' that does not say whether it means the behavior before the change or the state at the moment of asking included), or an option's label names the mechanism instead of the outcome the reader gets, or its description does not say what produces that outcome, so that the arguments for and against it cannot be worked out from what it says, as docs/decision-making.md requires of an analysis.",
  },
  {
    id: "optionDifferences",
    rule: `Write each option's description so that it states only how that option differs from the other options: it must read correctly after these words, which are never shown to the user: "${OPTION_DIFFERENCE_PREAMBLE}" An aspect that two options share is described in neither of them. Where an option differs from some of the others but not all, it names which ones before stating that difference. Where it has several differences, state them in descending order of how many other options they distinguish it from.`,
    criterion: `an option's description does not read correctly after "${OPTION_DIFFERENCE_PREAMBLE}", describes an aspect it shares with another option, states a difference from only some options without naming them first, or does not order its differences by how many other options they distinguish it from.`,
  },
  {
    // Issue #92 (5 Oct 2026): each option says what choosing it changes for the reader; issue #97 (6 Oct 2026): computed
    // for the configuration the task names.
    id: "readerConsequence",
    rule: "In each option's description, state what choosing it changes for the reader, in terms the reader can act on: time spent or saved, work that falls to someone later, a risk carried, money, or what the reader must do differently while a run is going; not only what the program would do differently. Where the task names a concrete configuration (a window size, a file, a count, a version), compute each option's consequence for that configuration and state it in those terms, not in general terms or as a condition the reader must evaluate ('when X is taller than Y'); where the numbers cannot be had without building something, say so in the option.",
    criterion: "an option states only what the program would do and not what choosing it changes for the reader (time, work that falls to someone later, a risk, money, or what the reader must do differently during a run); or, where the task names a concrete configuration (a window size, a file, a count, a version), an option describes its consequence in general terms or as a condition the reader must evaluate ('when X is taller than Y') instead of computing it for that configuration, without saying that it cannot be computed without building something.",
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
    rule: "List in explanations every word or phrase that a reader who has never seen this codebase may not know (the program's vocabulary, an SDK's, a third-party library's), each with one or more plain, non-empty senses: definitions in ordinary words, not cross-references; and let every piece of the text that uses it, wherever it occurs, refer to that explanation.",
    criterion: "a word or phrase that a reader who has never seen this codebase may not know has no explanation, or a piece that uses it does not refer to it, or a sense of its explanation is empty, a cross-reference, or does not make it intelligible.",
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
    text: 'Write a context, a history (and any details) as a list of blocks, each with its kind: a paragraph (kind "paragraph", with its pieces), a bulleted list (kind "list", with its items, each with its level, 0 at the top and one more per nesting, and its pieces), or a code block (kind "code", with its text, a value shown exactly).',
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
    text: "explanations: one list per question, referred to from all of its parts. Each entry has an id unique in the question, term (the name of the word or phrase, as a reader would look it up) and senses, and at least one piece refers to it. The term is non-empty. senses is a list of one or more non-empty texts, each a definition in ordinary words; give a second sense only where the term has two meanings that both bear on the question, as a dictionary gives more than one sense of a word, and the reader is shown them numbered in the order given. Every question carries all of its own explanations, even where an earlier question explained the same term.",
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
export const KEEP_WORDING = "Keep the wording of each agreed question exactly: every field's words, joined in order, and its blocks, their kinds and list levels, must be what the agreed question list, questions.json, holds; only the division into pieces and the references to explanations are yours.";
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
  "noSense",
  "blankSense",
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
  "entryCount",
] as const;
export type QuestionProblemKind = (typeof QUESTION_PROBLEM_KINDS)[number];
export const QUESTION_PROBLEM_RULE: Readonly<Record<QuestionProblemKind, string>> = {
  blankContext: "context",
  notLast: "questionLast",
  unknownRef: "refPiece",
  unusedExplanation: "explanations",
  duplicateExplanation: "explanations",
  blankTerm: "explanations",
  noSense: "explanations",
  blankSense: "terms",
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
  entryCount: "keepWording",
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
    case "noSense":
      return `the term ${subject} has no sense: its senses list is empty`;
    case "blankSense":
      return `${problem.subject} is empty`;
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
      return `the explanations name ${subject}, which is not the id of a question of the agreed question list, questions.json`;
    case "wordingChanged":
      return `the words or blocks of its field ${subject} differ from the agreed question`;
    case "literalChanged":
      return "a literal value of the details was changed, removed, added or moved";
    case "optionsChanged":
      return "the options were added, removed or reordered";
    case "suppliedRefDropped":
      return `the name ${subject}, which Interloq supplied with its explanation, lost its reference`;
    case "entryCount":
      return `the reply holds ${problem.subject} entries for this question; it must hold exactly one, for this question`;
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

// ---- the skip conditions of the question list (issue #99) -----------------------------------------------------------

/**
 * The requirements on an entry's skip_if, each stated once: the field's description in the question list's prompt is made
 * of them, and the repair prompt names the one a problem breaks (the seam of issue #99).
 */
export const SKIP_IF_CLAUSES: Readonly<Record<SkipProblem["kind"], string>> = {
  unknownQuestion: "it names another question of this list by its id",
  selfReference: "never the entry's own id",
  unknownAnswer: "and the label of one of that question's proposed answers, word for word",
  cycle: "no question may depend on itself, directly or through other questions",
};
/** The field skip_if of a question-list entry, as the writer of the list reads it. */
export const SKIP_IF_FIELD = `skip_if: null when the question is to be asked whatever the other answers are. Otherwise the answer of another question that makes this question unnecessary: ${SKIP_IF_CLAUSES.unknownQuestion} (question), ${SKIP_IF_CLAUSES.selfReference}, ${SKIP_IF_CLAUSES.unknownAnswer} (answer); ${SKIP_IF_CLAUSES.cycle}. When the user chooses that answer, the program does not put this question to the user, and asks it only after the question it names. Use it where a question's options all rest on a premise that another question asks.`;
const skipProblemText = (problem: SkipProblem): string => {
  switch (problem.kind) {
    case "unknownQuestion":
      return `${problem.id}: its skip_if names ${problem.names}, which is not a question of the list`;
    case "selfReference":
      return `${problem.id}: its skip_if names the question itself`;
    case "unknownAnswer":
      return `${problem.id}: its skip_if names the answer ${JSON.stringify(problem.answer)}, which is not the label of a proposed answer of ${problem.question}`;
    case "cycle":
      return `${problem.ids.join(", ")}: their skip_if conditions form a cycle`;
  }
};
/** One problem of a list's skip conditions, as the repair prompt and the halt state it, with the requirement it breaks. */
export const skipConditionProblemLine = (problem: SkipProblem): string => `- ${skipProblemText(problem)}; ${SKIP_IF_CLAUSES[problem.kind]}.`;
/** The halt after the repair turn could not correct the skip conditions. */
export const skipConditionInvalidText = (problems: readonly SkipProblem[]): string => `the skip conditions of the question list are invalid: ${problems.map(skipProblemText).join("; ")}`;
/** The validation repair turn of a question list whose skip conditions are wrong. */
export const skipConditionRepairPrompt = (problems: readonly SkipProblem[]): string => `Your structured output matched the schema, but the program cannot accept the skip_if of its questions:
${problems.map(skipConditionProblemLine).join("\n")}
The field, as it is to be filled:
${SKIP_IF_FIELD}
Return the complete output again, corrected. Do not modify any file.`;
/** The line under a question-list entry with a skip condition, in conversation.md. */
export const skipIfLine = (condition: Readonly<{ question: string; answer: string }>): string => `Not asked if ${condition.question} is answered ${JSON.stringify(condition.answer)}.`;
/**
 * The program's note that questions were skipped, or are to be asked after all: to Claude Code after the user's message,
 * to the user, and in conversation.md.
 */
export const skippedNote = (skipped: readonly Skipped[]): string =>
  skipped
    .map((k) =>
      k.cause === "answered"
        ? `The program does not put question ${k.id} to the user: the user answered question ${k.question} ${JSON.stringify(k.answer)}, which makes it unnecessary.`
        : `The program does not put question ${k.id} to the user: question ${k.question}, on whose answer it depends, is itself skipped.`,
    )
    .join(" ");
const turnProblemText = (problem: TurnProblem): string => {
  switch (problem.kind) {
    case "summaryOmits":
      return `the summary does not name the skipped question${problem.ids.length > 1 ? "s" : ""} ${problem.ids.join(", ")}`;
    case "followUpIdBlank":
      return "a follow-up question has a blank id";
    case "followUpIdReused":
      return `the follow-up question id ${problem.id} was used before in this interview, or twice in this reply`;
  }
};
/** The halt after the repair turn of an interview reply could not correct it. */
export const interviewTurnInvalidText = (problems: readonly TurnProblem[]): string => `an interview turn is invalid: ${problems.map(turnProblemText).join("; ")}`;
/** Issue #184: the validation repair turn of a reply of the first interview. */
export const clarificationReplyRepairPrompt = (problems: readonly TurnProblem[]): string => validationRepairPrompt(problems.map(turnProblemText), [followUpIdRule(), SUMMARY_SKIPPED_RULE]);
/** Issue #184: how a follow-up question of the first interview is identified. */
const followUpIdRule = (): string => `Give each follow-up question a new id ${FOLLOW_UP_PREFIX}1, ${FOLLOW_UP_PREFIX}2, … that no earlier question of this interview has had, and use each id once.`;
/** Issue #184: the summary's account of the questions the program skipped. */
const SUMMARY_SKIPPED_RULE = `When complete is true, the summary lists every skipped question by its id, with the answer that made it unnecessary, under the heading 'Skipped questions'.`;
/** What the second interview does with the questions the program skipped (issue #99), in its rules. */
export const SKIPPED_RULE = `A question the program reports skipped is not asked: its premise was denied by the user's answer. Ask no question before the question its skip condition names has been answered. ${SUMMARY_SKIPPED_RULE}`;

/** How a question for the user is filled (decision Q1 of the decision-support task), with the rules of every question (S1). */
export const QUESTION_OPTIONS_RULE = `Each entry of questions_for_user has a context, a history, a question, explanations and options. When the question is a choice, give two or more mutually exclusive options, each with a short label and a description; otherwise return an empty options array.
${QUESTION_TEXT_FORMAT}
${questionWritingRules()}`;

/** Rules for Claude Code's answer to a review. 'amendment' names what an accepted issue requires. */
function respondRules(root: RunRoot, amendment: string): string {
  return `${runDir(root)}/user-decisions.md contains input and decisions by the user, which must be followed.
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
Return exactly one disposition per issue id. Put in questions_for_user only the questions the rule on whether to ask, below, allows.
${QUESTION_OPTIONS_RULE}
Do not use the AskUserQuestion tool.`;
}

/**
 * Issue #112: why a disagreement between the agents about how a question to the user is worded is not put to the user,
 * and, since issue #156, why one Claude Code marks as about what the task requires is. The review and response prompts
 * of the question list and of the terms carry it, and their loop pauses on a disputed issue only where Claude Code's
 * latest answer carries the mark (disputesSettledBy "agents" in src/subjects.ts).
 */
export const WORDING_DISPUTES = `In this review a disagreement between Codex and Claude Code about how a question to the user is worded is not put to the user, for three reasons. He is the one person who cannot judge it: whether a word in a question needs explaining to him is a question about what he knows, and he cannot answer it about a question he has not read. Both positions argue from the same rules for every question put to the user, which reach the writer and the reviewers alike, so the disagreement is about applying them, which this review exists to settle. And a stop costs the user time in the part of the run that exists to save it. So for such a disagreement an issue raised again, a repetition under a new id, a reversal, a disputed self-correction or a second clarification request does not stop the review, even where the instructions above say the user will decide: Claude Code's disposition stands, its rationale goes back to Codex in the next round, and Codex accepts it or argues again.
A disagreement about what the task requires is not about wording: for example, whether a question must be asked or the task text already settles it, or what the program should do. Claude Code marks such a disagreement on its disposition (${TASK_DISPUTE_FIELD}). If Codex raises the issue again, by its id or as a repetition under a new id, or another of those stops arises on it, the user is asked, with Codex's reading and Claude Code's reading as his two options. Codex may instead accept Claude Code's reading in its next review, and then the user is not asked. What stays the user's is everything about the work (the plan, the requirements, the code, what the program should do) and a question whose options differ in what they claim.`;
/**
 * Issue #156: when Claude Code marks a disposition as a disagreement about what the task requires. Only the question
 * list's and the terms' response prompts carry it, since only their schemas have the field; validateRound reads it.
 */
export const TASK_DISPUTE_RULE = `Every disposition has ${TASK_DISPUTE_FIELD}. Set it to true on a disposition you do not accept in full ('rejected', 'partially_accepted', 'no_change_needed' or 'clarification_requested') when the disagreement is about what the task requires rather than how a question is worded; when you set it, state in the rationale your reading of the task and why the task text allows it, because the user is shown Codex's issue and your rationale as the two readings. Otherwise set it to false; on 'accepted' it is ignored. A marked disagreement is put to the user if Codex raises the issue again.`;
/**
 * Issue #112 (the developer's instruction of 7 Oct 2026): where the agents disagree on what a term means, the
 * disagreement need not be resolved; both definitions are shown, as a dictionary gives more than one sense of a word.
 */
export const TWO_SENSES = "Where Codex and Claude Code disagree on what a term means and both meanings bear on the question, do not dispute it: keep both definitions as senses of the term, in the order given, and the reader is shown both, numbered, as a dictionary gives more than one sense of a word.";
/** The heading of the line in conversation.md that records a disputed issue the user was not asked about (issue #112). */
export const WORDING_DISPUTE_HEADING = "Not put to the user:";
/**
 * A disputed issue of the question list or the terms, recorded instead of a pause (issue #112). It asserts nothing
 * about what the disagreement concerns, which nothing checked; only that Claude Code did not mark it (issue #156).
 */
export const unmarkedDisputeLine = (origin: PauseOrigin, heading: string): string =>
  `${heading}: ${pauseSubject(origin)}. Claude Code did not mark this disagreement as one about what the task requires, so Codex and Claude Code settle it between themselves; ${origin.pause === "reraised" ? "Claude Code answers it in this cycle's response" : "Claude Code's disposition stands, and Codex reads its rationale in the next cycle"}.`;

// ---- question list ------------------------------------------------------------------------------

/** The prefix of an agreed question's id (Q1, Q2, …) and of a follow-up's id (F1, F2, …), issue #35 (Q6). */
export const AGREED_QUESTION_PREFIX = "Q";
export const FOLLOW_UP_PREFIX = "F";
export function questionListPrompt(task: string): string {
  return `Do not write a plan yet. Read the task below and inspect the codebase without changing anything.
Return in 'questions' the questions whose answers you need from the user before you can write an implementation plan for the task.
Include a question only as the rule on whether to ask, below, allows.
Each entry has these fields. id: ${AGREED_QUESTION_PREFIX}1, ${AGREED_QUESTION_PREFIX}2, and so on. context: the context paragraph that precedes the question, as the rules below describe it, as blocks. history: what happened before that led to the question, apart from the context, as the rules below describe it, as blocks; an empty list when there is none. question: one decision per question, as pieces. reason: what in the plan depends on the answer, and the files you inspected that do not settle it, as blocks. proposed_answers: two to four answers that are feasible in this codebase, each with a label and a description, as pieces. default_answer: the words of the label of the proposed answer that you would assume if the user expressed no preference.
${SKIP_IF_FIELD}
How the text of an entry is written:
${formatClauses(["blocks", "pieces", "code", "inline"])}
- Every piece is plain here: ref "" everywhere. The explanations are written after the list is agreed, by dividing its text into pieces that refer to them, its wording unchanged.
${questionWritingRules()}
The rules apply to the question, its reason, its proposed answers and its default alike. Write the list so that it needs as few explanations as possible.
Return an empty list if no question is needed. Do not modify any file. Do not use the AskUserQuestion tool.
Task: ${task}`;
}

export function questionReviewPrompt(root: RunRoot, round: number, thread: ReviewThread): string {
  const log = pathOf({ kind: "log", subject: "questions" });
  return byThread(round, thread, log, root, () => `${laterRound(root, pathOf({ kind: "questions" }), log, "Q", round)}\n${WORDING_DISPUTES}`, () => `Review the question list in ${runDir(root)}/questions.json against the task text in the same file and against the codebase. Do not modify any file.
The planner will ask the user these questions in an interview and will then write an implementation plan from the answers.
Raise an issue when: a question whose answer the plan needs is missing; a question combines several decisions; a reason is wrong; a feasible answer is missing from the proposed answers, or a proposed answer is not feasible in this codebase; a default contradicts the task or the codebase.
${questionReviewCriteria()}
These criteria apply to the question, its context, its reason, its proposed answers and its default alike. Any question in the list may be put to decision support, which works out the arguments for and against each proposed answer, so hold every proposed answer to that standard.
Put the question id, or 'list' for an issue that concerns the list as a whole, in the location field.
${logRules(root, log, "Q", round)}
${WORDING_DISPUTES}`);
}

export function questionRespondPrompt(root: RunRoot, round: number): string {
  return `${runDir(root)}/question-review/review-${round}.json contains a review of the question list in ${runDir(root)}/questions.json.
${respondRules(root, "you amend the question list for it")}
${WORDING_DISPUTES}
${TASK_DISPUTE_RULE}
Return in 'questions' the complete question list after your amendments, including the entries that did not change. Do not modify any file.`;
}

// ---- the explanations of the terms (S17, issue #36) --------------------------------------------------------------------

/** The rule of the terms, as QUESTION_RULES states it: what the terms subject writes and reviews. */
const termsRule = (): string => QUESTION_RULES.find((r) => r.id === "terms")?.rule ?? "";
/**
 * The call that writes the explanations of the agreed questions' terms (S17, decision Q8): a fresh session, after the
 * question review has converged, against the final wording. The entry of each question lists its terms.
 */
export function termsPrompt(root: RunRoot, task: string): string {
  return `${agreedListSentence(root)} The questions will be put to the user, who may never have seen this codebase. Explain the terms of each question. ${READ_ONLY_TERMS}
${termsRule()}
Return in 'entries' one entry per question of the list: ${TERMS_ENTRY_FIELDS} A term may occur in any of these fields; each question carries all of its own explanations, since each question is read on its own. The explanations are shown on the words themselves.
${termsWritingRules()}
An entry whose question needs no explanation has an empty explanations list and its fields as they are.
Task: ${task}`;
}
const agreedListSentence = (root: RunRoot): string => `${runDir(root)}/questions.json contains the task and the question list that Claude Code and Codex have agreed.`;
const READ_ONLY_TERMS = "You may read the project to understand it; do not modify any file, and do not use the AskUserQuestion tool.";
const TERMS_ENTRY_FIELDS = "its id; its explanations; and its context, history, question, reason and proposed_answers as the list holds them, divided into pieces so that every piece whose words need an explanation refers to it.";
const termsWritingRules = (): string => `${KEEP_WORDING}
${QUESTION_TEXT_FORMAT}
${questionWritingRules()}`;
/**
 * Issue #142: the call that writes one agreed question's explanations on the user's request, while the question is on
 * the screen (the choice onRequest): a fresh session, no review. requestedTermsValidation checks its reply.
 */
export function termsOnRequestPrompt(root: RunRoot, task: string, id: string): string {
  return `${agreedListSentence(root)} The user is reading the question ${id} of that list now and has asked for the explanations of its terms; he may never have seen this codebase. Explain the terms of that question alone. ${READ_ONLY_TERMS}
${termsRule()}
Return in 'entries' exactly one entry, for the question ${id}: ${TERMS_ENTRY_FIELDS} A term may occur in any of these fields. The explanations are shown on the words themselves.
${termsWritingRules()}
If the question needs no explanation, its entry has an empty explanations list and its fields as they are.
Task: ${task}`;
}
/** Codex's review of the explanations (S17): the criteria of every question, as they apply to the terms. */
export function termsReviewPrompt(root: RunRoot, round: number, thread: ReviewThread): string {
  const log = pathOf({ kind: "log", subject: "terms" });
  return byThread(round, thread, log, root, () => `${laterRound(root, pathOf({ kind: "terms" }), log, "T", round)}\n${WORDING_DISPUTES}`, () => `Review the explanations of terms in ${runDir(root)}/terms.json against the agreed question list in ${runDir(root)}/questions.json and against the codebase. Do not modify any file. The list itself is agreed; review the explanations.
Each entry of terms.json names a question by its id and holds its explanations, each with its id, term and senses (one or more definitions, shown numbered where there are several), and the question's context, question, reason and proposed answers divided into pieces; a piece whose ref is an explanation's id is the words that explanation explains. The user reads each explanation on those words while he answers the question; he may never have seen this codebase. The wording of the question is agreed and cannot change; only its division into pieces and the explanations can.
${questionReviewCriteria()}
Raise an issue about the explanations only: a word or phrase the reader may not know that has no explanation in a question in which it occurs, or a piece that uses it and does not refer to it; a sense that is wrong, a cross-reference, uses another unexplained term, or does not make its term intelligible to a reader who has never seen this codebase.
${TWO_SENSES}
Put the question id, with the term, in the location field.
${logRules(root, log, "T", round)}
${WORDING_DISPUTES}`);
}
export function termsRespondPrompt(root: RunRoot, round: number): string {
  return `${recordPath(root, { kind: "review", subject: "terms", round })} contains a review of the explanations of terms in ${runDir(root)}/terms.json.
${respondRules(root, "you amend the explanations for it")}
${WORDING_DISPUTES}
${TASK_DISPUTE_RULE}
${TWO_SENSES}
Return in 'entries' the complete explanations after your amendments, including the entries that did not change, each question divided into pieces with its wording unchanged; the program writes them. Do not modify any file.
${KEEP_WORDING}`;
}
export const termsApplyDecisionsPrompt = (root: RunRoot): string => `${runDir(root)}/user-decisions.md has new entries. Read the file.
Return in 'entries' the complete explanations of ${runDir(root)}/terms.json, amended where a decision requires it, each question divided into pieces with its wording unchanged; the program writes them. Do not modify any file.
${KEEP_WORDING}`;

export const questionApplyDecisionsPrompt = (root: RunRoot): string => `${runDir(root)}/user-decisions.md has new entries. Read the file.
Return in 'questions' the complete question list of ${runDir(root)}/questions.json, amended where a decision requires it. Do not modify any file.`;

// ---- interview ----------------------------------------------------------------------------------

const interviewRules = (root: RunRoot): string => `Rules for the interview.
Each of your turns produces these output fields. message_to_user: what you say to the user in this turn, in plain text without Markdown tables: the record of his earlier answer, an answer to his question, a remark. The question you ask now is not repeated in it; the program shows that question below your message.
current_question: the question this message asks the user to answer now, or every field an empty string or an empty list when the message asks none. Its id is the agreed question's id, the id you assign to a follow-up question, or in a second interview the id of the accepted issue. For an agreed question of ${runDir(root)}/questions.json, give only its id and leave its other fields empty: the program shows the agreed question as it was reviewed, with its context, its terms and its proposed answers. For any other question, give its context, its history, its text, its explanations and its options: the context paragraph as blocks, the history as blocks (an empty list when there is none), the question alone as pieces (without the record of an earlier answer, without the options and without the default), the explanations its pieces refer to, and each option with a short label and a description as pieces, the default marked in its description; all of them under the rules below.
${QUESTION_TEXT_FORMAT}
asked_ids: the ids of every question you have asked so far: the agreed questions you have asked, and an id ${FOLLOW_UP_PREFIX}1, ${FOLLOW_UP_PREFIX}2, … that you assign to each follow-up question. answered_ids: the ids of the questions, agreed or follow-up, that the user has answered so far. complete: true only when every agreed question has been answered or the program has reported it skipped, and you need nothing further from the user. summary: an empty string while complete is false.
When complete is true, summary contains the complete requirements document in Markdown: the task; every decision with the id of its question; the further information and constraints that the user gave; and open points, each with the default that will be assumed.
Ask one question per message. The user may answer with the number of an option, its label, or free text.
${SKIPPED_RULE}
${questionWritingRules()}
You may ask any follow-up question that the conversation makes necessary. The user may raise any subject and may ask you questions; answer them, and inspect the codebase without changing it where that is needed.
Do not use the AskUserQuestion tool; the program relays the conversation. Do not modify any file. Do not write a plan.`;

export const interviewOpenPrompt = (root: RunRoot): string => `Conduct an interview with the user. ${runDir(root)}/questions.json contains the task and the agreed questions. Cover every agreed question except those the program reports skipped, in the order of the list unless the conversation makes another order more useful.
${interviewRules(root)}
Begin now with your first message to the user.`;

export function interviewGapsPrompt(root: RunRoot, reviewFile: string, ids: string[]): string {
  return `The reviewer has examined ${runDir(root)}/requirements.md, the confirmed result of the interview. ${reviewFile} contains the review. You accepted these issues: ${ids.join(", ")}.
Conduct a second interview with the user on those points only. Treat each accepted issue as an agreed question; use the issue ids in asked_ids and answered_ids. Do not raise again a question of the first interview whose premise the user denied: it is listed under 'Skipped questions' in ${runDir(root)}/requirements.md.
${interviewRules(root)}
When complete is true, summary contains the complete revised requirements document, not only the changes.
Begin now with your first message to the user.`;
}

export const interviewDonePrompt = `The user ends the interview now. Return complete = true. In the summary, list every agreed question that was not answered and that the program has not reported skipped under 'Open points', with the default that will be assumed, and every skipped question under 'Skipped questions'.`;

export function interviewUserMessage(text: string): string {
  return `User: ${text}`;
}

export function interviewNotConfirmed(text: string): string {
  return `The user does not confirm the summary and writes:\n${text}\nContinue the conversation. Return complete = true with the revised summary when the point is resolved.`;
}

/**
 * Issue #184: the rules of the first interview (the clarification), in which Interloq presents the agreed questions itself
 * and sends each answer to Claude Code as it is given; Claude Code's reply chooses no agreed question.
 */
const clarificationRules = (root: RunRoot): string => `Rules for the interview.
The program presents the agreed questions of ${runDir(root)}/questions.json to the user itself, in the order of the list, with their context, their terms and their proposed answers, and does not present a question whose skip condition the user's answer met. It sends you each answer as soon as the user gives it, several answers together when the user answered more than one while you were replying, each with the id of its question and, for an agreed question, the label of the option chosen. The program does not wait for your reply before it presents the next agreed question. Never ask an agreed question yourself.
Each of your replies produces these output fields.
message_to_user: what you say to the user, in plain text without Markdown tables: a short acknowledgment, a remark, or the answer to a question the user asked in a written answer. It may be an empty string; the program shows nothing for an empty message.
follow_ups: the follow-up questions the answers make necessary, or an empty list. The program asks each one after the question the user is answering when your reply arrives, or after the last agreed question if none remains. Give each an id ${FOLLOW_UP_PREFIX}1, ${FOLLOW_UP_PREFIX}2, … that no earlier question of this interview has had, its context, its history, its text, its explanations and its options: the context paragraph as blocks, the history as blocks (an empty list when there is none), the question alone as pieces (without the options and without the default), the explanations its pieces refer to, and each option with a short label and a description as pieces, the default marked in its description; all of them under the rules below.
${QUESTION_TEXT_FORMAT}
unnecessary: the questions already presented or answered that you judge, from the answers, were unnecessary, each with its id and the reason; an empty list otherwise. The program tells the user and changes nothing else.
complete: false until the program reports that every agreed question has been presented or that the user ended the interview, and false in a reply that asks a follow-up question. Then true, when you need nothing further from the user.
summary: an empty string while complete is false. When complete is true, the complete requirements document in Markdown: the task; every decision with the id of its question; the further information and constraints that the user gave; and open points, each with the default that will be assumed.
${SUMMARY_SKIPPED_RULE}
${questionWritingRules()}
You may ask any follow-up question that the answers make necessary. The user may raise any subject and may ask you questions; answer them, and inspect the codebase without changing it where that is needed.
Do not use the AskUserQuestion tool; the program relays the conversation. Do not modify any file. Do not write a plan.`;

/** Issue #184: the first request of the first interview, sent when it opens. */
export const clarificationOpenPrompt = (root: RunRoot): string => `Take part in an interview with the user. ${runDir(root)}/questions.json contains the task and the agreed questions.
${clarificationRules(root)}
The program is presenting the first agreed question now. Reply with an empty message unless you have something to tell the user before the answers arrive.`;

/** One item of a request of the first interview: an answer to an agreed question or a follow-up, or a reply to Claude Code's message. */
export type ClarificationEntry =
  | Readonly<{ kind: "agreed"; id: string; text: string; option: string | null }>
  | Readonly<{ kind: "followUp"; id: string; text: string }>
  | Readonly<{ kind: "message"; text: string }>;
/** What closes a request: the list is done, the developer ended the interview, or he did not confirm the summary. */
export type ClarificationTrailer = Readonly<{ kind: "listDone" }> | Readonly<{ kind: "done" }> | Readonly<{ kind: "notConfirmed"; text: string; ended: boolean }>;

/** Issue #184: the sentence every closing request of the first interview carries; the scripted planner recognizes it. */
export const LIST_DONE_SENTENCE = "The program has no further agreed question to present.";

const entryLine = (entry: ClarificationEntry): string => {
  switch (entry.kind) {
    case "agreed":
      return entry.option === null ? `The user answers agreed question ${entry.id} in writing:\n${entry.text}` : `The user answers agreed question ${entry.id} with the option ${JSON.stringify(entry.option)}.`;
    case "followUp":
      return `The user answers follow-up question ${entry.id}:\n${entry.text}`;
    case "message":
      return `The user replies to your message:\n${entry.text}`;
  }
};

const trailerText = (trailer: ClarificationTrailer): string => {
  switch (trailer.kind) {
    case "listDone":
      return `${LIST_DONE_SENTENCE} Every agreed question has been presented and answered or skipped, and every follow-up question has been answered. Ask any follow-up question you still need; otherwise return complete = true with the summary.`;
    case "done":
      return `${LIST_DONE_SENTENCE} ${interviewDonePrompt}`;
    case "notConfirmed":
      return `${LIST_DONE_SENTENCE} ${trailer.ended ? "The user ended the interview earlier. " : ""}The user does not confirm the summary and writes:\n${trailer.text}\nAsk any follow-up question the point needs; otherwise return complete = true with the revised summary.${trailer.ended ? " List every agreed question that was not answered under 'Open points', with the default that will be assumed." : ""}`;
  }
};

/**
 * Issue #184: a request of the first interview: every answer given since the previous request, in the order given, the
 * program's notes (the questions it skipped), and, in a closing request, what closes it.
 */
export const clarificationRequestPrompt = (entries: readonly ClarificationEntry[], notes: readonly string[], trailer: ClarificationTrailer | null): string =>
  [...entries.map(entryLine), ...notes, ...(trailer === null ? [] : [trailerText(trailer)])].join("\n\n");

/** Issue #184: Claude Code's judgment that a question was unnecessary, said to the user and written to conversation.md. */
export const unnecessaryLine = (id: string, reason: string): string => `Claude Code judges question ${id} unnecessary: ${reason}`;

// ---- requirements -------------------------------------------------------------------------------

export function requirementsReviewPrompt(root: RunRoot, round: number, thread: ReviewThread): string {
  const log = pathOf({ kind: "log", subject: "requirements" });
  return byThread(round, thread, log, root, () => laterRound(root, pathOf({ kind: "requirements" }), log, "G", round), () => `Review ${runDir(root)}/requirements.md. It is the result of an interview between the planner and the user, confirmed by the user. ${runDir(root)}/questions.json contains the task and the questions that were agreed before the interview. Do not modify any file.
The planner will write an implementation plan from the task and this file.
Raise an issue when: an agreed question has no clear answer in the file; two statements in the file contradict each other; a statement cannot be followed in this codebase (name the file); a decision that the plan needs is still absent. An agreed question listed under 'Skipped questions' was not put to the user because his answer to another question denied its premise; it is not an issue unless you name what in the task, the codebase or the file establishes that premise.
Put the question id or the heading in the location field.
${logRules(root, log, "G", round)}`);
}

export function requirementsRespondPrompt(root: RunRoot, round: number): string {
  return `${runDir(root)}/requirements-review/review-${round}.json contains a review of ${runDir(root)}/requirements.md.
${respondRules(root, "the point must be put to the user; the program will conduct a second interview on the accepted issues, so do not amend the file yourself")}
Do not modify any file.`;
}

export const requirementsApplyDecisionsPrompt = (root: RunRoot): string => `${runDir(root)}/user-decisions.md has new entries. Read the file and amend ${runDir(root)}/requirements.md where a decision requires it. Do not modify any other file.
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
/**
 * Issue #162 (requirements Q2): the limit on all of one step's check commands together, two minutes. Fixed in the code,
 * not a setting. A step's check runs only the tests its change touches, and the part of them that fits in this time.
 */
export const STEP_CHECK_LIMIT_MS = 120_000;

/**
 * Issue #117: each execution phase runs in a Claude Code session of its own, which has not seen the planning; the plan's
 * step texts carry what its implementer cannot recover from the files the execution prompt names and the codebase.
 */
export const planStepSelfContainedRule = (root: RunRoot): string => `Each execution phase begins a new Claude Code session, which carries out the phase's remaining steps having read only the task, ${runDir(root)}/requirements.md, ${runDir(root)}/user-decisions.md and ${runDir(root)}/plan.json, and not this planning. So write each step's text to state the facts and the reasons its choices depend on (the files, the decided behavior, why an approach was chosen over another) wherever the implementer could not recover them from those files and the codebase.`;
/** The limit of one step's checks in minutes, as the prompts state it. */
const stepCheckMinutes = STEP_CHECK_LIMIT_MS / 60_000;
/** Issue #162 (requirements Q4): each step's text names the commands that check its change, which the plan review holds it to. */
export const STEP_CHECK_NAMED = "Each step's text names the command or commands that check its change.";
/** Issue #162 (requirements Q2): a step's check runs only the tests its change touches, within the limit of all its checks together. */
export const STEP_CHECK_TOUCHED_ONLY = `A step's check runs only the tests its change touches, and all of its check commands together finish within ${stepCheckMinutes} minutes; where the touched tests would take longer, the step runs the part that fits and leaves the rest unrun.`;
/** Issue #162 (requirements Q3, G-R1-1, F1): no step runs the whole suite. */
export const STEP_CHECK_NO_SUITE = "No step runs the whole test suite.";
/** What Interloq does with the configured suite command (requirements G-R1-1, F1), or nothing where none is configured. */
const suiteSentence = (suite: CommandLine | null): string =>
  suite === null ? "" : ` Interloq runs the whole suite, ${codeSpan(suite)}, itself after the review of the work finds nothing left to correct.`;
/** The project's own commands, one line per entry (requirements Q1), or nothing where the project lists none. */
const projectCommandLines = (checks: StepChecks): string =>
  checks.commands.length === 0 ? "" : `\nThe project's commands that check each kind of change:${checks.commands.map((entry) => `\n- ${entry.change}: ${codeSpan(entry.command)}`).join("")}`;
/**
 * The rule of every prompt that asks for the whole plan, and of the execution prompt (issue #78, rewritten by issue
 * #162): no command outlasts one shell command, each step names its check, the check runs only the touched tests within
 * STEP_CHECK_LIMIT_MS, no step runs the whole suite, and the project's own commands where it lists them.
 */
/**
 * Issue #162 (requirements Q4): the plan review's criterion, the counterpart of planStepCheckRule, which the plan review
 * quotes beside it so that Codex holds each remaining step to the rule the writer was given.
 */
export const STEP_CHECK_REVIEW_CRITERION = `Raise an issue for a remaining step whose text names no check command, whose named checks run tests the step's change does not touch or are expected to take more than ${stepCheckMinutes} minutes together, or that runs the whole test suite.`;
/**
 * Issue #176 (requirements Q2): the plan's last step commits the run's changes, as the project's own instructions direct.
 * It states no commit policy; it names what Interloq's commit check counts (`uncommittedSinceStart` of the Store), so the
 * writer and the check agree on which files the run must leave committed.
 */
export const PLAN_COMMIT_STEP_RULE =
  "The plan's last step commits the run's changes as the project's own instructions direct. Interloq does not count the run finished while a file the run changed is uncommitted, except files git ignores and does not track and the paths Interloq is configured to ignore; files that were already uncommitted when the run began are not counted.";
/** Issue #176: the plan review's criterion, the counterpart of PLAN_COMMIT_STEP_RULE. */
export const COMMIT_STEP_REVIEW_CRITERION = "Raise an issue for a plan whose remaining steps do not end with a step that commits the run's changes as the project's own instructions direct.";
/**
 * Issue #181 (requirements Q5): in an implementation run the plan writer settles every question about how to build the
 * work and states its assumption in the plan, where Codex reviews it; only what the work should achieve, where the task,
 * the requirements and the user's decisions leave it open, goes to the user. Claude Code's judgment decides which kind
 * a question is.
 */
export const PLAN_QUESTIONS_RULE =
  "Settle yourself every question about how to build the work (a design, a module, a data type, a test, the order of the steps) and state the assumption you settled in the text of the step it concerns, where the plan review checks it. Put in questions_for_user only a question about what the work should achieve, where the task, the requirements and the user's decisions leave it open, and only as the rule on whether to ask allows.";
/** Issue #181: the plan review's criterion, the counterpart of PLAN_QUESTIONS_RULE. */
export const PLAN_QUESTIONS_REVIEW_CRITERION =
  "Raise an issue for a remaining step whose text rests on a choice of how to build the work that it does not state, and for a question the plan writer put to the user about how to build the work rather than what it should achieve.";
/** Issue #176: the execution prompt's sentence on committing, which states no commit policy either. */
export const EXECUTION_COMMIT_SENTENCE =
  "The work is not finished while the run's changes are uncommitted: commit them as the project's own instructions direct before you return status 'finished'. Files that were already uncommitted when the run began are not counted.";
export const planStepCheckRule = (checks: StepChecks): string =>
  `A single shell command may run for at most ${COMMAND_CEILING_MS / 60_000} minutes. ${STEP_CHECK_NAMED} ${STEP_CHECK_TOUCHED_ONLY} ${STEP_CHECK_NO_SUITE}${suiteSentence(checks.suite)}${projectCommandLines(checks)}`;
/** Claude Code's Monitor tool, with which it starts a watch it may wait for like a background command (issue #161). */
export const MONITOR_TOOL_NAME = "Monitor";
/** What Interloq does while a background command or a Monitor watch runs (issues #154, #161): the adapter's Stop hook holds the session. */
export const KEEPS_SESSION_OPEN = "Interloq keeps the session open until it ends";
/** What Claude Code may do while a command it started runs: the suites read the working tree. */
export const READ_AND_SEARCH_ONLY = "read and search, but do not edit any file";
/** What the adapter's hook on the structured output refuses (issue #154). */
export const NO_REPORT_WHILE_RUNNING = `do not return the status report while a command you started in the background or a ${MONITOR_TOOL_NAME} watch is still running`;
/**
 * The instruction about long commands (issue #78, rewritten by issue #154): a turn ended to wait for a background
 * command no longer ends the session, because the adapter's hooks wait for the command and continue the session.
 */
export const BACKGROUND_SUITE_SENTENCE = `A shell command may run in the foreground for up to ${COMMAND_CEILING_MS / 60_000} minutes, with the Bash tool's timeout set to ${COMMAND_CEILING_MS}. A command that may run longer than that may be started in the background with the Bash tool. To wait for something, such as a line in a background command's output file, you may also start a watch with the ${MONITOR_TOOL_NAME} tool. While a background command or a watch runs, ${READ_AND_SEARCH_ONLY}: the tests read the working tree, and a result must belong to the files as they were when it started. When nothing is left to do but wait for a background command or a watch, end your turn: ${KEEPS_SESSION_OPEN} and then gives you its end and its output file; ${NO_REPORT_WHILE_RUNNING}, and never return 'continuing' or 'blocked' for it.`;

export const planFormat = (root: RunRoot): string => `Return the complete plan in the field 'plan': its stages in order, each with its number and a title, and in each stage its steps in order, each with an id, its number within the stage, a short label of one line, and its full text in Markdown. Return the whole plan every time, including the parts that did not change. The program writes ${runDir(root)}/plan.json and ${runDir(root)}/plan.md from it; do not write either file.`;
/** The rule of step identity (G-R1-1), which validatePlan in src/plan.ts enforces and the repair turn repeats. */
export const planIdRule = (root: RunRoot): string => `Every step has an id (S1, S2, …) that is unique across the plan. A step that stays in the plan keeps its id in every revision, and a new step gets an id not used before in this plan. A step whose status in ${runDir(root)}/plan.json is 'done' stays in the plan, with its id, label and text unchanged; it may move to another stage. Stage and step numbers are for display only.`;
/** The statuses of plan.json as the agents read them. */
const planStatuses = (root: RunRoot): string => `Each step of ${runDir(root)}/plan.json has a status that the program records: a step with status 'done' is implemented, a step with status 'unfinished' was begun and not completed, and a step with status 'pending' is not yet begun.`;

/** The requirements as the prompts name them, where the question phase ran. */
export const requirementsSentence = (root: RunRoot): string => `${runDir(root)}/requirements.md contains the user's confirmed answers and decisions from the interview. The plan must follow it.`;
/** The user's decisions as an execution call is told of them; the file exists from the start of a run. */
export const userDecisionsSentence = (root: RunRoot): string => `${runDir(root)}/user-decisions.md contains input and decisions by the user, which must be followed.`;

export function initialPlanPrompt(root: RunRoot, task: string, withRequirements: boolean, checks: StepChecks): string {
  const requirements = withRequirements ? `${requirementsSentence(root)}\n` : "";
  return `Produce an implementation plan for the task below. Investigate the codebase as needed.
${requirements}${userDecisionsSentence(root)}
${planFormat(root)}
${planStepCheckRule(checks)}
${planStepSelfContainedRule(root)}
${PLAN_COMMIT_STEP_RULE}
${planIdRule(root)}
Do not modify any file. Do not implement anything.
${PLAN_QUESTIONS_RULE}
Put in questions_for_user only the questions the rule on whether to ask, below, allows; otherwise return an empty array.
${QUESTION_OPTIONS_RULE}
Task: ${task}`;
}

export const planApplyDecisionsPrompt = (root: RunRoot, checks: StepChecks): string => `${runDir(root)}/user-decisions.md has new entries. Read the file and amend the plan in ${runDir(root)}/plan.json where a decision requires it.
${planFormat(root)}
${planStepCheckRule(checks)}
${planStepSelfContainedRule(root)}
${PLAN_COMMIT_STEP_RULE}
${planIdRule(root)}
Do not modify any file.
Return an empty questions_for_user array.`;

export function planReviewPrompt(root: RunRoot, phase: number, round: number, withRequirements: boolean, checks: StepChecks, thread: ReviewThread): string {
  const prefix = `P${phase}`;
  const log = pathOf({ kind: "log", subject: { plan: phase } });
  return byThread(round, thread, log, root, () => laterRound(root, pathOf({ kind: "planFile" }), log, prefix, round), () => planReviewFirst(root, log, prefix, round, withRequirements, checks));
}
function planReviewFirst(root: RunRoot, log: string, prefix: string, round: number, withRequirements: boolean, checks: StepChecks): string {
  const requirements = withRequirements
    ? `${runDir(root)}/requirements.md contains the user's confirmed answers and decisions. It must be followed; raise an issue when a plan step contradicts it or omits something it requires.\n`
    : "";
  return `Review the implementation plan in ${runDir(root)}/plan.json against the codebase. Do not modify any file.
${requirements}${planStatuses(root)} Steps with status 'done' are already implemented in the codebase; review the remaining steps, and review whether the remaining steps are consistent with the implemented state.
The plan writer was given this rule on how a step checks its change:
${planStepCheckRule(checks)}
${STEP_CHECK_REVIEW_CRITERION}
The plan writer was given this rule on committing the run's changes:
${PLAN_COMMIT_STEP_RULE}
${COMMIT_STEP_REVIEW_CRITERION}
The plan writer was given this rule on its questions to the user:
${PLAN_QUESTIONS_RULE}
${PLAN_QUESTIONS_REVIEW_CRITERION}
Put the step's id in the location field.
${logRules(root, log, prefix, round)}`;
}

export function planRespondPrompt(root: RunRoot, phase: number, round: number, checks: StepChecks): string {
  return `${runDir(root)}/planning-${phase}/review-${round}.json contains a review of the plan in ${runDir(root)}/plan.json.
${respondRules(root, "you amend the plan for it")}
${PLAN_QUESTIONS_RULE}
${planFormat(root)}
${planStepCheckRule(checks)}
${planStepSelfContainedRule(root)}
${PLAN_COMMIT_STEP_RULE}
${planIdRule(root)}
Do not modify any file.`;
}

/** The in-process tool of an execution call (issue #6, Q2): its server, its name, its statuses and its description. */
export const REPORT_STEP_SERVER = "interloq";
export const REPORT_STEP_TOOL = "report_step";
/** The name under which Claude Code calls the tool, and under which hooks and permissions see it. */
export const REPORT_STEP_TOOL_NAME = `mcp__${REPORT_STEP_SERVER}__${REPORT_STEP_TOOL}`;
export const REPORT_STEP_STATUSES = ["started", "done"] as const;
export const REPORT_STEP_DESCRIPTION = `Report the progress of a step of the plan you are carrying out, which the program records in plan.json in the run's records directory: call it with the step's id and ${REPORT_STEP_STATUSES.map((s) => `'${s}'`).join(" when you begin the step, and ")} when the step is complete and verified.`;
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
export const planFilesDenied = (root: RunRoot): string => `${runDir(root)}/plan.json and ${runDir(root)}/plan.md are written by the program from the plan you return; do not edit them.`;
/** The denial of an edit outside the run's records directory during a planning call (behavior 3; issue #120: the run's own). */
export const planningEditDenied = (root: RunRoot): string => `During a planning phase, only files under ${runDir(root)}/ may be written.`;
/** The denial of any other tool during a planning call. */
export const planningToolDenied = (root: RunRoot): string => `During a planning phase, only reading and writing under ${runDir(root)}/ are permitted.`;
/** What Claude Code is told at a stop of an execution call (behavior 4), the answer recorded in the run's user-decisions.md. */
export const stopRecordedText = (root: RunRoot): string =>
  `The user's answer is recorded in ${recordPath(root, { kind: "decisions" })}. Do not continue the implementation. Make no tool call other than the final structured output, and end your turn with status 'needs_input', a summary, and the remaining work. The plan will be revised and reviewed before work continues.`;
/** The validation repair turn of a plan (issue #6, G-R1-1): what was wrong, and the rule. */
export function planRepairPrompt(root: RunRoot, problems: PlanProblems): string {
  return `Your structured output matched the schema, but the program cannot accept the plan:
${planProblemLines(problems).join("\n")}
${planIdRule(root)}
Return the complete output again, corrected. Do not modify any file.`;
}

/**
 * What Claude Code is told about a step it resumes (issue #53, G-R1-1): the page marks a step current only on a report,
 * so a step resumed after another was started is reported started again.
 */
export const resumeStepSentence = `When you resume a step after you have started another, report it with the status '${REPORT_STEP_STATUSES[0]}' again.`;
/**
 * A relayed question's text as its shape composes it (S8 of the task of issue #36; behavior 4): the question as a JSON
 * object with its context, its history, its question, its explanations and its options, as pieces.
 */
export type RelayedParts = Readonly<{ context: readonly Block[]; history: readonly Block[]; question: readonly Piece[]; explanations: readonly Explanation[]; options: readonly PieceOption[] }>;
export function relayedQuestionText(parts: RelayedParts): string {
  return JSON.stringify({ context: parts.context, history: parts.history, question: parts.question, explanations: parts.explanations, options: parts.options });
}
/** The example of RELAYED_SHAPE: a question with one explanation and two options, in the shape it states. */
export const RELAYED_EXAMPLE: RelayedParts = {
  context: [{ kind: "paragraph", pieces: [{ text: "<the context paragraph>", ref: "", code: false }] }],
  history: [{ kind: "paragraph", pieces: [{ text: "<what led to the question, or an empty list>", ref: "", code: false }] }],
  question: [
    { text: "<the question, where a word such as ", ref: "", code: false },
    { text: "<a term>", ref: "t1", code: false },
    { text: " needs its explanation>?", ref: "", code: false },
  ],
  explanations: [{ id: "t1", term: "<a term>", senses: ["<its explanation>"] }],
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
export const RELAYED_SHAPE = `Write the text of each question you ask with the AskUserQuestion tool as one JSON object, and nothing else, with the fields context, history, question, explanations and options:
${QUESTION_TEXT_FORMAT}
- options: the same options as the tool's options, in the same order, each with its label and description as pieces whose words, joined, are exactly the tool option's label and description.
For example:
${relayedQuestionText(RELAYED_EXAMPLE)}`;
/**
 * The status of an execution report for work left with nothing for the user to decide (issue #154, decision Q2): the
 * run continues the phase's session with executionContinuingPrompt and asks the user nothing.
 */
export const CONTINUING_STATUS_SENTENCE = "If steps remain and there is no question for the user and no failure you cannot correct, for example when you end your turn before the work is done, return status 'continuing' with the remaining work in remaining_work: Interloq then tells you to go on with the remaining work in this session, without asking the user.";
/** The status of an execution report for a failure that needs the user (issue #154: no longer for work merely left). */
export const BLOCKED_STATUS_SENTENCE = "Return status 'blocked' only for a failure you cannot correct and that needs the user, for example a command that fails and that you cannot correct or a denied permission, with the description in the question field.";
/**
 * Issue #162 (requirements Q4): the report lists each check command the call ran, by the fields of S.StepCheckRun;
 * Interloq does not measure the duration, Claude Code reports it.
 */
export const REPORT_CHECKS_SENTENCE = "In the report's 'checks', list each check command you ran in this call, in the order you ran them: the step's id in 'step', the command exactly as you ran it in 'command', and how long it took in seconds in 'seconds'. List none if you ran none.";
/**
 * The prompt of an execution call. Each execution phase runs in a Claude Code session of its own (issue #117), which has
 * not seen the planning, so the prompt names the task and the records it must follow.
 */
export function executePrompt(root: RunRoot, task: string, withRequirements: boolean, checks: StepChecks): string {
  const requirements = withRequirements ? `${requirementsSentence(root)}\n` : "";
  return `${requirements}${userDecisionsSentence(root)}\nThe plan in ${runDir(root)}/plan.json has been reviewed. Implement its remaining steps: the steps whose status is 'pending' or 'unfinished'. You may work them in any order, with one step open at a time: report a step done before you start another. Steps with status 'done' are implemented; a step with status 'unfinished' was begun and not completed.
Report your progress with the tool ${REPORT_STEP_TOOL}: when you begin a step, call it with the step's id and the status '${REPORT_STEP_STATUSES[0]}'; when the step is complete and verified, call it with the step's id and the status '${REPORT_STEP_STATUSES[1]}'. ${resumeStepSentence} The program records the status in ${runDir(root)}/plan.json; do not edit ${runDir(root)}/plan.json or ${runDir(root)}/plan.md, and do not change the plan.
If you need information or a decision from the user, or if a remaining step proves to be wrong, do not continue on an assumption: ask with the AskUserQuestion tool. After you have asked, make no tool call other than the final structured output; end your turn with status 'needs_input'.
${RELAYED_SHAPE}
${questionWritingRules()}
${planStepCheckRule(checks)}
${REPORT_CHECKS_SENTENCE}
${EXECUTION_COMMIT_SENTENCE}
${BACKGROUND_SUITE_SENTENCE}
${CONTINUING_STATUS_SENTENCE}
${BLOCKED_STATUS_SENTENCE}
When every step is completed and verified, return status 'finished'.
In every case put a summary of the work done in summary and a description of the steps not yet completed in remaining_work.
Task: ${task}`;
}

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
export function correctivePrompt(root: RunRoot, fileLabel: string, round: number, acceptedIds: readonly string[]): string {
  return `${runDir(root)}/${fileLabel} did not change during your response to the review of cycle ${round}, although you accepted ${correctableIds(acceptedIds)} in full or in part.
Either apply the amendments you described, or change the action of those dispositions and give the reason in the rationale; where your response carries ${TASK_DISPUTE_FIELD} and the disagreement is about what the task requires, set it on them.
Return the complete response again in the same form as before; where your response carries the plan, the question list or the analysis, return it whole, with the amendments applied.
Only the action, the rationale and, where your response carries it, ${TASK_DISPUTE_FIELD} of ${correctableIds(acceptedIds)} may differ from your previous response. Return every other disposition, every duplicate_of and reverses, the self_corrections, the reviewer_feedback and the questions_for_user exactly as before.
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
Only the action, the rationale and, where your response carries it, ${TASK_DISPUTE_FIELD} of ${correctableIds(acceptedIds)} may differ from your previous response; everything else must be returned exactly as before.
Return the complete output again, corrected. Do not modify any file.`;
}

/** The fields of RoundInvalid (src/errors.ts), which imports this module for its texts. */
export type RoundProblems = Readonly<{ duplicateIssues: readonly string[]; missing: readonly string[]; duplicateDispositions: readonly string[]; unknownDispositions: readonly string[]; emptyIds: readonly string[]; collidingIds: readonly string[] }>;

/** What a repair prompt asks for instead, one instruction per failure of RoundInvalid (issue #151), in the words of the review and response rules. */
export const ROUND_REPAIR = {
  duplicateIssues: (ids: readonly string[]): string =>
    `Give each issue an id of its own: more than one issue has the id ${ids.join(", ")}. Keep that id on one of them and give each of the others a new id of the form the review prompt states.`,
  emptyIssueId: "Give every issue a non-empty id, of the form the review prompt states.",
  missing: (ids: readonly string[]): string => `Return exactly one disposition for each issue of the review, including ${ids.join(", ")}, with its action and rationale as the rules state.`,
  duplicateDispositions: (ids: readonly string[]): string => `Return one disposition per issue id: merge the dispositions given for ${ids.join(", ")} into one each, with one action and one rationale.`,
  unknownDispositions: (ids: readonly string[], reviewIds: readonly string[]): string =>
    `Remove the dispositions for ${ids.join(", ")}: a disposition answers an issue of this review, whose ids are ${reviewIds.join(", ")}. Report a correction of an earlier issue in self_corrections instead.`,
  emptyDispositionId: "Give every disposition the id of the issue of this review that it answers; no disposition id may be empty.",
  /** A generated id cannot be changed by Claude Code, so the repair asks for an explicit id of the generated form, which validateRound keeps as given (S8). */
  collidingIds: (ids: readonly string[]): string => {
    const forms = [...new Set(ids.map((id) => `${id.replace(/\d+$/, "")}<k>`))];
    return `The program generated ${ids.join(", ")} for self-corrections with an empty id, and an entry of the issue log already has that id. Give each of those self-corrections an id of your own of the form ${forms.join(" or ")}, with a k that appears neither in the issue log nor elsewhere in your reply, and keep its new_action and explanation unchanged; it still concerns no issue.`;
  },
} as const;

/** What a review or a response did wrong (RoundInvalid), one sentence per field: the halt's text and the repair prompts state it from here. */
export const roundInvalidParts = (error: RoundProblems): readonly string[] => [
  ...(error.duplicateIssues.length > 0 ? [`Codex returned more than one issue with the id: ${error.duplicateIssues.join(", ")}`] : []),
  ...(error.missing.length > 0 ? [`Claude Code returned no disposition for: ${error.missing.join(", ")}`] : []),
  ...(error.duplicateDispositions.length > 0 ? [`Claude Code returned more than one disposition for: ${error.duplicateDispositions.join(", ")}`] : []),
  ...(error.unknownDispositions.length > 0 ? [`Claude Code returned a disposition for an id that is not in the review: ${error.unknownDispositions.join(", ")}`] : []),
  ...(error.emptyIds.length > 0 ? [`an empty id in ${error.emptyIds.join(" and ")}`] : []),
  ...(error.collidingIds.length > 0 ? [`a generated self-correction id already exists in the log: ${error.collidingIds.join(", ")}`] : []),
];

/** A validation repair turn: what the program refused, one line each, then what to return instead. */
function validationRepairPrompt(problems: readonly string[], instructions: readonly string[]): string {
  return `Your structured output matched the schema, but the program cannot accept it:
${problems.map((p) => `- ${p}.`).join("\n")}
${instructions.join("\n")}
Return the complete output again, corrected. Do not modify any file.`;
}

/** The validation repair turn of a review whose issue ids are duplicated or empty (Codex). */
export const reviewRepairPrompt = (error: RoundProblems): string =>
  validationRepairPrompt(roundInvalidParts(error), [
    ...(error.duplicateIssues.length > 0 ? [ROUND_REPAIR.duplicateIssues(error.duplicateIssues)] : []),
    ...(error.emptyIds.length > 0 ? [ROUND_REPAIR.emptyIssueId] : []),
  ]);

/** The validation repair turn of a response whose dispositions or generated self-correction ids are invalid (Claude Code); `reviewIds` are the review's issue ids. */
export const roundRepairPrompt = (error: RoundProblems, reviewIds: readonly string[]): string =>
  validationRepairPrompt(roundInvalidParts(error), [
    ...(error.missing.length > 0 ? [ROUND_REPAIR.missing(error.missing)] : []),
    ...(error.duplicateDispositions.length > 0 ? [ROUND_REPAIR.duplicateDispositions(error.duplicateDispositions)] : []),
    ...(error.unknownDispositions.length > 0 ? [ROUND_REPAIR.unknownDispositions(error.unknownDispositions, reviewIds)] : []),
    ...(error.emptyIds.length > 0 ? [ROUND_REPAIR.emptyDispositionId] : []),
    ...(error.collidingIds.length > 0 ? [ROUND_REPAIR.collidingIds(error.collidingIds)] : []),
  ]);

// ---- prompts to the user ------------------------------------------------------------------------
// The texts the program shows when it waits for the user. src/userPrompts.ts maps each to its widget.

/**
 * The input hints (S8): the text of a prompt that says how to answer it, one fixed text per kind
 * of prompt, without parameters, so that src/userPrompts.ts recognizes the kind by it. The question itself, its context
 * and its options are presented before it; the page shows its own controls and words instead (`pagePromptText`).
 */
/** A decision at a pause (behaviour 7) or on a question from Claude Code. */
export const decisionPrompt = "Answer with the number or label of an option, or in your own words; Enter = continue without deciding; q = end the run > ";
/** The round limit, with the choice to proceed without convergence. The user reads "cycles" (issue #14). */
export const limitPrompt = "p = proceed without convergence; a number = that many more cycles; 0 = stop the run; q = end the run > ";
/** The round limit of a subject without a proceed choice (the work review, Q13). */
export const limitNoProceedPrompt = "A number = that many more cycles; 0 = stop the run; q = end the run > ";
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
/**
 * The end of a run names its Claude Code sessions (issue #117, issue #122). A refinement run keeps one session for its
 * question phase, which the line names; an implementation run gives every phase a session of its own and calls the
 * run's own session never, so its line names none. The usage line after it counts them all.
 */
export function sessionsLine(root: RunRoot, mode: RunMode, mainId: string | null): string {
  switch (mode) {
    case "refinement":
      return `Claude Code main session id: ${mainId ?? "none"} (the question phase; the terms, each question's context and each decision ran in a session of its own, counted below and listed in ${runDir(root)}/usage.jsonl)`;
    case "implementation":
      return `Claude Code sessions: each planning phase, implementation phase, work review and decision ran in a session of its own, counted below and listed with their costs in ${runDir(root)}/usage.jsonl`;
  }
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
/** The start of the terms' writing (S17), as the run says it. */
export const termsLine = "\nGather Requirements: Claude Code explains the terms of the agreed questions ...";
/** Issue #142: the run's choice of how the agreed questions' terms are explained, recorded and said as the question phase begins. */
export const termsChoiceLine = (terms: TermsMode): string => {
  switch (terms) {
    case "checked":
      return "Explanations of terms: written by Claude Code and checked by Codex before the first question.";
    case "unchecked":
      return "Explanations of terms: written by Claude Code before the first question, not checked by Codex.";
    case "onRequest":
      return "Explanations of terms: not written before the first question; you can ask for a question's explanations while it is on the screen.";
  }
};
/** Issue #142: the start of a question's explanations written on the user's request, as the run says it. */
export const termsRequestedLine = (question: number): string => `Claude Code explains the terms of Question ${question} ...`;
/** Issue #142: the heading in conversation.md of a question's explanations written on the user's request. */
export const termsRequestedHeading = (question: number): string => `Explanations of terms requested for Question ${question}`;
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
// ---- the tracker (issue #120) -----------------------------------------------------------------------------------------

/** What a run says when it has read its item: the item and the mode, before any agent call. */
export function itemStartedLine(mode: "refinement" | "implementation", id: string, title: string): string {
  return `${mode === "refinement" ? "Refinement" : "Implementation"} of item ${id}: ${title}`;
}
/** Why an item gives no task: its title and body are blank. */
export function blankItemText(id: string): string {
  return `item ${id} has neither a title nor a text, so the run has no task`;
}
/** Why an item gives no task: its section Refined using Interloq cannot be read. */
export function sectionMalformedText(id: string, reason: string): string {
  return `the text of item ${id} cannot be read: ${reason}`;
}
/**
 * What a refinement run records and says when the agreed question list was empty (issue #83): no failure. The agents
 * agreed that no question needed the user's answer, so the refinement found nothing to settle (issue #120).
 */
export const NOTHING_TO_SETTLE =
  "This refinement found nothing to settle: Claude Code and Codex agreed that no question needed your answer. That is not a failure.";
/** What a refinement run says when it has written its requirements back to the item. */
export function refinementWrittenLine(item: string, requirements: string): string {
  return `The requirements (${requirements}) were written to item ${item} as its section "Refined using Interloq", and the item was set to refined.`;
}
/** Why requirements.md cannot be written back: it is blank, or holds a line of the section's own. */
export function refinementInvalidText(reason: "blank" | "markerLine" | "trailingCarriageReturn", requirements: string): string {
  const why = { blank: "it is empty", markerLine: "it holds a line that marks the beginning or the end of the section", trailingCarriageReturn: "it ends with a carriage return" }[reason];
  return `${requirements} cannot be written to the item, because ${why}`;
}
/** Where the requirements are, for a halt after they were written to the item. */
export function requirementsKeptText(requirements: string): string {
  return `The requirements are in ${requirements}.`;
}
// ---- the two tabs of the page (issue #120) -------------------------------------------------------------------------------

/** Each mode's tab: its name, the action of an item's button, what its list is of and what it says when empty. */
export const TAB_TEXTS = {
  refinement: { tab: "Refinement", action: "Refine", list: "Unrefined issues", empty: "No unrefined issues" },
  implementation: { tab: "Implementation", action: "Implement", list: "Refined issues", empty: "No refined issues" },
} as const;
/** The tabs' accessible name. */
export const TABS_LABEL = "Modes";
/** A tab whose run waits for the user's answer: its name with the title's waiting mark in front (issue #16's mark). */
export const waitingTabName = (name: string): string => `${TITLE_WAITING_MARK} ${name}`;
export const ITEMS_REFRESH = "Refresh";
/** Issue #142: the name of the Refinement tab's control of the choice of terms, and the words of its three values. */
export const TERMS_CHOICE_LABEL = "Explanations of terms";
export const TERMS_CHOICE_TEXTS: Readonly<Record<TermsMode, string>> = { checked: "Written and checked", unchecked: "Written, not checked", onRequest: "On request" };
export const ITEMS_RETRY = "Try again";
export const ITEMS_LOADING = "Asking the issue tracker for the items …";
/** The way back from a tab's ended run to its list. */
export const BACK_TO_LIST = "Back to the list";
/** An item's headline in a tab: its id and its title. */
export const itemHeadline = (id: string, title: string): string => `#${id} ${title}`;

/** Why the run manager refuses to start a run (issue #120): no item id, a run of the mode in progress, an item that moved on. */
export const ITEM_ID_EMPTY = "no item was chosen";
const RUN_OF_MODE: Readonly<Record<"refinement" | "implementation", string>> = {
  refinement: "a refinement run",
  implementation: "an implementation run",
};
export function runInProgressText(mode: "refinement" | "implementation"): string {
  return `${RUN_OF_MODE[mode]} is in progress; stop it or wait for its end`;
}
export function itemMovedText(id: string, expected: string, state: string): string {
  return `item ${id} is no longer ${expected}: it is ${state}; refresh the list`;
}
/** The tracker's failures as the program says them; a variable's name, never a credential. */
export const TRACKER_FAILURE_TEXTS = {
  noTracker: "no issue tracker is configured: set the key tracker in the shared config.json of Interloq or in plan-review/config.json of the project",
  credentialMissing: (variable: string) => `the issue tracker's credential is missing: the environment variable ${variable} is not set`,
  unreachable: (tracker: string, message: string) => `the ${tracker} issue tracker could not be reached: ${message}`,
  requestRefused: (tracker: string, message: string) => `the ${tracker} issue tracker refused the request: ${message}`,
  authRefused: (tracker: string, status: number) => `the ${tracker} issue tracker refused the credential (HTTP status ${status})`,
  notFound: (id: string) => `the issue tracker has no item ${id}`,
  bodyInvalid: (id: string, message: string) => `item ${id} of the issue tracker could not be read: ${message}`,
  ambiguous: (id: string, labels: readonly string[]) => `item ${id} of the issue tracker carries more than one stage label: ${labels.join(", ")}`,
} as const;
/** The tracker steps at the end or the start of a run (TrackerStepFailed), as a halt names them. */
export const TRACKER_STEPS = ["setImplementing", "writeRefinement", "setRefined", "setImplemented"] as const;
export type TrackerStep = (typeof TRACKER_STEPS)[number];
/** A tracker step that failed: what was not done, the cause, and that the records stand (behavior 11). */
export function trackerStepFailedText(item: string, step: TrackerStep, cause: string, done: string | null, check: WriteCheck | null): string {
  /** No write was sent, so each lead may say what the item holds. */
  const unsent: Record<TrackerStep, string> = {
    setImplementing: `item ${item} could not be set to implementing, so the run made no agent call`,
    writeRefinement: `the requirements could not be written to item ${item}, and its state was not changed`,
    setRefined: `the requirements were written to item ${item}, but its state was not changed to refined`,
    setImplemented: `the work is done, but item ${item} could not be set to implemented and stays implementing`,
  };
  /** A write was attempted (W1-R1-1): the lead asserts nothing of its outcome, which the check alone states. */
  const attempted: Record<TrackerStep, string> = {
    setImplementing: `setting item ${item} to implementing could not be completed, so the run made no agent call`,
    writeRefinement: `writing the requirements to item ${item} could not be completed, and its state was not changed`,
    setRefined: `the requirements were written to item ${item}, but setting it to refined could not be completed`,
    setImplemented: `the work is done, but setting item ${item} to implemented could not be completed`,
  };
  return `${(check === null ? unsent : attempted)[step]}: ${cause}.${done === null ? "" : ` ${done}`}${check === null ? "" : ` ${writeCheckText(item, check)}`} The records of the run are kept.`;
}
/** Issue #171 (requirements Q2): what the item held after the last write of a halted tracker step, or that it could not be checked. */
export function writeCheckText(item: string, check: WriteCheck): string {
  if (check.kind === "unchecked") return `Item ${item} could not be checked after the last attempt.`;
  switch (check.held.kind) {
    case "noSection":
      return `After the last attempt, item ${item} held no Refined using Interloq section.`;
    case "otherSection":
      return `After the last attempt, item ${item} held a Refined using Interloq section other than the run's requirements.`;
    case "state":
      return `After the last attempt, item ${item} was in the state ${check.held.state}.`;
  }
}

// ---- the tracker retry (issue #171) ---------------------------------------------------------------------------------

/** A request of a run to its tracker in words: reading item 155, writing the requirements to item 155, setting item 155 to refined. */
export function trackerOperationText(op: TrackerOperation): string {
  switch (op.kind) {
    case "read":
      return `reading item ${op.item}`;
    case "writeRefinement":
      return `writing the requirements to item ${op.item}`;
    case "setState":
      return `setting item ${op.item} to ${op.state}`;
  }
}
/** A repeat of a failed tracker request, as the page and conversation.md show it. */
export function trackerRetryLine(tracker: string, what: string, attempt: number, of: number, delaySeconds: number, fault: string): string {
  return `${tracker}: request failed while ${what}, retry ${attempt} of ${of} in ${delaySeconds} s (${fault})`;
}
/** A tracker request that succeeded after a repeat. */
export function trackerRecoveredLine(tracker: string): string {
  return `${tracker}: request succeeded`;
}
/** A write the tracker answered with a server error, which the item read back showed applied (requirements Q2): nothing is repeated or asked. */
export function trackerWriteLandedLine(tracker: string, what: string): string {
  return `${tracker}: the request failed while ${what}, but the item read back shows it was applied; the run goes on`;
}
/** The question when a tracker request's repeats are used up: the tracker and the request; the attempts and the failure are under the fault's heading. */
export function trackerExhaustedQuestion(tracker: string, what: string): string {
  return `The ${tracker} issue tracker could not be reached for ${what}; the attempts and the last error are shown under "${attachedHeading("fault")}". Do you want Interloq to try the request again, or to stop the run?`;
}
export function trackerOptionDescriptions(): Readonly<{ retry: string; stop: string }> {
  return {
    retry: "Interloq makes the request again, with another full set of repeats and the waits between them starting again from the shortest.",
    stop: "the run ends here with exit code 1, and its records are kept.",
  };
}
export function trackerDecisionLine(answer: "retry" | "stop", tracker: string, what: string): string {
  return `**User decision:** ${answer === "retry" ? "retry again" : "stop the run"} after the ${tracker} issue tracker could not be reached for ${what}.\n\n`;
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

/**
 * Issue #162 (requirements Q4, P1-R1-1): the work review's criterion on a step's reported checks, judged by the step's
 * total across the phase's calls, with the step's id as the issue's location.
 */
export const WORK_CHECK_CRITERION = `Raise an issue for a step whose reported checks ran tests its change does not touch, ran a command its text in the plan does not name, or together took longer than ${STEP_CHECK_LIMIT_MS / 60_000} minutes (the step's total, not any single command); for such an issue, put the step's id, not a file path, in the location field.`;
/** The checks an execution phase reported, per step with each command's seconds and the step's total (issue #162). */
export const reportedChecksText = (execution: WorkExecution): string => {
  const totals = checkTotals(execution.outcome.checks);
  return totals.length === 0
    ? "none reported"
    : totals.map((total) => `- ${total.step}: ${total.seconds} seconds in all: ${total.commands.map((c) => `${codeSpan(c.command)} (${c.seconds} seconds)`).join(", ")}`).join("\n");
};
export function workReviewPrompt(root: RunRoot, phase: number, round: number, withRequirements: boolean, execution: WorkExecution, thread: ReviewThread): string {
  const prefix = `W${phase}`;
  const log = pathOf({ kind: "log", subject: { work: phase } });
  const changes = pathOf({ kind: "changes", phase });
  const later = () => `${runDir(root)}/${changes} has been rewritten from the current project for this round.
${laterRound(root, changes, log, prefix, round)}`;
  return byThread(round, thread, log, root, later, () => workReviewFirst(root, { phase, prefix, log, changes }, round, withRequirements, execution));
}
function workReviewFirst(root: RunRoot, names: Readonly<{ phase: number; prefix: string; log: string; changes: string }>, round: number, withRequirements: boolean, execution: WorkExecution): string {
  const { phase, prefix, log, changes } = names;
  const requirements = withRequirements
    ? `${runDir(root)}/requirements.md contains the user's confirmed answers and decisions. Raise an issue when the work contradicts it or omits something it requires of a completed step.\n`
    : "";
  return `Review the work done in the project since the run began. ${runDir(root)}/${changes} is the diff of the project against its state at the start of the run (new files in full, committed changes included); read it and the project itself. Do not modify any file.
Review the work against the plan in ${runDir(root)}/plan.json. ${planStatuses(root)} Steps with status 'done' are implemented; review their work against the plan. Missing work of a step with another status is not an issue.
${requirements}Raise an issue for work that does not implement a completed step, contradicts the plan or the requirements, or introduces a defect.
Put the file path, with a line number where it helps, in the location field.
${WORK_CHECK_CRITERION}
The check commands execution phase ${phase} reported, per step:
${reportedChecksText(execution)}
${logRules(root, log, prefix, round)}`;
}

/**
 * The records a read-only work response is given in its prompt, since it can read no file (decision Q1 of the stage-A
 * task; issue #122, G-R1-1): changes.diff, requirements.md where the run has one, and user-decisions.md. They come
 * together or not at all.
 */
export type WorkRecords = Readonly<{ changes: string; requirements: string | null; decisions: string }>;

/**
 * What a response to a review is given besides the round (decision Q1 of the stage-A task): the review of the round,
 * the subject's log entries, and the records of a read-only work response (null for the other subjects).
 */
export type RespondContext = Readonly<{ review: Review; log: readonly LogEntry[]; records: WorkRecords | null }>;

/**
 * What a work response is given of its phase's execution (issue #117): the execution ran in a session of its own, so its
 * report and the plan as the execution's end left it (plan.md, with the steps' statuses) travel in the prompt.
 */
export type WorkExecution = Readonly<{ outcome: ExecOutcome; plan: string }>;

/**
 * A work response is read-only (finding 1 of docs/gui-review.md): it may call no tool. Since issue #122 it runs in its
 * work review's own session, which has seen no other phase, so the prompt carries the task, the review, the entries of
 * this work review's phase in the work-review log, changes.diff, requirements.md where the run has one and
 * user-decisions.md verbatim, and (issue #117) the report of the phase's execution and the plan as its end left it.
 */
export function workRespondPrompt(root: RunRoot, phase: number, round: number, context: RespondContext, execution: WorkExecution, task: string): string {
  const entries = context.log.filter((e) => e.phase === phase);
  const records = context.records;
  const requirementsText = records?.requirements ?? null;
  const requirements = requirementsText === null ? "" : `\n\nThe requirements (${runDir(root)}/${pathOf({ kind: "requirements" })}):\n${requirementsText}`;
  return `${runDir(root)}/${pathOf({ kind: "review", subject: { work: phase }, round })} contains a review of the work done in the project (the diff in ${runDir(root)}/${pathOf({ kind: "changes", phase })}).
You cannot use any tool in this response: the task, the review, the earlier entries of this work review's log, the diff, ${requirementsText === null ? "" : "the requirements, "}the user's decisions, the report of execution phase ${phase} and the plan with its steps' statuses are below. This response runs in a Claude Code session of its own, which has not seen the planning or the execution: it has only what is below. Answer with the final structured output only.
${respondRules(root, "the correction will be made in a later execution phase after the plan has been revised; do not modify any file")}
Every correction, including one that a self-correction calls for, is made in a later execution phase; state in the rationale what the correction requires.
Do not modify any file.

The task:
${task}${requirements}

The user's decisions (${runDir(root)}/${pathOf({ kind: "decisions" })}):
${records === null || records.decisions.trim() === "" ? "(none)" : records.decisions}

The review (${pathOf({ kind: "review", subject: { work: phase }, round })}):
${JSON.stringify(context.review, null, 2)}

The earlier entries of work review ${phase} in ${runDir(root)}/${pathOf({ kind: "log", subject: { work: phase } })}:
${entries.length === 0 ? "(none)" : JSON.stringify(entries, null, 2)}

The diff (${runDir(root)}/${pathOf({ kind: "changes", phase })}):
${records?.changes ?? "(not available)"}

The report of execution phase ${phase}:
Status: ${execution.outcome.status}
Summary: ${execution.outcome.summary || "none"}
Remaining work: ${execution.outcome.remainingWork || "not reported"}${execution.outcome.question === "" ? "" : `\nQuestion at the stop: ${execution.outcome.question}`}
Check commands run, per step:
${reportedChecksText(execution)}

The plan as execution phase ${phase} ended (${runDir(root)}/plan.md):
${execution.plan}`;
}

/**
 * The revision of the plan after execution phase `phase`, the first call of the next planning phase, which runs in a
 * Claude Code session of its own (issue #122): so it names the task, requirements.md where the run has one, and
 * user-decisions.md, which the run's one session used to carry.
 */
/**
 * How an execution phase stopped (issue #181, requirements Q6, Q7): with the user's answer to a question Claude Code
 * relayed during the call, recorded in user-decisions.md, or without one, Claude Code's own account of the stop then
 * carried in the revision prompt, since the revision runs in a session that has not seen the execution.
 */
export type ExecStop =
  | Readonly<{ _tag: "Answered" }>
  | Readonly<{ _tag: "Unanswered"; status: "needs_input" | "blocked" | "aborted"; summary: string; question: string; remainingWork: string }>;

/**
 * Why the plan is revised after execution phase k (issue #162): the execution and its work review ended with a stop or
 * a correction due, or the work review found nothing to correct and the whole suite Interloq then ran failed, or (issue
 * #176) the work review found nothing to correct, the suite passed where one is named, and Interloq's commit check found
 * files the run changed and left uncommitted. The run is finished only when the check finds nothing.
 */
export type RevisionCause =
  | Readonly<{ _tag: "ExecutionEnded"; stop: ExecStop | null; workReview: WorkReviewEnd }>
  | Readonly<{ _tag: "SuiteFailed"; suite: number; command: CommandLine; reason: WorkFailure; tail: string; log: string }>
  | Readonly<{ _tag: "Uncommitted"; paths: NonEmptyPaths; suite: CommandLine | null }>;

/** A suite run's failure in words (issue #162): its exit code, the signal that ended it, the bound, or why it did not start. */
export function suiteFailureText(reason: SuiteFailure): string {
  switch (reason.kind) {
    case "exit":
      return `it exited with code ${reason.code}`;
    case "signal":
      return `it was ended by the signal ${reason.signal}`;
    case "timedOut":
      return `it ran longer than ${reason.ms / 60_000} minutes and was stopped`;
    case "notStarted":
      return `it could not be started (${reason.message})`;
  }
}

/** What the revision prompt says of its cause. */
/** A stop of execution in a revision prompt (issue #181): the user's input where he answered, else Claude Code's account. */
const execStopText = (root: RunRoot, stop: ExecStop): string => {
  switch (stop._tag) {
    case "Answered":
      return `\nExecution stopped. The last entry of ${runDir(root)}/user-decisions.md contains the user's input for this stop.`;
    case "Unanswered": {
      const stated = (text: string): string => (text.trim() === "" ? "none stated" : text);
      return `\nExecution stopped with the status ${stop.status}, and the user was not asked: Interloq revises the plan from Claude Code's own account of the stop, which follows.
Summary: ${stated(stop.summary)}
What it needed: ${stated(stop.question)}
Remaining work: ${stated(stop.remainingWork)}
Settle what it needed from the task, the requirements, the codebase and ${runDir(root)}/user-decisions.md, and state each assumption you settle in the text of the step it concerns.`;
    }
  }
};
/** Issue #181: the line said and written when an execution stop is revised from Claude Code's account, without a question. */
export function execStopRevisionLine(label: string, status: string): string {
  return `${label} stopped with the status ${status}. After the review of the work, Claude Code revises the plan from its own account of the stop, without a question to you.`;
}
const revisionCauseText = (root: RunRoot, phase: number, cause: RevisionCause): string => {
  switch (cause._tag) {
    case "ExecutionEnded": {
      const stop = cause.stop === null ? "" : execStopText(root, cause.stop);
      const review =
        cause.workReview === "converged"
          ? `\nWork review ${phase} found no issue in the work so far.`
          : `\nWork review ${phase} ended in round ${cause.workReview.revisedInRound} with accepted issues or a user decision: ${runDir(root)}/${pathOf({ kind: "round", subject: { work: phase }, round: cause.workReview.revisedInRound })}, ${runDir(root)}/${pathOf({ kind: "log", subject: { work: phase } })} and the last entries of ${runDir(root)}/user-decisions.md.`;
      return `${stop}${review}`;
    }
    case "SuiteFailed":
      return `\nWork review ${phase} found nothing left to correct. Interloq then ran the whole suite, ${codeSpan(cause.command)}, and it failed: ${suiteFailureText(cause.reason)}. Its whole output is in ${cause.log}; its last ${SUITE_TAIL_LINES} lines are:
${codeFence(cause.tail)}
${cause.tail}${cause.tail.endsWith("\n") ? "" : "\n"}${codeFence(cause.tail)}
Revise the plan with steps that correct this failure; each step still checks its change under the rule below, and Interloq runs the whole suite again after the next review of the work finds nothing left to correct.`;
    case "Uncommitted": {
      const passed = cause.suite === null ? "" : ` Interloq then ran the whole suite, ${codeSpan(cause.suite)}, and it passed.`;
      const suiteAgain = cause.suite === null ? "" : " and the whole suite passes";
      return `\nWork review ${phase} found nothing left to correct.${passed} Interloq then found these files changed by the run and not committed:
${cause.paths.map((p) => `- ${codeSpan(p)}`).join("\n")}
The run is not finished while they are uncommitted. Revise the plan with steps that commit them as the project's own instructions direct; Interloq checks again after the next review of the work finds nothing left to correct${suiteAgain}.`;
    }
  }
};

export function revisePlanAfterExecutionPrompt(root: RunRoot, task: string, withRequirements: boolean, phase: number, cause: RevisionCause, checks: StepChecks): string {
  return planRevisionPrompt(
    root,
    task,
    withRequirements,
    `Execution phase ${phase} has ended.${revisionCauseText(root, phase, cause)}
This request runs in a Claude Code session of its own, which has not seen the earlier phases: read the files named here.`,
    `Revise the plan in ${runDir(root)}/plan.json: keep the steps with status 'done', add steps that correct the accepted issues and follow the decisions, and change, add, or remove the other steps as the current state of the codebase requires.`,
    checks,
  );
}

/**
 * The rules every revision of the whole plan in a session of its own carries, around its opening and its instruction
 * (issue #180): revisePlanAfterExecutionPrompt and earlierPlanPrompt share them, so the two cannot diverge.
 */
const planRevisionPrompt = (root: RunRoot, task: string, withRequirements: boolean, opening: string, revise: string, checks: StepChecks): string => {
  const requirements = withRequirements ? `${requirementsSentence(root)}\n` : "";
  return `${opening}
${requirements}${userDecisionsSentence(root)}
${revise}
${planStatuses(root)} An unfinished step counts as remaining.
${planFormat(root)}
${planStepCheckRule(checks)}
${planStepSelfContainedRule(root)}
${PLAN_COMMIT_STEP_RULE}
${planIdRule(root)}
If no change to the plan is required, return it as it is. Do not modify any file. Do not implement anything.
${PLAN_QUESTIONS_RULE}
Put in questions_for_user only the questions the rule on whether to ask, below, allows; otherwise return an empty array.
${QUESTION_OPTIONS_RULE}
Task: ${task}`;
};

/**
 * A prompt to the user in the web page's words: the same question without the key conventions of its hint, which
 * the page's buttons replace (plan step 4.7). `kind` is the prompt's kind in src/userPrompts.ts.
 */
export function pagePromptText(kind: string, offeredText: string): string {
  const text = offersOf(offeredText).text;
  switch (kind) {
    case "decision":
      return "Choose an option, answer in your own words, or continue without deciding.";
    case "limit":
      return "Proceed without convergence, add cycles, or stop the run.";
    case "limitNoProceed":
      return "Add cycles, or stop the run.";
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

/**
 * The name the page gives the conversation in which the user answers the agreed questions, in the progress rail and
 * above the conversation alike (issue #113). The developer renamed it from "User Decisions" on 11 Oct 2026; the rail's
 * step and the heading stay one name, which is issue #113's decision.
 */
export const USER_DECISIONS = "You Decide";
/**
 * The name of a conversation with the user as the page shows it (issue #21, Q5 follow-up; issue #113: the rail's step and
 * this heading name one activity). "More" is used only where an intervening phase separates those questions from the
 * first ones: the second interview follows the requirements review that accepted a gap. A question asked inside a
 * conversation (a question origin of kind followUp) has no such phase between, and keeps its own words.
 */
export function clarificationHeading(stage: InterviewStage): string {
  switch (stage) {
    case "clarification":
      return USER_DECISIONS;
    case "followUp":
      return "More for you to decide";
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
/** The interview's opening help in the page (finding 8 of docs/gui-review.md). */
export function interviewHelp(heading: string): string {
  return `${heading}. /done ends the clarification, /quit ends the run; Shift+Enter starts a new line.`;
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

/**
 * The name of a phase as both interfaces show it (issue #14): the first phase gathers the requirements, and an
 * execution phase implements the plan. The records keep their own names (question-review/, execution-<k>/). Issue #6:
 * `count` is how many phases of the kind the run holds, begun or foreseen; with one, the phase carries no number.
 */
export function phaseLabel(kind: "questions" | "planning" | "execution" | "work" | "suite", n: number, count: number): string {
  const numbered = (name: string) => (count === 1 ? name : `${name} ${n}`);
  switch (kind) {
    case "questions":
      return "Gather Requirements";
    case "planning":
      return numbered("Planning");
    case "execution":
      return numbered("Implementation");
    case "work":
      return numbered("Code review");
    case "suite":
      return numbered(FULL_SUITE_PHASE);
  }
}
/** Issue #162: the lines of a suite run, said on the page and written to conversation.md. */
export function suiteBeganLine(label: string, command: string): string {
  return `\n${label}: Interloq runs the whole suite, ${command}, because the review of the work found nothing left to correct.`;
}
export function suitePassedLine(label: string, command: string): string {
  // Issue #176: the commit check follows a passed suite, so the pass alone no longer finishes the run.
  return `${label} passed: ${command}.`;
}
export function suiteFailedLine(label: string, command: string, reason: WorkFailure, log: string): string {
  return `${label} failed: ${command}; ${suiteFailureText(reason)}. Its output is in ${log}. Claude Code revises the plan to correct it, and the suite runs again after the next review of the work finds nothing left to correct.`;
}
/**
 * Issue #181 (requirements Q1): a suite run stopped outside the work, by its limit or unable to start, said on the page
 * and written to conversation.md: not a fault of the work, so the plan is not revised from it.
 */
export function suiteStoppedLine(label: string, command: string, reason: OutsideStop, log: string): string {
  return `${label} was stopped: ${command}; ${suiteFailureText(reason)}. Its output is in ${log}. This is not a fault of the work, so the plan is not revised from it.`;
}
/** Issue #181: the one automatic repeat of a suite run stopped outside the work. */
export function suiteRepeatLine(label: string, command: string): string {
  return `Interloq runs the whole suite, ${command}, again once, without revising the plan, because ${label} was stopped before it could finish.`;
}
/** Issue #181: the question when the final suite was stopped outside the work after the one automatic repeat. */
export function suiteStoppedQuestion(label: string, command: string): string {
  return `${label}, the whole suite ${command} that Interloq runs before the run can finish, was stopped again before it finished; the reason and its output are shown under "${attachedHeading("suiteStop")}". Do you want Interloq to run the suite again, or to stop the run?`;
}
export const SUITE_RUN_AGAIN = "Run the suite again";
export const SUITE_STOP = "Stop the run";
export function suiteStoppedOptionDescriptions(): Readonly<{ retry: string; stop: string }> {
  return {
    retry: "Interloq runs the whole suite once more, without revising the plan; if that run is stopped again before it finishes, you are asked this question again.",
    stop: "the run ends here with exit code 1, its records are kept, and its item stays in the implementing state.",
  };
}
/** Whether the stop that used the automatic repeat is one of the stops of the question's own loop (issue #181, W1-R1-1). */
const repeatedAmong = (stops: readonly SuiteStop[], repeated: SuiteStop): boolean => stops.some((s) => s.suite === repeated.suite);
/**
 * The facts of the suite's question a context call is given (issue #181, W1-R1-1): every stop of the question's loop
 * with its reason and its log, how many in a row, and the stop after which the one automatic repeat was used.
 */
export function suiteStoppedFacts(command: string, stops: readonly [...SuiteStop[], SuiteStop], repeated: SuiteStop): string {
  const each = stops.map((s) => `Suite run ${s.suite} was stopped before it finished: ${suiteFailureText(s.reason)}; its output is in ${s.log}.`).join(" ");
  const where = repeatedAmong(stops, repeated) ? "" : ` (earlier in the run: ${suiteFailureText(repeated.reason)}; its output is in ${repeated.log})`;
  return `At the end of an implementation run, after the review of the work found nothing left to correct, Interloq ran the project's whole suite, ${command}, itself. ${each} That is ${stops.length} ${stops.length === 1 ? "stop" : "stops"} in a row. A stop by the time limit or a shell that could not start is not a fault of the work, so the plan is not revised from it; Interloq repeats the suite once in the whole run without asking, and used that repeat after suite run ${repeated.suite}${where}.`;
}
/**
 * The attached material of the suite's question (issue #181, W1-R1-1, P2-R1-1): one item per stop with its reason and
 * its log; the stop that used the automatic repeat first where it is not among them, so every stop the question rests on
 * is listed with its log.
 */
export function suiteStoppedDetails(stops: readonly [...SuiteStop[], SuiteStop], repeated: SuiteStop): readonly Block[] {
  const item = (s: SuiteStop) => ({
    level: 0,
    pieces: [plainPiece(`Suite run ${s.suite} was stopped because ${suiteFailureText(s.reason)}${s.suite === repeated.suite ? ", and Interloq then used its one automatic repeat of the suite in this run" : ""}. Its whole output is in `), codePiece(s.log), plainPiece(".")],
  });
  const listed = repeatedAmong(stops, repeated) ? stops : [repeated, ...stops];
  return [{ kind: "list", items: listed.map(item) }];
}
/**
 * What led to the suite's question (issue #181, W1-R1-1): one paragraph per earlier event, the automatic repeat and each
 * later stop after which the developer chose Run the suite again; the last stop, the question's subject, is not in it.
 */
export function suiteStoppedHistory(stops: readonly [...SuiteStop[], SuiteStop], repeated: SuiteStop): readonly Block[] {
  const paragraph = (text: string): Block => ({ kind: "paragraph", pieces: [plainPiece(text)] });
  const earlier = repeatedAmong(stops, repeated) ? [] : [paragraph(`Earlier in the run, suite run ${repeated.suite} was stopped because ${suiteFailureText(repeated.reason)}, and Interloq ran the suite again without asking: its one automatic repeat in the run, which is now used.`)];
  const before = stops.slice(0, -1).map((s) =>
    paragraph(
      s.suite === repeated.suite
        ? `Suite run ${s.suite} was stopped because ${suiteFailureText(s.reason)}, and Interloq ran the suite again once without asking: its one automatic repeat in the run.`
        : `Suite run ${s.suite} was stopped because ${suiteFailureText(s.reason)}, and you chose ${SUITE_RUN_AGAIN}.`,
    ),
  );
  return [...earlier, ...before];
}
/** Issue #181: the halt when the developer stops the run at the suite's question. */
export function suiteStoppedText(command: string, suite: number, stops: number, reason: string): string {
  return `the run was stopped at the user's answer after suite run ${suite} of ${command} was stopped before it finished (${reason}), ${stops} times in a row. The records are preserved.`;
}
/** Issue #176: the line of a commit check that found files the run left uncommitted, said on the page and written to conversation.md. */
export function uncommittedLine(label: string, paths: NonEmptyPaths, suite: string | null): string {
  const after = suite === null ? `${label} found nothing left to correct` : `${label} found nothing left to correct and the whole suite, ${suite}, passed`;
  const again = suite === null ? "" : " and the suite passes";
  return `${after}, but the run left ${paths.length === 1 ? "this file" : "these files"} uncommitted: ${paths.join(", ")}. Claude Code revises the plan to commit ${paths.length === 1 ? "it" : "them"}, and Interloq checks again after the next review of the work finds nothing left to correct${again}.`;
}
/** Issue #162: a Full test suite's result as the progress rail shows it. */
export function suiteResultText(outcome: SuiteOutcome): string {
  return outcome === "passed" ? "Passed" : "Failed";
}
/** Issue #162: the name of the phase in which Interloq runs the whole suite after the review of the work finds nothing left to correct. */
export const FULL_SUITE_PHASE = "Full test suite";
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
const NOT_SENT_SUBJECT: Record<"answer" | "stop" | "start" | "items" | "ui", string> = {
  answer: "Your answer was not sent",
  ui: "Opening or closing an entry of the analysis was not sent",
  stop: "Stop was not sent",
  start: "The start of the run was not sent",
  items: "The request for the tab's items was not sent",
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
export function notSentNotice(kind: "answer" | "stop" | "start" | "items" | "ui", reason: "ended" | "restarted" | "disconnected", quoted?: string): string {
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
// Issue #16: the alerts that a run waits for the user, or that a run he watched has ended.
/** The title marker of a pending prompt, put in front of the tab's title. */
export const TITLE_WAITING_MARK = "●";
/** The title marker of a run that ended while the tab was hidden. */
export const TITLE_ENDED_MARK = "✓";
/** How a run ended, by its exit code: the words of "This task has ended (…)" and of the end's notification. */
export const endedOutcome = (code: number): "finished" | "interrupted" | "halted" => (code === 0 ? "finished" : code === 130 ? "interrupted" : "halted");
/** The desktop notification of a pending prompt, named by the project's own name. */
export const pauseNotificationTitle = (name: string): string => `${name}: Interloq is waiting for you`;
export const PAUSE_NOTIFICATION_BODY = "The run is paused until you answer its question.";
/** The desktop notification of a run's end. */
export const endNotificationTitle = (name: string, code: number): string => `${name}: the task has ${endedOutcome(code)}`;
/** The switch of desktop notifications in the top bar. */
export const DESKTOP_ALERTS_LABEL = "Desktop alerts";
/** The switch of the sound in the top bar. */
export const SOUND_ALERTS_LABEL = "Sound";
/** Why desktop notifications cannot be shown although the user turned them on. */
export const desktopBlockedNote = (permission: "denied" | "unsupported"): string =>
  permission === "denied"
    ? "The browser blocks notifications from this page. Allow them in the browser's site settings for this address; the tab's title and icon still show when a run waits."
    : "This browser cannot show notifications from this page. The tab's title and icon still show when a run waits.";
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
/**
 * The condition of a collapsed branch of the progress rail in one word (issue #63), from the steps it hides: none begun,
 * some begun and not all finished, all finished. Since issue #110 it is not shown as a line: it is the words of a stage's
 * glyph, and part of a phase's accessible name.
 */
export const RAIL_CONDITION_LABEL: Record<"notStarted" | "partial" | "completed", string> = {
  notStarted: "not started",
  partial: "partially completed",
  completed: "completed",
};
/** The accessible name and value of a collapsed branch's bar (issue #63): a count of steps, never a time. */
export function stepsCompleteLabel(done: number, total: number): string {
  return `${done} of ${total} ${total === 1 ? "step" : "steps"} complete`;
}
/**
 * The accessible name of a row of the progress rail that opens and closes (issue #63; issue #110): its label, the state its
 * mark shows in words, the condition of what it holds and the step that runs inside it. Whether it is open is not in the
 * name: aria-expanded carries it, so the name is the same open or closed.
 */
export function railToggleName(label: string, state: string, condition: string | null, running: string | null): string {
  return [label, state, ...(condition === null ? [] : [condition]), ...(running === null ? [] : [`working on ${running}`])].join(", ");
}
/** The description of a row the run holds open (issue #63): something inside it needs the user, so it does not close. */
export const RAIL_HELD_OPEN_LABEL = "Kept open: something inside needs your answer";
/** The accessible name of the plan's list under its Implementation entry. */
export const PLAN_LIST_LABEL = "The steps of the plan";
/**
 * The steps of Gather Requirements in the progress rail (issue #21, Q5 and Q7; issue #33, renamed "Creating Questions" on 11 Oct 2026). Issue #51:
 * a follow-up clarification is part of the clarification's step. Issue #113: that step is "User Decisions", the name of
 * the heading above the conversation, and the terms step is "Define terms"; the records keep "clarification".
 */
export function stepLabel(kind: "formulate" | "terms" | "clarification"): string {
  return kind === "formulate" ? "Creating Questions" : kind === "terms" ? "Define terms" : USER_DECISIONS;
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
/**
 * The senses of a term as a dictionary numbers them (issue #112): one sense has no number, several are numbered 1…n in
 * the order given. The one numbering of the page's tooltip and of conversation.md (numberedSenses in src/question.ts).
 */
export const sensesNumbered = (senses: readonly string[]): readonly Readonly<{ number: number | null; text: string }>[] =>
  senses.map((text, i) => ({ number: senses.length === 1 ? null : i + 1, text }));
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
  phase: Readonly<{ kind: "questions" }> | Readonly<{ kind: "planning" | "execution" | "work" | "suite"; n: number }>;
  label: string;
  question: string;
  options: readonly Readonly<{ label: string; description: string }>[];
  /**
   * What the user was shown with the question (S37): its context, details and terms as Markdown, the terms as the items
   * of conversation.md's Terms block (termItem of src/render.ts; W1-R1-2 of work review 1).
   */
  shown?: Readonly<{ context: string; history: string; terms: string; details: string }>;
}>;
/** What the user was shown with a question, as the analysis prompt carries it under the options (S37); "" when nothing. */
export function shownWithQuestion(shown: DecisionPromptQuestion["shown"]): string {
  if (shown === undefined) return "";
  const parts = [
    ...(shown.context.trim() === "" ? [] : [`The context paragraph:\n${shown.context.trim()}`]),
    ...(shown.history.trim() === "" ? [] : [`The history:\n${shown.history.trim()}`]),
    ...(shown.details.trim() === "" ? [] : [shown.details.trim()]),
    ...(shown.terms.trim() === "" ? [] : [`${TERMS_HEADING}\n${shown.terms}`]),
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
export function decisionAnalysisPrompt(root: RunRoot, format: string, question: DecisionPromptQuestion, context: DecisionContext): string {
  const options = question.options.map((o, i) => optionLine(i, o)).join("\n");
  const requirements = context.requirements === null ? `${runDir(root)}/requirements.md does not exist yet.` : `${runDir(root)}/requirements.md:\n${context.requirements}`;
  const plan = context.plan === null ? `${runDir(root)}/plan.md does not exist yet.` : `${runDir(root)}/plan.md:\n${context.plan}`;
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
export function decisionReviewPrompt(root: RunRoot, format: string, k: number, round: number, thread: ReviewThread): string {
  const prefix = `D${k}`;
  const analysis = pathOf({ kind: "analysis", decision: k });
  const log = pathOf({ kind: "log", subject: { decision: k } });
  const own = `${runDir(root)}/${log} holds the issues of every decision of the run; the issues of this decision are the entries whose ids begin with ${prefix}-, and only those concern this review.`;
  return byThread(round, thread, log, root, () => `${own}\n${laterRound(root, analysis, log, prefix, round)}`, () => `Review the representation of the arguments for and against the options of a decision in ${runDir(root)}/${analysis} (its field 'analysis'). The question and its options are in ${runDir(root)}/${pathOf({ kind: "decisionQuestion", decision: k })}. Do not modify any file.
The representation must follow the instructions below. The program renders it: it places the headings "Advantages:" and "Disadvantages:" and the labels of the entries ("Advantage 1:", "Disadvantage 1:"), offsets each counterargument from the element it disputes, and assigns the equivalence symbols from the field equivalent_to, which names the id of the equivalent entry; do not raise an issue about those. A column of kind "unclear" is how the representation states, in place of an option's arguments, what is unclear about the option and which readings are possible; review whether the option is in fact unclear in that sense and whether the statement says so. Counterarguments, defenses and counterarguments to a defense that stand together begin with "But,", "On the other hand," or "Then again," for the first and "Also," for each further one.

${DECISION_FORMAT_AUTHORITY}

${format}

Raise an issue for every departure from these instructions, for example: an element absent or false in an entry; an entry whose effect on persons is not stated; an entry placed in a column contrary to the placement rules; an outcome listed that is the same under every option; a counterargument that disputes no element of its entry or is not placed at the element it disputes, or that does not begin with the required words; a reversal not listed in full as an entry; an argument equivalent to an entry that repeats its content instead of referring to it; a claim of a measurement, figure, source or property that is invented, or an unknown value assumed instead of stated as unknown; an argument, counterargument or defense that an informed person could make and that is missing; a column missing or not matching an option; a recommendation that is not supported by the comparison that "Recommendation" requires. The context of the run is in the project and under ${runDir(root)}/.
Put the entry id or the argument id, with the column's option, in the location field.
${own}
${logRules(root, log, prefix, round)}`);
}

/** Claude Code's response to a review of decision k: the dispositions and the complete amended analysis. */
export function decisionRespondPrompt(root: RunRoot, k: number, round: number): string {
  return `${runDir(root)}/${pathOf({ kind: "review", subject: { decision: k }, round })} contains a review of the representation in ${runDir(root)}/${pathOf({ kind: "analysis", decision: k })}, which you produced under the instructions of docs/decision-making.md given earlier in this session.
${respondRules(root, "you amend the analysis for it")}
Return in 'analysis' the complete analysis after your amendments, including the parts that did not change; the program writes it. Do not modify any file.`;
}

/** The call that applies the user's decisions at a pause of decision k's review. */
export function decisionApplyDecisionsPrompt(root: RunRoot, k: number): string {
  return `${runDir(root)}/user-decisions.md has new entries. Read the file.
Return in 'analysis' the complete analysis of ${runDir(root)}/${pathOf({ kind: "analysis", decision: k })}, amended where a decision requires it; the program writes it. Do not modify any file.`;
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
/** The line that carries the offer in a prompt text (D1): the page turns it into a button. */
export const OFFER_LINE = `/decide = ${HELP_ME_DECIDE}: work out the arguments for and against each option before you choose`;
/** A prompt with the offer: the offer line, then the prompt. */
export const withOffer = (prompt: string): string => `${OFFER_LINE}\n${prompt}`;
/** Issue #142: the label of the request for the explanations of the terms of the question on the screen. */
export const EXPLAIN_TERMS = "Explain the terms";
/** The line that carries the request for a question's terms in a prompt text: the page turns it into a button. */
export const TERMS_OFFER_LINE = `/terms = ${EXPLAIN_TERMS}: Claude Code explains the words of this question that you may not know`;
/** A prompt with the request for its question's terms, put outermost, over the offer of decision support. */
export const withTermsOffer = (prompt: string): string => `${TERMS_OFFER_LINE}\n${prompt}`;
/** The prompt without its offer lines, and which it carried: the terms line first (outermost), then the decide line. */
export const offersOf = (text: string): Readonly<{ decide: boolean; terms: boolean; text: string }> => {
  const strip = (line: string, t: string): Readonly<{ found: boolean; text: string }> => (t.startsWith(`${line}\n`) ? { found: true, text: t.slice(line.length + 1) } : { found: false, text: t });
  const terms = strip(TERMS_OFFER_LINE, text);
  const decide = strip(OFFER_LINE, terms.text);
  return { decide: decide.found, terms: terms.found, text: decide.text };
};
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
 * page and conversation.md read them alike.
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
  return unknownNames(input).map(({ id, shown }) => ({ id, term: shown.text, senses: [shown.kind === "literal" ? unknownSettingExplanation : unknownSettingEscapedExplanation] }));
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
  if (isEmptyObject(input)) return [{ kind: "paragraph", pieces: [plainPiece(NO_INPUT_PHRASE)] }];
  const all = rows([], "", input, 0);
  // Consecutive items form one list; a code block or the escapes' note ends it.
  const blocks = all.reduce<readonly Block[]>((acc, row) => {
    if (row.kind === "code") return [...acc, { kind: "code", text: row.text }];
    if (row.kind === "note") return [...acc, { kind: "paragraph", pieces: escapedNotePieces("") }];
    const last = acc[acc.length - 1];
    const it = { level: row.level, pieces: row.pieces };
    return last?.kind === "list" ? [...acc.slice(0, -1), { kind: "list", items: [...last.items, it] }] : [...acc, { kind: "list", items: [it] }];
  }, []);
  return blocks;
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
 * The question of a permission request (S12, S49): the tool and the kind of action, pointing at the input by its heading,
 * attachedHeading("request"), with no direction, since the page shows it after the question and conversation.md before
 * it (issue #137). The input itself is never in the question, so that a long command cannot push the answers out of view.
 */
export function permissionQuestion(tool: string, input: unknown): string {
  const fields = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const shown = `shown under "${attachedHeading("request")}"`;
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
  return `Claude Code, while it carries out the plan, asks to use its tool ${tool} with this input:\n${lines}\nIf the user allows it, the tool runs in the project; if not, Claude Code is told so and continues without it. The user is shown the input under the heading "${attachedHeading("request")}".${unknown.length === 0 ? "" : `\n${unknownSettingsRequest(unknown)}`}`;
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

// ---- decision support: the representation as the page shows it ---------------------------------------

/** The heading above a column's disadvantages (docs/decision-making.md, "Layout and wording"); the renderer places it. */
export const DISADVANTAGES_HEADING = "Disadvantages:";
/** The heading above a column's advantages (issue #35). */
export const ADVANTAGES_HEADING = "Advantages:";
/** The label of the n-th entry under each heading (issue #35), numbered from one within each heading of each column. */
export function advantageLabel(n: number): string {
  return `Advantage ${n}:`;
}
export function disadvantageLabel(n: number): string {
  return `Disadvantage ${n}:`;
}
/** The start of a decision page's heading, before the question (issue #133, the developer's instruction of 11 Oct 2026). */
export const YOUR_CHOICE = "Your Choice:";
/** The accessible name of a decision's analysis: its heading, "Your Choice: " and the question (issue #133). */
export const decisionRegionName = (question: string): string => `${YOUR_CHOICE} ${question}`;
/** The accessible name of an equivalence symbol's link (issue #133): the mark, and the entry it names by its label and title. */
export const equivalenceLinkName = (mark: string, label: string, title: string): string => `${mark}: the same point as ${label} ${title}`;
export const RECOMMENDATION_HEADING = "Recommendation";
export function recommendedOption(option: string): string {
  return `Recommended option: ${option}`;
}
/** Below 390 px the analysis is not laid out (decided 28 Sep 2026). */
export const ENLARGE_WINDOW_NOTICE = "The analysis needs a window at least 390 pixels wide. Widen the window to read it; you can answer the question above without it.";
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
/** A retry of the program after a transport fault, as the page and conversation.md show it. */
export function transportRetryLine(agent: "claude" | "codex", attempt: number, of: number, delaySeconds: number, fault: string): string {
  return `${agentName(agent)}: connection lost, retry ${attempt} of ${of} in ${delaySeconds} s (${fault})`;
}
/** The accessible name of the determinate indicator while the program waits for a usage limit to lift (issue #68). */
export const USAGE_LIMIT_WAITING_LABEL = "Waiting for the usage limit to lift";
/** The names of the Agent SDK's rateLimitType values (issue #68). */
const LIMIT_NAMES: Readonly<Record<string, string>> = {
  five_hour: "five-hour session limit",
  seven_day: "weekly limit",
  seven_day_opus: "weekly Opus limit",
  seven_day_sonnet: "weekly Sonnet limit",
  seven_day_overage_included: "weekly limit (overage included)",
  overage: "overage limit",
};
/** The name of a usage limit by the Agent SDK's rateLimitType (issue #68); an unknown or missing type is "usage limit". */
export function limitName(limitType: string | null): string {
  return (limitType !== null && Object.hasOwn(LIMIT_NAMES, limitType) ? LIMIT_NAMES[limitType] : undefined) ?? "usage limit";
}
/** An instant in UTC to the minute, as the wait lines name it: 2026-09-30 08:11 UTC. */
export function utcMinute(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
/** The interval of the tries at a usage limit with no known end, in words (issue #170). */
const RETRY_INTERVAL_TEXT = `${USAGE_LIMIT_RETRY_SECONDS / 60} minutes`;
/**
 * The start of a wait for a usage limit, as the page and conversation.md show it (issue #68), by what the wait rests on
 * (issue #170): a stated reset; a stated reset already past, tried again a minute later; or no stated end, tried every
 * 5 minutes. Only a stated reset is said to end the limit.
 */
export function usageLimitWaitLine(agent: "claude" | "codex", limitType: string | null, basis: LimitWaitBasis, untilMs: number): string {
  const reached = `${agentName(agent)}: ${limitName(limitType)} reached`;
  switch (basis.kind) {
    case "reset":
      return `${reached}; Interloq waits until ${utcMinute(untilMs)}, then continues`;
    case "pastReset":
      return `${reached}; its stated reset, ${utcMinute(basis.namedMs)}, has already passed; Interloq tries again at ${utcMinute(untilMs)}`;
    case "noKnownEnd":
      return `${reached} with no stated end; Interloq makes try ${basis.attempt} at ${utcMinute(untilMs)}, and tries every ${RETRY_INTERVAL_TEXT} until ${agentName(agent)} accepts a request`;
  }
}
/** The end of a wait for a usage limit whose end was not stated (issue #170): a try, with no claim that the limit lifted. */
export function usageLimitTryingAgainLine(agent: "claude" | "codex"): string {
  return `${agentName(agent)}: trying again after the wait for the usage limit`;
}
/** Issue #184: a background try of a request whose retries are used up, while the developer answers the agreed questions. */
export function backgroundRetryLine(agent: "claude" | "codex", what: string, count: number, seconds: number): string {
  return `${agentName(agent)} could not be reached for ${what}; trying again in the background every ${durationText(seconds * 1000)} while you answer, try ${count}`;
}
/** The end of a wait for a usage limit (issue #68). */
export function usageLimitLiftedLine(agent: "claude" | "codex", waitedMs: number): string {
  return `${agentName(agent)}: the usage limit has lifted after ${durationText(waitedMs)}; continuing`;
}
/**
 * The page's activity line during a wait for a usage limit (issue #68): what is waited for and until when, by what the
 * wait rests on (issue #170).
 */
export function usageLimitActivity(limitType: string | null, basis: LimitWaitBasis, untilMs: number): string {
  switch (basis.kind) {
    case "reset":
      return `${limitName(limitType)} reached — waiting until ${utcMinute(untilMs)}`;
    case "pastReset":
      return `${limitName(limitType)} reached — its stated reset ${utcMinute(basis.namedMs)} has passed; trying again at ${utcMinute(untilMs)}`;
    case "noKnownEnd":
      return `${limitName(limitType)} reached, no stated end — try ${basis.attempt} at ${utcMinute(untilMs)}, every ${RETRY_INTERVAL_TEXT}`;
  }
}
/** The time remaining of a wait whose end is known, beside its indicator on the page: a usage limit's (issue #68), a retry's (issue #63). */
export function remainingTime(remainingMs: number): string {
  return `${durationText(remainingMs)} left`;
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
  return `${agentName(agent)} could not be reached for ${what}; the attempts and the last error are shown under "${attachedHeading("fault")}". Do you want Interloq to retry again, or to stop the run?`;
}
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
  return fault_;
}
export function transportDecisionLine(answer: "retry" | "stop", agent: "claude" | "codex", what: string): string {
  return `**User decision:** ${answer === "retry" ? "retry again" : "stop the run"} after ${agentName(agent)} could not be reached for ${what}.\n\n`;
}
/** The halt of AgentUnreachable. */
/**
 * The halt of a Claude Code request refused because its session's history no longer fits what Claude Code accepts
 * (issue #122): the cause named, with Claude Code's own words.
 */
/**
 * The warning of a Claude Code request whose cost, the growth of its session's running total, is more than the amount
 * set (issue #122). It is said and written to conversation.md; it asks nothing.
 */
export function costWarningLine(session: string | null, costUsd: number, thresholdUsd: number): string {
  const which = session === null ? "a Claude Code request without a session id" : `one Claude Code request in session ${session}`;
  return `Warning: ${which} cost $${costUsd.toFixed(2)}, more than the $${thresholdUsd.toFixed(2)} set by costWarningUsd. Each request re-sends its session's history, and Claude Code refuses a session that has grown too long.`;
}

/**
 * Issue #162: the halt of an implementation run whose listed commands name npm scripts the project's package.json
 * lacks, or whose project has no package.json; the run did not start.
 */
export function checkCommandInvalidText(problems: readonly ManifestProblem[]): string {
  const lines = problems.map((problem) =>
    problem._tag === "MissingScript"
      ? `the command "${problem.command}" names the script "${problem.script}", which the project's package.json does not have`
      : `the command "${problem.command}" runs an npm script, and the project has no package.json at its top level`,
  );
  return `the commands of checkCommands and suiteCommand in the configuration (behavior 9) do not match the project: ${lines.join("; ")}. The run did not start; correct the configuration or the scripts and start it again`;
}

export function sessionTooLongText(message: string): string {
  return `Claude Code refused the request because its session's history was too long for Claude Code to accept (${message})`;
}

/**
 * Issue #158 (the user's decision Q1): the halt of every run in progress after an error the server could not trace
 * to one run, its record in conversation.md, the refusal of a start while the server ends, and the server's line
 * naming the runs whose halt it could not confirm in their records.
 */
export function serverFaultText(message: string): string {
  return `the server met an error it could not trace to one run (${message}). Every run in progress was halted and the server is ending; start it again with bin/ilcli web.`;
}
export function serverFaultRecord(message: string): string {
  return `**Halted: the server met an error it could not trace to one run (${message}), halted every run in progress and ended.**\n`;
}
export const serverEndingText = "the server is ending after an error it could not trace to one run; start it again with bin/ilcli web";
export function unrecordedHaltLine(ids: readonly number[]): string {
  return `Interloq: the halt of run${ids.length === 1 ? "" : "s"} ${ids.join(", ")} could not be confirmed in ${ids.length === 1 ? "its records" : "their records"}; each was published to the page as ended with code 1.`;
}

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
/**
 * The SDK's timeout of the two hooks that wait for an execution call's background commands (issue #154), in seconds.
 * It is not a limit on how long a command may run: when the adapter's own bound of one wait, a little shorter, passes,
 * the hook answers that the command still runs and the next end of the turn waits again. Whether the bundled CLI
 * honors a hook timeout this long is unproven until the developer runs prototypes/proto-background.ts.
 */
export const BACKGROUND_HOOK_TIMEOUT_SECONDS = 600;
/** The adapter's bound of one wait for background commands (issue #154), shorter than the hooks' timeout. */
export const BACKGROUND_WAIT_BOUND_MS = (BACKGROUND_HOOK_TIMEOUT_SECONDS - 30) * 1000;
const commandList = (names: readonly string[]): string => names.join("; ");
/** What Claude Code is told when one wait's bound passes with a background command still running (issue #154). */
export function stillRunningText(names: readonly string[]): string {
  return `A command or watch you started is still running: ${commandList(names)}. You may ${READ_AND_SEARCH_ONLY}. When nothing is left to do but wait, end your turn again: ${KEEPS_SESSION_OPEN}.`;
}
/** The question of an execution call that the SDK ended while a background command was still running (issue #154). */
export function backgroundKilledText(names: readonly string[]): string {
  return `The execution call ended while a command or watch Claude Code had started was still running, so its result is lost: ${commandList(names)}.`;
}
/** The line said on the page while an execution call waits for its background commands (issue #154). */
export function backgroundWaitLine(names: readonly string[]): string {
  return `Waiting for a command or watch Claude Code started: ${commandList(names)}`;
}
/** The line said on the page when the background commands an execution call waited for have ended (issue #154). */
export function backgroundEndedLine(ends: readonly NamedEnd[]): string {
  return `The command or watch ended: ${ends.map(({ end, name }) => `${name} ${end.status}`).join("; ")}`;
}
/** The line said on the page when one wait's bound passes and the command still runs (issue #154). */
export function backgroundStillRunningLine(names: readonly string[]): string {
  return `A command or watch Claude Code started is still running: ${commandList(names)}; Interloq goes on waiting.`;
}
/** The reason given to Claude Code when the wait for its background commands ends (issue #154, decision Q1). */
export function backgroundEndedText(ends: readonly NamedEnd[]): string {
  const lines = ends.map(({ end, name }) => `- ${name}: ${end.status}; its output is in ${end.outputFile}; ${end.summary.trim() === "" ? "no summary" : `summary: ${end.summary}`}`);
  return `The command or watch you started has ended:\n${lines.join("\n")}\nRead the output file, then continue the step and call the tool ${REPORT_STEP_TOOL_NAME} and return the status report as before.`;
}
/** The denial of a status report returned while a background command Claude Code started is still running (issue #154). */
export const REPORT_WHILE_RUNNING_DENIED = `Interloq did not accept your status report: ${NO_REPORT_WHILE_RUNNING}, since its result would be lost.`;
/**
 * The prompt that continues an execution phase's session after a report with status continuing (issue #154, decision
 * Q2): the work left, as Claude Code reported it, and the instruction to go on with it without asking the user.
 */
export function executionContinuingPrompt(remainingWork: string): string {
  return `Your status report said that work remains and that there is nothing for the user to decide. Interloq asked the user nothing: continue with the remaining steps of the plan in this session. The remaining work, as you reported it: ${remainingWork.trim() === "" ? "not reported" : remainingWork}
Call the tool ${REPORT_STEP_TOOL_NAME} as before when a step begins and when it is done. ${resumeStepSentence} Return the status report at the end.`;
}
/** The line said on the page and written to conversation.md when an execution call ends with status continuing (issue #154). */
export function continuingLine(label: string, remainingWork: string): string {
  return `${label} ended a turn with work remaining and nothing for you to decide; Interloq told Claude Code to continue. Remaining work: ${remainingWork.trim() === "" ? "not reported" : remainingWork}`;
}
export const executionContinuePrompt = `This execution phase was interrupted: the connection to the model dropped, the Claude Code process ended, or a usage limit was waited out. The work done so far is in the project, and the steps you reported so far are recorded. Continue from where you were: call the tool ${REPORT_STEP_TOOL_NAME} as before when a step begins and when it is done, and return the status report at the end.`;

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
    case "tracker":
      return `Asked because the ${origin.tracker} issue tracker could not be reached`;
    case "suiteStopped":
      return "Asked because the whole suite was stopped before it finished";
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

/**
 * The question of a disputed pause whose disagreement Claude Code marked as about what the task requires (issue #156),
 * its interrogative sentence last; its options are Codex's position and Claude Code's, as in every disputed pause.
 */
export const TASK_DISPUTE_QUESTION =
  "Codex and Claude Code read the task differently on this point: the first option is Codex's reading and the second is Claude Code's. Which reading of the task do you want the work to follow, Codex's or Claude Code's?";
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
/** The heading of a question's context on the page (issue #137), the name issue #133 gives the same field on the decision page. */
export const CONTEXT_HEADING = "Technical Context";
/** The heading of a question's attached material, named by what it holds (issue #137, Q1): the one source of each heading. */
export function attachedHeading(kind: AttachedKind): string {
  switch (kind) {
    case "reason":
      return "Why You're Being Asked This";
    case "summary":
      return "The Summary to Confirm";
    case "request":
      return "What Claude Code Would Do";
    case "reviewFacts":
      return "What Happened in the Review";
    case "fault":
      return "Why the Agent Could Not Be Reached";
    case "suiteStop":
      return "Why the Suite Was Stopped";
  }
}
/** An agreed question's default, as its option's description marks it (S18). */
export function defaultMarked(description: string): string {
  return description.trim() === "" ? "(the default)" : `${description} (the default)`;
}
/** The question of a clarification turn that asks no particular question: its context is Claude Code's message. */
export const REPLY_QUESTION = "What do you want to reply to Claude Code?";
/** The question of the summary's confirmation. */
export const CONFIRM_SUMMARY_QUESTION = "Claude Code has written this summary of the requirements from the clarification. Do you confirm that it states the requirements correctly?";

// ---- an execution call whose Claude Code process ended, its retries used up (issue #157) ----------------------------

/** A step as the texts of a process ending name it. */
export type NamedStep = Readonly<{ id: string; label: string }>;
/** How the process ended, in words. */
export function processEndText(end: ProcessEnd): string {
  switch (end.kind) {
    case "signal":
      return `killed by signal ${end.signal}`;
    case "exit":
      return `exited with code ${end.code}`;
  }
}
/** The outcome's question: what ended the call, true whatever ended the attempts before the last. */
export function processEndedQuestion(end: ProcessEnd, attempts: number): string {
  return `The Claude Code process ${processEndText(end)} on the last of ${attempts} attempts, before it wrote a status report.`;
}
/** A step on one line: its id and its label, the label's line breaks and runs of whitespace one space. */
const stepOnOneLine = (step: NamedStep): string => `${step.id} (${step.label.replace(/\s+/g, " ").trim()})`;
const STEPS_DONE = "Steps recorded as done:";
const STEPS_UNFINISHED = "Steps left unfinished:";
const NO_STEP_DONE = "No step was recorded as done.";
const NO_STEP_UNFINISHED = "No step was left unfinished.";
/** The outcome's summary: the steps recorded as done. */
export function processEndedSummary(done: readonly NamedStep[]): string {
  return done.length === 0 ? NO_STEP_DONE : `${STEPS_DONE} ${done.map(stepOnOneLine).join(", ")}.`;
}
/** The outcome's remaining work: the steps left unfinished. */
export function processEndedRemaining(unfinished: readonly NamedStep[]): string {
  return unfinished.length === 0 ? NO_STEP_UNFINISHED : `${STEPS_UNFINISHED} ${unfinished.map(stepOnOneLine).join(", ")}.`;
}

/** The opening sentence of the program's own context paragraphs: what Interloq and the two agents are. */
const INTERLOQ_SENTENCE =
  "Interloq, the orchestrator that runs this task, starts two AI agents in this project and passes their work between them: Claude Code, the planning and coding agent, writes the plan and carries it out, and Codex, the reviewing agent, checks each document and the finished work.";
/**
 * The program's context of a disputed pause whose disagreement Claude Code marked as about what the task requires
 * (issue #156): it states that the disagreement is a reading of the task, not the wording of a question.
 */
export function taskDisputeContext(heading: string): string {
  return `${INTERLOQ_SENTENCE} During ${heading}, Codex reviews the questions, or the explanations of their terms, that Interloq will put to you, and Claude Code answers each point. On this point the two agents read the task differently, and Claude Code marked the disagreement as one about what the task requires rather than about how a question is worded. Interloq asks you which reading the work should follow, because what the task requires is yours to decide and you can settle it in a line.`;
}
/**
 * The facts a context call is given for a disputed pause whose disagreement Claude Code marked (issue #156, W1-R1-1):
 * what its context paragraph must state.
 */
export const TASK_DISPUTE_CONTEXT_FACTS =
  "Claude Code marked this disagreement as one about what the task requires, not about how a question to the user is worded. Your context paragraph must say so, and must say that the question asks which reading of the task the work should follow: Codex's, the first option, or Claude Code's, the second.";
/**
 * The fixed context paragraph of a question the program composes (S7, S10): the components, what they do, where they
 * are, when they act and why, filled in with the facts of the case; shown as written by the program.
 */
export function fallbackContext(origin: QuestionOrigin): string {
  const interloq = INTERLOQ_SENTENCE;
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
    case "tracker":
      return `Interloq reads and updates this run's item in the project's issue tracker, ${origin.tracker}, at the start and at the end of a run. The request failed while ${origin.what} after ${origin.attempts} attempts, with waits between them; the last error is shown below. Interloq now asks you whether to try again or stop the run; the run's records are kept either way. A repeated request reaches the same result as one that succeeded, because every request sets the full intended state of the item.`;
    case "suiteStopped":
      return `${INTERLOQ_SENTENCE} Before an implementation run can finish, Interloq runs the project's whole suite, ${origin.command}, itself. Suite run ${origin.suite} was stopped before it finished: ${origin.reason}. A stop by the suite's time limit, or a shell that could not start, is not a fault of the work, so the plan is not revised from it. Interloq runs the suite again once in a run without asking, and that repeat has been used, so it now asks you whether to run the suite again or stop the run; the run's records are kept either way.`;
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
/** The paragraph of a pause's facts whose disagreement Claude Code marked (issue #156), after the lead. */
export const TASK_DISPUTE_FACT =
  "Claude Code marked this disagreement as one about what the task requires, not about how a question is worded: Codex's point and Claude Code's answer are two readings of the task.";
/** Appended to an entry of an issue's history that Claude Code marked (issue #156). */
export const TASK_DISPUTE_ENTRY_MARK = "Claude Code marked this as a disagreement about what the task requires.";
/**
 * The heading of a question's history (issue #133, decision Q1): in conversation.md, and on the question page and the
 * decision page, where it heads a collapsed section of its own. Not HISTORY_HEADING, which heads an issue's history in a
 * pause's facts.
 */
export const QUESTION_HISTORY_HEADING = "History";
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
  /**
   * The program's own context of the question, shown, marked as the program's, where the context call cannot succeed
   * (issue #156, W1-R1-1); not given to the call.
   */
  fallback: readonly Block[];
  /**
   * The draft's own history, what led to the question, empty when none (issue #181, plan review issue P2-R1-1): given to
   * the call in its JSON to keep, rephrased, and shown unchanged where the call cannot succeed.
   */
  history: readonly Block[];
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
export const CONTEXT_REQUEST_HEADING = "The question as Interloq wrote it, as data (question, options, details, history, explanations):";
export function contextPrompt(task: string, request: ContextRequest): string {
  const facts = request.facts.trim() === "" ? "" : `Facts for your understanding, not shown to the user:\n${request.facts}\n`;
  const question = JSON.stringify({ question: request.question, options: request.options, details: request.details, history: request.history, explanations: request.explanations });
  return `Interloq, the program that runs this task, is about to ask the user the question below. Write the context paragraph that the user reads before it, and return the whole question as pieces, with the explanations of the words a reader may not know. You may read the project to understand it; do not modify any file, do not use the AskUserQuestion tool, and do not answer the question.
${questionWritingRules()}
${QUESTION_TEXT_FORMAT}
Return in context your paragraph, which places the reader before he is asked. Return in history what happened before that led to the question, apart from the context, as the rules describe it: keep what the history given below says, rephrased if you wish, and add only what led to the question that it lacks; the history may be empty, and is an empty list only where the history given is empty and nothing led to the question. Return in question, options and details the question, its options and what the user is shown with it: you may rephrase their prose and divide it into pieces that refer to explanations, but keep what they say. ${KEEP_OPTIONS} ${KEEP_LITERALS}${suppliesRefs(request) ? ` ${KEEP_SUPPLIED_REFS}` : ""} Return in explanations every explanation that a piece of your reply refers to.

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
export function relayedFacts(root: RunRoot, plan: string | null): string {
  return `Claude Code asked this question while it carried out the plan, and waits for the answer; the plan is revised and reviewed with the answer before the work continues.\n${plan === null ? `${runDir(root)}/plan.md does not exist.` : `The plan being carried out (${runDir(root)}/plan.md):\n${plan}`}`;
}

/**
 * The block a review loop writes to conversation.md when Codex's review has no counted issue, and only then: the one
 * record that a loop ended with the agents' agreement, which src/earlierPlan.ts reads in an earlier run's records (issue #180).
 */
export const reviewConvergedMarkdown = (heading: string, round: number, fileLabel: string): string =>
  `## ${heading}, round ${round}\n\n### Codex\n\nNo counted issue. The review of ${fileLabel} has converged.\n\n`;
/** The plan subject's reviewed file as its loop names it (`fileLabel`), shared with src/earlierPlan.ts (issue #180). */
export const PLAN_FILE_LABEL = "plan.json";

/**
 * The revision of a plan taken from an earlier implementation run of the item (issue #180, Q2 and Q5): before Codex
 * reviews it, Claude Code revises the steps not done for the project and the requirements as they stand at this run's
 * start, in a session of its own.
 */
export function earlierPlanPrompt(root: RunRoot, task: string, withRequirements: boolean, earlier: RunRoot, checks: StepChecks): string {
  const requirements = withRequirements ? ` This run's requirements are the item's as they stand now, and may differ from those the plan was written for.` : "";
  return planRevisionPrompt(
    root,
    task,
    withRequirements,
    `Interloq took this run's plan from an earlier implementation run of the same item, whose records are in ${RECORDS_DIR}/${earlier}/, and wrote it to ${runDir(root)}/plan.json. The steps that run recorded as done are kept done, and those it left running are marked unfinished.
The project may have changed since the plan was written: that run's own changes may be in the working tree, committed or not, and other commits may have followed.${requirements}
This request runs in a Claude Code session of its own, which has not seen the earlier run: read the files named here.`,
    `Revise the plan in ${runDir(root)}/plan.json: keep the steps with status 'done', and change, add, or remove the other steps as the current state of the codebase and the requirements require.`,
    checks,
  );
}
/** Said and written where the run took an earlier run's plan (issue #180). */
export const earlierPlanTakenLine = (earlier: RunRoot): string =>
  `This run starts from the plan of the earlier implementation run in ${RECORDS_DIR}/${earlier}, whose plan review ended with Codex raising no further issue. Claude Code revises it for the project and the requirements as they are now, and Codex reviews the revision.`;
/** Said and written where the earlier run's record of the project at its start is gone (issue #180, F1). */
export const earlierPlanSetAsideLine = (earlier: RunRoot): string =>
  `The plan of the earlier implementation run in ${RECORDS_DIR}/${earlier} is set aside: that run's record of the project at its start is gone, so this run plans the item from nothing, and the earlier run's changes count as already there when this run began.`;

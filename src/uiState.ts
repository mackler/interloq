// The state of the page that the tabs of one run share (issue #87, decision G-R1-1 of its task; issue #63): which of a
// decision's entries are open, and which nodes of the progress rail the user opened or closed. Pure, and free of Node
// imports, so that the browser imports it as it imports src/protocol.ts. It is not part of the run's records: the server
// holds it beside the run's events, for as long as the server's incarnation, and it changes nothing the run produces.

/**
 * What one flag of the shared state is about: a decision's entry, keyed by the decision's number and the entry's id
 * (issue #87); a phase of the progress rail, keyed by the phase's band key (`execution-2`); or a branch inside a phase,
 * `step:<kind>` for a step of Gather Requirements and `stage:<key>` for a stage of the plan (issue #63).
 */
export type UiScope =
  | Readonly<{ _tag: "DecisionEntry"; decision: number; entry: string }>
  | Readonly<{ _tag: "RailPhase"; phase: string }>
  | Readonly<{ _tag: "RailBranch"; phase: string; branch: string }>;
/** A change the page asks for: open or close one scope. */
export type UiFlag = Readonly<{ scope: UiScope; open: boolean }>;
/**
 * A run's shared state: every scope the user has touched, once, with the value he chose, and a version the server raises
 * on each change. A scope absent from `choices` is untouched (issue #63): the three states of the domain.
 */
export type RunUiState = Readonly<{ version: number; choices: readonly UiFlag[] }>;
/** What the user chose for a scope: opened, closed, or nothing yet. */
export type Choice = "open" | "closed" | "untouched";

export const emptyUiState: RunUiState = { version: 0, choices: [] };

/** A total, injective encoding of a scope (every string is JSON-quoted, so no separator can occur in it unescaped). */
export const scopeKey = (scope: UiScope): string => {
  switch (scope._tag) {
    case "DecisionEntry":
      return `${scope._tag}:${scope.decision}:${JSON.stringify(scope.entry)}`;
    case "RailPhase":
      return `${scope._tag}:${JSON.stringify(scope.phase)}`;
    case "RailBranch":
      return `${scope._tag}:${JSON.stringify(scope.phase)}:${JSON.stringify(scope.branch)}`;
  }
};
/** The state after a flag: the version raised, the scope's choice replaced; each scope is held once. */
export const withFlag = (state: RunUiState, flag: UiFlag): RunUiState => {
  const key = scopeKey(flag.scope);
  return { version: state.version + 1, choices: [...state.choices.filter((c) => scopeKey(c.scope) !== key), flag] };
};
/** What the user chose for the scope. */
export const choiceOf = (state: RunUiState, scope: UiScope): Choice => {
  const key = scopeKey(scope);
  const chosen = state.choices.find((c) => scopeKey(c.scope) === key);
  return chosen === undefined ? "untouched" : chosen.open ? "open" : "closed";
};
/** Whether the user opened the scope: a decision's entry is closed unless explicitly opened (issue #87). */
export const isOpen = (state: RunUiState, scope: UiScope): boolean => choiceOf(state, scope) === "open";
/** Of two states of one run, the one with the higher version (the first when equal). */
export const newer = (a: RunUiState, b: RunUiState): RunUiState => (b.version > a.version ? b : a);

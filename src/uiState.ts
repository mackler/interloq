// The state of the page that the tabs of one run share (issue #87, decision G-R1-1 of its task): which of a decision's
// entries are open. Pure, and free of Node imports, so that the browser imports it as it imports src/protocol.ts.
// It is not part of the run's records: the server holds it beside the run's events, for as long as the server's
// incarnation, and it changes nothing the run produces. Issue #63 adds a variant of UiScope for the progress rail.

/** What one flag of the shared state is about: a decision's entry, keyed by the decision's number and the entry's id. */
export type UiScope = Readonly<{ _tag: "DecisionEntry"; decision: number; entry: string }>;
/** A change the page asks for: open or close one scope. */
export type UiFlag = Readonly<{ scope: UiScope; open: boolean }>;
/** A run's shared state: the scopes that are open, in no particular order, and a version the server raises on each change. */
export type RunUiState = Readonly<{ version: number; open: readonly UiScope[] }>;

export const emptyUiState: RunUiState = { version: 0, open: [] };

/** A total, injective encoding of a scope (the entry id is JSON-quoted, so no separator can occur in it unescaped). */
export const scopeKey = (scope: UiScope): string => `${scope._tag}:${scope.decision}:${JSON.stringify(scope.entry)}`;
/** The state after a flag: the version raised, the scope added or removed; opening an open scope keeps it once. */
export const withFlag = (state: RunUiState, flag: UiFlag): RunUiState => {
  const key = scopeKey(flag.scope);
  const others = state.open.filter((s) => scopeKey(s) !== key);
  return { version: state.version + 1, open: flag.open ? [...others, flag.scope] : others };
};
/** Whether the scope is open in the state. */
export const isOpen = (state: RunUiState, scope: UiScope): boolean => {
  const key = scopeKey(scope);
  return state.open.some((s) => scopeKey(s) === key);
};
/** Of two states of one run, the one with the higher version (the first when equal). */
export const newer = (a: RunUiState, b: RunUiState): RunUiState => (b.version > a.version ? b : a);

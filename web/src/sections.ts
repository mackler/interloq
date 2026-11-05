/**
 * Which sections of the question page are open (issue #137; issue #166, requirements Q1): per tab, keyed by what the
 * developer is looking at (QuestionPane's viewIdentity). A question first shown opens Technical Context alone; the
 * developer may close it, and the choice holds while the same question is shown.
 */
export type PaneSection = "context" | "history" | "attached";
export type OpenSections = Readonly<{ key: string | null; open: readonly PaneSection[] }>;
/** The sections open for a question first shown. */
export const DEFAULT_OPEN: readonly PaneSection[] = ["context"];
/** The sections open for `key`: the state's where it is that key's, else the default. */
export const openOf = (state: OpenSections, key: string | null): readonly PaneSection[] => (state.key === key ? state.open : DEFAULT_OPEN);
/** The state after the developer opens or closes `section` of the question `key`, starting from what that question shows. */
export const withSection = (state: OpenSections, key: string | null, section: PaneSection, open: boolean): OpenSections => {
  const others = openOf(state, key).filter((s) => s !== section);
  return { key, open: open ? [...others, section] : others };
};

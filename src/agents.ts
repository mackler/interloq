// The agents that collaborate in a run, stated once (pure, no imports, also imported by the browser; issue #251). Every
// presentation of an agent derives from this table: the program's texts take `name`, the page `short` (issue #5). Adding
// an agent means an entry of AGENTS and AGENT_DISPLAY and its adapter's mapping of its refusals into a LimitRefusal of
// src/limitReset.ts; the limit's wait, its records and the page name no agent.

export const AGENTS = ["claude", "codex"] as const;
export type Agent = (typeof AGENTS)[number];
export const AGENT_DISPLAY: Readonly<Record<Agent, Readonly<{ name: string; short: string }>>> = {
  claude: { name: "Claude Code", short: "Claude" },
  codex: { name: "Codex", short: "Codex" },
};

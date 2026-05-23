import type { AgentRunState } from "../run.js";

export function filterFocusedRuns(
  runs: AgentRunState[],
  focusAgent: string | null,
): AgentRunState[] {
  if (!focusAgent) return runs;
  return runs.filter((run) => run.agentName === focusAgent);
}

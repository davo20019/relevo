import { describe, expect, it } from "vitest";
import type { AgentRunState } from "../src/run.js";
import { filterFocusedRuns } from "../src/ui/focus.js";

function run(agentName: string): AgentRunState {
  return { agentName } as AgentRunState;
}

describe("filterFocusedRuns", () => {
  it("returns all active runs when no agent is focused", () => {
    const runs = [run("claude"), run("codex")];
    expect(filterFocusedRuns(runs, null)).toBe(runs);
  });

  it("returns only runs for the focused agent", () => {
    const runs = [run("claude"), run("codex"), run("claude")];
    expect(filterFocusedRuns(runs, "claude")).toEqual([runs[0], runs[2]]);
  });
});

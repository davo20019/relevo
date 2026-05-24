import { describe, expect, it } from "vitest";
import {
  bottomStatusJustifyContent,
  formatAgentStatus,
  formatToolbarRightRows,
} from "../src/ui/BottomToolbar.js";

describe("formatAgentStatus", () => {
  it("shows ready and off counts when idle", () => {
    expect(formatAgentStatus(4, 2, 0)).toBe("agents: 4 ready · 2 off");
  });

  it("omits off when every configured agent is ready", () => {
    expect(formatAgentStatus(4, 0, 0)).toBe("agents: 4 ready");
  });

  it("shows running, idle, and off while dispatching", () => {
    expect(formatAgentStatus(4, 2, 1)).toBe("agents: 1 running · 3 idle · 2 off");
  });

  it("can include the default agent in the toolbar state type", () => {
    const state = {
      lastAgent: null,
      lastStatus: null,
      lastElapsed: 0,
      verbose: false,
      defaultAgent: "claude",
      readyCount: 2,
      offCount: 0,
      runningCount: 0,
    };
    expect(state.defaultAgent).toBe("claude");
  });

  it("omits idle when every ready agent is running", () => {
    expect(formatAgentStatus(3, 1, 3)).toBe("agents: 3 running · 1 off");
  });

  it("collapses agent chips and meta onto a single toolbar row", () => {
    expect(
      formatToolbarRightRows({
        metaParts: ["verbose"],
        agentStatusText: "@codex 4s · @claude",
        aggregateText: "agents: 2 ready",
      }),
    ).toEqual(["@codex 4s · @claude  ·  verbose"]);
  });

  it("falls back to aggregate text when there are no chips", () => {
    expect(
      formatToolbarRightRows({
        metaParts: [],
        agentStatusText: null,
        aggregateText: "agents: 2 ready",
      }),
    ).toEqual(["agents: 2 ready"]);
  });

  it("right-aligns the toolbar status row", () => {
    expect(bottomStatusJustifyContent()).toBe("flex-end");
  });
});

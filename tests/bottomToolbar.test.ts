import { describe, expect, it } from "vitest";
import { formatAgentStatus } from "../src/ui/BottomToolbar.js";

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

  it("can include focus in the toolbar state type", () => {
    const state = {
      lastAgent: null,
      lastStatus: null,
      lastElapsed: 0,
      verbose: false,
      focusAgent: "claude",
      readyCount: 2,
      offCount: 0,
      runningCount: 0,
    };
    expect(state.focusAgent).toBe("claude");
  });

  it("omits idle when every ready agent is running", () => {
    expect(formatAgentStatus(3, 1, 3)).toBe("agents: 3 running · 1 off");
  });
});

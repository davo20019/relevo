import { describe, expect, it } from "vitest";
import {
  agentStatusCellParts,
  agentStatusRowFits,
  agentStatusRowText,
  formatAgentStatusCell,
} from "../src/ui/AgentStatusRow.js";

describe("formatAgentStatusCell", () => {
  it("renders an idle agent as just the @name", () => {
    expect(formatAgentStatusCell({ agent: "codex", running: false })).toBe("@codex");
  });
  it("renders a running agent with floor-seconds elapsed", () => {
    expect(formatAgentStatusCell({ agent: "cursor", running: true, elapsedSeconds: 12.8 })).toBe(
      "@cursor 12s",
    );
  });
  it("omits elapsed when running but no elapsed provided", () => {
    expect(formatAgentStatusCell({ agent: "claude", running: true })).toBe("@claude");
  });
});

describe("agentStatusCellParts", () => {
  it("returns the @label, elapsed string, and running flag", () => {
    expect(agentStatusCellParts({ agent: "codex", running: true, elapsedSeconds: 9.9 })).toEqual({
      label: "@codex",
      elapsed: "9s",
      running: true,
    });
  });
});

describe("agentStatusRowText", () => {
  it("joins cells with a middle-dot separator", () => {
    expect(
      agentStatusRowText([
        { agent: "a", running: true, elapsedSeconds: 1 },
        { agent: "b", running: false },
      ]),
    ).toBe("@a 1s · @b");
  });
});

describe("agentStatusRowFits", () => {
  it("returns false when cols are too narrow", () => {
    expect(agentStatusRowFits([{ agent: "codex", running: false }], 5, 0)).toBe(false);
  });
  it("returns true when cols cover text plus reserved margin", () => {
    expect(agentStatusRowFits([{ agent: "codex", running: false }], 20, 4)).toBe(true);
  });
});

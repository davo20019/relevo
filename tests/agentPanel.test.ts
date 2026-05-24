import { describe, expect, it } from "vitest";
import { formatWaitingStatus } from "../src/ui/AgentPanel.js";

describe("formatWaitingStatus", () => {
  it("uses a short dot animation", () => {
    expect(formatWaitingStatus(0)).toBe("·");
    expect(formatWaitingStatus(0.4)).toBe("··");
    expect(formatWaitingStatus(0.8)).toBe("···");
  });
});

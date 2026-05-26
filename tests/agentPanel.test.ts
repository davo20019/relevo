import { describe, expect, it } from "vitest";
import { formatQuietStatus, formatWaitingStatus } from "../src/ui/AgentPanel.js";

describe("formatWaitingStatus", () => {
  it("uses a short dot animation", () => {
    expect(formatWaitingStatus(0)).toBe("·");
    expect(formatWaitingStatus(0.4)).toBe("··");
    expect(formatWaitingStatus(0.8)).toBe("···");
  });
});

describe("formatQuietStatus", () => {
  it("labels quiet running agents as silent", () => {
    expect(formatQuietStatus(121)).toBe(" · silent 121s");
  });
});

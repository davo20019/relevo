import { describe, expect, it } from "vitest";
import { formatWaitingStatus } from "../src/ui/AgentPanel.js";

describe("formatWaitingStatus", () => {
  it("starts with a more active thinking phrase", () => {
    expect(formatWaitingStatus(0)).toBe("thinking   ");
    expect(formatWaitingStatus(1)).toBe("thinking...");
  });

  it("rotates phrases more slowly than dot frames", () => {
    expect(formatWaitingStatus(0).trimEnd()).toBe("thinking");
    expect(formatWaitingStatus(1).trimEnd()).toBe("thinking...");
    expect(formatWaitingStatus(6).trimEnd()).toBe("working..");
  });
});

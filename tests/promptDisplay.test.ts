import { describe, expect, it } from "vitest";
import {
  buildCompactDisplayPrompt,
  displayPromptFromDispatch,
} from "../src/ui/promptDisplay.js";

const agents = ["claude", "codex"];

describe("buildCompactDisplayPrompt", () => {
  it("keeps paste placeholders in the display string", () => {
    const compact = "@claude fix [Pasted #1, 12 lines] please";
    expect(buildCompactDisplayPrompt(compact, agents, null)).toBe(compact);
  });

  it("keeps image placeholders in the display string", () => {
    const compact = "@claude review [Image #1, shot.png]";
    expect(buildCompactDisplayPrompt(compact, agents, null)).toBe(compact);
  });

  it("expands @all to agent tags without prompt body", () => {
    expect(buildCompactDisplayPrompt("@all", agents, null)).toBe("@claude @codex");
  });
});

describe("displayPromptFromDispatch", () => {
  it("uses merged pending body when the buffer was only an agent tag", () => {
    const compact = "@claude";
    const routed = "@claude [Pasted #1, 3 lines]";
    expect(displayPromptFromDispatch(compact, routed, agents, null)).toBe(routed);
  });
});

import { describe, expect, it } from "vitest";
import { buildSkippedBlock, skippedToText } from "../src/ui/skipped.js";

const text = (skipped: string[], reasons: Record<string, string | undefined>) =>
  skippedToText(buildSkippedBlock(skipped, reasons));

describe("buildSkippedBlock / skippedToText", () => {
  it("returns no lines when nothing skipped", () => {
    expect(buildSkippedBlock([], {})).toEqual([]);
    expect(text([], {})).toBe("");
  });

  it("collapses single-reason 'disabled' to one line plus enable hint", () => {
    expect(text(["cursor", "opencode", "pi"], {
      cursor: "disabled",
      opencode: "disabled",
      pi: "disabled",
    })).toBe(
      "@all → skipped (disabled): @cursor @opencode @pi\n  enable with /agents enable <name>",
    );
  });

  it("collapses single non-disabled reason to one line without hint", () => {
    expect(text(["cursor"], { cursor: "no command" })).toBe(
      "@all → skipped (no command): @cursor",
    );
  });

  it("groups mixed reasons by reason with aligned columns + hint when any disabled", () => {
    expect(
      text(["cursor", "opencode", "pi"], {
        cursor: "disabled",
        opencode: "disabled",
        pi: "missing command: pi",
      }),
    ).toBe(
      [
        "@all → skipping 3 agents",
        "  disabled             @cursor @opencode",
        "  missing command: pi  @pi",
        "  enable disabled agents with /agents enable <name>",
      ].join("\n"),
    );
  });

  it("omits hint when no skipped agent is 'disabled'", () => {
    expect(
      text(["a", "b"], {
        a: "no command",
        b: "missing command: foo",
      }),
    ).toBe(
      [
        "@all → skipping 2 agents",
        "  no command            @a",
        "  missing command: foo  @b",
      ].join("\n"),
    );
  });

  it("preserves the input order of agents inside each reason group", () => {
    expect(
      text(["z", "a", "m"], { z: "disabled", a: "disabled", m: "disabled" }),
    ).toBe("@all → skipped (disabled): @z @a @m\n  enable with /agents enable <name>");
  });

  it("emits agent segments tagged with the agent name (for per-agent coloring)", () => {
    const lines = buildSkippedBlock(["cursor", "opencode"], {
      cursor: "disabled",
      opencode: "disabled",
    });
    const flat = lines.flat();
    const agentSegs = flat.filter((s) => s.kind === "agent");
    expect(agentSegs.map((s) => (s as { agent: string }).agent)).toEqual([
      "cursor",
      "opencode",
    ]);
  });

  it("marks the trailing enable hint as 'hint' kind for dim rendering", () => {
    const lines = buildSkippedBlock(["x"], { x: "disabled" });
    const last = lines[lines.length - 1]!;
    expect(last.every((s) => s.kind === "hint")).toBe(true);
  });
});

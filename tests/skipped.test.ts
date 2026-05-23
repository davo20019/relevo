import { describe, expect, it } from "vitest";
import { buildSkippedBlock, skippedToText } from "../src/ui/skipped.js";

const text = (skipped: string[], reasons: Record<string, string | undefined>) =>
  skippedToText(buildSkippedBlock(skipped, reasons));

describe("buildSkippedBlock / skippedToText", () => {
  it("returns no lines when nothing skipped", () => {
    expect(buildSkippedBlock([], {})).toEqual([]);
    expect(text([], {})).toBe("");
  });

  it("collapses single-reason 'disabled' to one line with inline enable hint", () => {
    expect(
      text(["cursor", "opencode", "pi"], {
        cursor: "disabled",
        opencode: "disabled",
        pi: "disabled",
      }),
    ).toBe(
      "@all → 3 skipped (disabled @cursor @opencode @pi) · /agents enable <name>",
    );
  });

  it("collapses single non-disabled reason to one line without hint", () => {
    expect(text(["cursor"], { cursor: "not installed" })).toBe(
      "@all → 1 skipped (not installed @cursor)",
    );
  });

  it("inlines mixed reasons on one line with inline hint when any disabled", () => {
    expect(
      text(["cursor", "opencode", "pi"], {
        cursor: "disabled",
        opencode: "disabled",
        pi: "not installed",
      }),
    ).toBe(
      "@all → 3 skipped (disabled @cursor @opencode, not installed @pi) · /agents enable <name>",
    );
  });

  it("omits hint when no skipped agent is 'disabled'", () => {
    expect(
      text(["a", "b"], {
        a: "no command",
        b: "not installed",
      }),
    ).toBe("@all → 2 skipped (no command @a, not installed @b)");
  });

  it("preserves the input order of agents inside each reason group", () => {
    expect(
      text(["z", "a", "m"], { z: "disabled", a: "disabled", m: "disabled" }),
    ).toBe(
      "@all → 3 skipped (disabled @z @a @m) · /agents enable <name>",
    );
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

  it("marks the inline enable hint as 'hint' kind for dim rendering", () => {
    const lines = buildSkippedBlock(["x"], { x: "disabled" });
    const onlyRow = lines[0]!;
    const hintSegs = onlyRow.filter((s) => s.kind === "hint");
    expect(hintSegs).toHaveLength(1);
    expect((hintSegs[0] as { text: string }).text).toMatch(/\/agents enable/);
  });
});

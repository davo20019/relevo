import { describe, expect, it } from "vitest";
import { auditabilityReason, auditableAgentNames, tokenMetrics } from "../src/audit.js";
import type { AgentSpec } from "../src/config.js";

const specs: Record<string, AgentSpec> = {
  claude: { cmd: "claude {prompt}", parser: "claude-json", resume_template: "claude --resume {session_id} {prompt}" },
  codex: { cmd: "codex {prompt}", parser: "codex-json", resume_template: "codex resume {session_id} {prompt}" },
  cursor: { cmd: "agent {prompt}", parser: "cursor-json", resume_template: "agent --resume {session_id} {prompt}" },
  opencode: { cmd: "opencode {prompt}" },
  agy: { cmd: "agy {prompt}", parser: "agy-text" },
  disabled: { cmd: "claude {prompt}", parser: "claude-json", resume_template: "claude --resume {session_id}", enabled: false },
  uninstalled: { cmd: "ghost {prompt}", parser: "claude-json", resume_template: "ghost --resume {session_id}" },
};

const fakeWhich = (name: string) => (name === "ghost" ? null : `/usr/bin/${name}`);

describe("tokenMetrics", () => {
  it("fresh = input + cacheCreate, cached = cacheRead", () => {
    expect(tokenMetrics({ input: 100, output: 50, cacheRead: 900, cacheCreate: 0 }))
      .toEqual({ fresh: 100, cached: 900, pct: 0.9 });
  });

  it("counts cacheCreate as fresh (model still processes it cold)", () => {
    expect(tokenMetrics({ input: 0, output: 0, cacheRead: 0, cacheCreate: 500 }))
      .toEqual({ fresh: 500, cached: 0, pct: 0 });
  });

  it("pct is null when both fresh and cached are zero", () => {
    expect(tokenMetrics({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }))
      .toEqual({ fresh: 0, cached: 0, pct: null });
  });
});

describe("auditabilityReason", () => {
  it("returns null for an auditable agent", () => {
    expect(auditabilityReason("claude", specs.claude!, fakeWhich)).toBeNull();
  });
  it("flags disabled", () => {
    expect(auditabilityReason("disabled", specs.disabled!, fakeWhich)).toBe("disabled");
  });
  it("flags not-installed", () => {
    expect(auditabilityReason("uninstalled", specs.uninstalled!, fakeWhich)).toMatch(/not installed/);
  });
  it("flags no structured parser", () => {
    expect(auditabilityReason("opencode", specs.opencode!, fakeWhich)).toMatch(/no structured parser/);
    expect(auditabilityReason("agy", specs.agy!, fakeWhich)).toMatch(/no structured parser/);
  });
  it("flags no resume_template", () => {
    const noResume: AgentSpec = { cmd: "x {prompt}", parser: "claude-json" };
    expect(auditabilityReason("x", noResume, fakeWhich)).toMatch(/no resume_template/);
  });
});

describe("auditableAgentNames", () => {
  it("returns only the three structured CLIs in the default-ish set", () => {
    expect(auditableAgentNames(specs, fakeWhich).sort()).toEqual(["claude", "codex", "cursor"]);
  });
});

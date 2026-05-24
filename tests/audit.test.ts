import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditabilityReason,
  auditableAgentNames,
  tokenMetrics,
  numericVerdict,
  providerQualifier,
  displayVerdictText,
  scanClaudeHooks,
  runScanner,
  SCANNERS,
  renderTextOutput,
  renderJsonOutput,
} from "../src/audit.js";
import type { AgentSpec } from "../src/config.js";
import type { AuditResult, Offender } from "../src/audit.js";

const tempDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "relevo-audit-"));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeHooks(root: string, plugin: string, version: string, body: object): string {
  const dir = path.join(root, "plugins", "cache", "org", plugin, version, "hooks");
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "hooks.json");
  writeFileSync(f, JSON.stringify(body));
  return f;
}

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

describe("numericVerdict", () => {
  it("≥0.95 → excellent", () => {
    expect(numericVerdict(0.95)).toBe("excellent");
    expect(numericVerdict(0.99)).toBe("excellent");
  });
  it("0.80–0.9499 → ok", () => {
    expect(numericVerdict(0.94)).toBe("ok");
    expect(numericVerdict(0.80)).toBe("ok");
  });
  it("<0.80 → investigate", () => {
    expect(numericVerdict(0.79)).toBe("investigate");
    expect(numericVerdict(0)).toBe("investigate");
  });
});

describe("providerQualifier", () => {
  it("codex ≤50% with empty offender list → qualifier", () => {
    expect(providerQualifier("codex", 0.33, [])).toBe("provider-typical for codex");
  });
  it("codex ≤50% with no-scanner sentinel → qualifier (v1 case)", () => {
    expect(providerQualifier("codex", 0.33, "no-scanner")).toBe("provider-typical for codex");
  });
  it("codex ≤50% with offenders found → no qualifier", () => {
    const off: Offender = { name: "x", file: "y", pattern: "z", effect: "e", patch: "p" };
    expect(providerQualifier("codex", 0.33, [off])).toBeNull();
  });
  it("codex >50% → no qualifier", () => {
    expect(providerQualifier("codex", 0.51, "no-scanner")).toBeNull();
  });
  it("claude at 33% → no qualifier (not codex)", () => {
    expect(providerQualifier("claude", 0.33, [])).toBeNull();
  });
});

describe("displayVerdictText", () => {
  it("renders raw tier with pct when no qualifier", () => {
    expect(displayVerdictText("excellent", 0.99, null, 4)).toBe("excellent (99% at turn 4)");
    expect(displayVerdictText("ok", 0.88, null, 4)).toBe("ok (88% at turn 4)");
    expect(displayVerdictText("investigate", 0.44, null, 4)).toBe("investigate (44% at turn 4)");
  });
  it("softens to 'ok (<qualifier> — see Notes)' when qualifier present", () => {
    expect(displayVerdictText("investigate", 0.33, "provider-typical for codex", 4))
      .toBe("ok (provider-typical for codex — see Notes)");
  });
});

describe("scanClaudeHooks", () => {
  it("returns [] when the plugin cache root does not exist", () => {
    const home = tmp();
    expect(scanClaudeHooks(home)).toEqual([]);
  });

  it("detects SessionStart matcher containing 'resume' as a |-token", () => {
    const home = tmp();
    writeHooks(home, "vercel", "0.43.0", {
      hooks: { SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [] }] },
    });
    const found = scanClaudeHooks(home);
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe("vercel@0.43.0");
    expect(found[0]!.pattern).toBe("SessionStart+resume");
  });

  it("does NOT flag matchers where 'resume' is only a substring", () => {
    const home = tmp();
    writeHooks(home, "x", "1.0.0", {
      hooks: { SessionStart: [{ matcher: "startup|resumeOnly|other", hooks: [] }] },
    });
    expect(scanClaudeHooks(home)).toEqual([]);
  });

  it("is case-insensitive on token compare", () => {
    const home = tmp();
    writeHooks(home, "y", "2.0.0", {
      hooks: { SessionStart: [{ matcher: "Resume", hooks: [] }] },
    });
    expect(scanClaudeHooks(home)).toHaveLength(1);
  });

  it("skips malformed JSON without crashing", () => {
    const home = tmp();
    const dir = path.join(home, "plugins", "cache", "org", "bad", "1.0.0", "hooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "hooks.json"), "{not json");
    expect(scanClaudeHooks(home)).toEqual([]);
  });
});

describe("scanner registry", () => {
  it("returns no-scanner for unregistered agents", () => {
    expect(runScanner("codex")).toBe("no-scanner");
    expect(runScanner("cursor")).toBe("no-scanner");
    expect(runScanner("opencode")).toBe("no-scanner");
  });
  it("has claude registered", () => {
    expect(typeof SCANNERS.claude).toBe("function");
  });
});

const SAMPLE: AuditResult = {
  prompt: "Reply with exactly the word OK. No other text.",
  turns: 4,
  agents: {
    claude: {
      turns: [
        { fresh: 14212, cached: 0, pct: null, error: null },
        { fresh: 142, cached: 13981, pct: 0.99, error: null },
        { fresh: 142, cached: 14053, pct: 0.99, error: null },
        { fresh: 142, cached: 14089, pct: 0.99, error: null },
      ],
      verdict: "excellent",
      verdictPct: 0.99,
      providerNote: null,
    },
    codex: {
      turns: [
        { fresh: 8140, cached: 0, pct: null, error: null },
        { fresh: 8140, cached: 4096, pct: 0.33, error: null },
        { fresh: 8140, cached: 4096, pct: 0.33, error: null },
        { fresh: 8140, cached: 4096, pct: 0.33, error: null },
      ],
      verdict: "investigate",
      verdictPct: 0.33,
      providerNote: "provider-typical for codex",
    },
  },
  skipped: { opencode: "no structured parser" },
  hookScan: { claude: [], codex: "no-scanner" },
};

describe("renderTextOutput", () => {
  it("includes both agent tables", () => {
    const out = renderTextOutput(SAMPLE, { explain: true });
    expect(out).toContain("claude");
    expect(out).toContain("codex");
  });
  it("softens codex verdict via qualifier and includes Notes section", () => {
    const out = renderTextOutput(SAMPLE, { explain: true });
    expect(out).toContain("verdict: ok (provider-typical for codex — see Notes)");
    expect(out).toContain("Notes:");
    expect(out).toMatch(/codex caches less aggressively/);
  });
  it("omits Notes section when codex is not audited", () => {
    const { codex, ...rest } = SAMPLE.agents;
    const noCodex: AuditResult = { ...SAMPLE, agents: rest, hookScan: { claude: [] } };
    expect(renderTextOutput(noCodex, { explain: true })).not.toContain("Notes:");
  });
  it("renders em-dash for turn-1 pct (no cache to read)", () => {
    expect(renderTextOutput(SAMPLE, { explain: true })).toMatch(/^\s*1\s+14,212\s+0\s+—/m);
  });
  it("renders '(none detected)' for an empty claude offender list", () => {
    expect(renderTextOutput(SAMPLE, { explain: true })).toContain("claude:  (none detected)");
  });
  it("renders 'scanner not yet implemented' for no-scanner sentinel", () => {
    expect(renderTextOutput(SAMPLE, { explain: true })).toMatch(/codex:\s+scanner not yet implemented/);
  });
  it("includes skipped agents in a leading skipped: line", () => {
    expect(renderTextOutput(SAMPLE, { explain: true })).toMatch(/skipped:\s+opencode \(no structured parser\)/);
  });
  it("omits the entire offender section when explain is false", () => {
    const out = renderTextOutput(SAMPLE, { explain: false });
    expect(out).not.toContain("Likely cache offenders");
    expect(out).not.toContain("scanner not yet implemented");
    expect(out).not.toContain("(none detected)");
  });
  it("renders 'verdict: error — N/M turns failed' when any turn errored", () => {
    const errored: AuditResult = {
      ...SAMPLE,
      agents: {
        claude: {
          turns: [
            { fresh: 100, cached: 900, pct: 0.9, error: null },
            { fresh: null, cached: null, pct: null, error: "exit 1" },
            { fresh: 100, cached: 900, pct: 0.9, error: null },
            { fresh: null, cached: null, pct: null, error: "exit 1" },
          ],
          verdict: "investigate",
          verdictPct: 0,
          providerNote: null,
        },
      },
      hookScan: { claude: [] },
    };
    const out = renderTextOutput(errored, { explain: true });
    expect(out).toContain("verdict: error — 2/4 turns failed");
    expect(out).not.toContain("verdict: investigate");
  });
});

describe("renderJsonOutput", () => {
  it("emits raw verdict tier even when text would soften it", () => {
    const parsed = JSON.parse(renderJsonOutput(SAMPLE));
    expect(parsed.agents.codex.verdict).toBe("investigate");
    expect(parsed.agents.codex.verdictPct).toBeCloseTo(0.33);
    expect(parsed.agents.codex.providerNote).toBe("provider-typical for codex");
  });
  it("includes the skipped object", () => {
    const parsed = JSON.parse(renderJsonOutput(SAMPLE));
    expect(parsed.skipped).toEqual({ opencode: "no structured parser" });
  });
  it("hookScan keys match agents keys", () => {
    const parsed = JSON.parse(renderJsonOutput(SAMPLE));
    expect(Object.keys(parsed.hookScan).sort()).toEqual(Object.keys(parsed.agents).sort());
  });
  it("ends with exactly one trailing newline", () => {
    const out = renderJsonOutput(SAMPLE);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });
  it("represents errored turns with nulls and error string", () => {
    const errored: AuditResult = {
      ...SAMPLE,
      agents: {
        claude: {
          turns: [{ fresh: null, cached: null, pct: null, error: "exit 1" }],
          verdict: "investigate",
          verdictPct: 0,
          providerNote: null,
        },
      },
    };
    const parsed = JSON.parse(renderJsonOutput(errored));
    expect(parsed.agents.claude.turns[0]).toEqual({
      fresh: null, cached: null, pct: null, error: "exit 1",
    });
  });
});

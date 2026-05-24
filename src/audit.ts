// All audit logic in one module. Sections below are ordered:
// types → pure helpers → scanner → renderers → runner → entry.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TokenUsage } from "./parsers.js";
import type { AgentSpec } from "./config.js";
import { agentCommandName, agentIsEnabled } from "./config.js";
import which from "./which.js";

export type TurnResult = {
  fresh: number | null;   // null when the turn errored
  cached: number | null;
  pct: number | null;     // cached / (fresh + cached); null when denominator 0 or errored
  error: string | null;   // "exit 1", "timeout", etc. null on success
};

export type VerdictTier = "excellent" | "ok" | "investigate";

export type AgentResult = {
  turns: TurnResult[];
  verdict: VerdictTier;
  verdictPct: number;
  providerNote: string | null;
};

export type Offender = {
  name: string;
  file: string;
  pattern: string;
  effect: string;
  patch: string;
};

export type ScannerOutput = Offender[] | "no-scanner";
export type CliScanner = () => ScannerOutput;

export type AuditResult = {
  prompt: string;
  turns: number;
  agents: Record<string, AgentResult>;
  skipped: Record<string, string>;
  hookScan: Record<string, ScannerOutput>;
};

export function tokenMetrics(t: TokenUsage): { fresh: number; cached: number; pct: number | null } {
  const fresh = t.input + t.cacheCreate;
  const cached = t.cacheRead;
  const denom = fresh + cached;
  return { fresh, cached, pct: denom > 0 ? cached / denom : null };
}

const STRUCTURED_PARSERS = new Set(["claude-json", "codex-json", "cursor-json"]);

export function auditabilityReason(
  _name: string,
  spec: AgentSpec,
  whichFn: (n: string) => string | null = which,
): string | null {
  if (!agentIsEnabled(spec)) return "disabled";
  const cmd = agentCommandName(spec);
  if (!cmd) return "no command";
  if (!whichFn(cmd)) return `not installed (binary '${cmd}' not on PATH)`;
  if (!spec.parser || !STRUCTURED_PARSERS.has(spec.parser)) {
    return `no structured parser (got '${spec.parser ?? "raw"}'; need one of ${[...STRUCTURED_PARSERS].join(", ")})`;
  }
  if (!spec.resume_template) return "no resume_template";
  return null;
}

export function auditableAgentNames(
  specs: Record<string, AgentSpec>,
  whichFn: (n: string) => string | null = which,
): string[] {
  return Object.entries(specs)
    .filter(([name, spec]) => auditabilityReason(name, spec, whichFn) === null)
    .map(([name]) => name);
}

export function numericVerdict(pct: number): VerdictTier {
  if (pct >= 0.95) return "excellent";
  if (pct >= 0.80) return "ok";
  return "investigate";
}

export function providerQualifier(
  agentName: string,
  pct: number,
  scan: ScannerOutput,
): string | null {
  // "No offenders" = empty array OR the no-scanner sentinel. Both mean
  // "no known config-level cause to flag", which is when the qualifier
  // is meant to suppress the alarm for known-quirky providers.
  const noOffenders = scan === "no-scanner" || scan.length === 0;
  if (agentName === "codex" && pct <= 0.50 && noOffenders) {
    return "provider-typical for codex";
  }
  return null;
}

export function displayVerdictText(
  tier: VerdictTier,
  pct: number,
  providerNote: string | null,
  turn: number,
): string {
  if (providerNote) return `ok (${providerNote} — see Notes)`;
  return `${tier} (${Math.round(pct * 100)}% at turn ${turn})`;
}

export function scanClaudeHooks(claudeHome: string = path.join(os.homedir(), ".claude")): Offender[] {
  const root = path.join(claudeHome, "plugins", "cache");
  if (!existsSync(root)) return [];
  const out: Offender[] = [];
  for (const file of walkForHooksJson(root)) {
    let body: any;
    try {
      body = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const entries = body?.hooks?.SessionStart;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const matcher = typeof entry?.matcher === "string" ? entry.matcher : "";
      const tokens = matcher.split("|").map((s: string) => s.trim().toLowerCase());
      if (!tokens.includes("resume")) continue;
      out.push({
        name: pluginNameFromPath(root, file),
        file,
        pattern: "SessionStart+resume",
        effect: "injects content on every --resume, invalidating prefix cache",
        patch: "remove 'resume' from the matcher or scope it to non-resume SessionStart events",
      });
    }
  }
  return out;
}

function walkForHooksJson(root: string): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) stack.push(full);
      else if (e === "hooks.json" && path.basename(dir) === "hooks") found.push(full);
    }
  }
  return found;
}

function pluginNameFromPath(root: string, file: string): string {
  // file = root/<org>/<plugin>/<version>/hooks/hooks.json — emit "<plugin>@<version>"
  const rel = path.relative(root, file);
  const parts = rel.split(path.sep);
  if (parts.length >= 4) return `${parts[parts.length - 4]}@${parts[parts.length - 3]}`;
  return rel;
}

export const SCANNERS: Record<string, CliScanner> = {
  claude: () => scanClaudeHooks(),
};

export function runScanner(agentName: string): ScannerOutput {
  const fn = SCANNERS[agentName];
  return fn ? fn() : "no-scanner";
}

const CODEX_NOTE =
  "codex caches less aggressively than claude/cursor at the API level. Cache rates in the\n" +
  "  25–45% range are typical and not indicative of a config issue.";

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

export function renderTextOutput(r: AuditResult, opts: { explain: boolean }): string {
  const lines: string[] = [];
  lines.push(`relevo audit — ${r.turns} turns, prompt: ${JSON.stringify(r.prompt)}`);
  lines.push("");

  const skippedNames = Object.keys(r.skipped);
  if (skippedNames.length > 0) {
    const parts = skippedNames.map((n) => `${n} (${r.skipped[n]})`);
    lines.push(`skipped: ${parts.join(", ")}`);
    lines.push("");
  }

  for (const [name, agent] of Object.entries(r.agents)) {
    lines.push(name);
    lines.push("  turn  fresh    cached   cache%");
    agent.turns.forEach((t, i) => {
      const turnNo = String(i + 1);
      if (t.error) {
        lines.push(`  ${turnNo.padEnd(5)} ${"—".padEnd(8)} ${"—".padEnd(8)} err`);
      } else {
        const pct = t.pct === null ? "—" : `${Math.round(t.pct * 100)}%`;
        lines.push(
          `  ${turnNo.padEnd(5)} ${fmtNum(t.fresh!).padEnd(8)} ${fmtNum(t.cached!).padEnd(8)} ${pct}`,
        );
      }
    });
    // Any errored turn overrides the numeric verdict (spec failure-modes rule).
    const failed = agent.turns.filter((t) => t.error !== null).length;
    if (failed > 0) {
      lines.push(`  verdict: error — ${failed}/${agent.turns.length} turns failed`);
    } else {
      const text = displayVerdictText(agent.verdict, agent.verdictPct, agent.providerNote, agent.turns.length);
      lines.push(`  verdict: ${text}`);
    }
    lines.push("");
  }

  if (Object.keys(r.agents).some((n) => n === "codex")) {
    lines.push("Notes:");
    lines.push(`  ${CODEX_NOTE}`);
    lines.push("");
  }

  if (opts.explain) {
    lines.push("Likely cache offenders:");
    for (const name of Object.keys(r.agents)) {
      const scan = r.hookScan[name];
      if (scan === "no-scanner" || scan === undefined) {
        lines.push(`  ${name}:  scanner not yet implemented`);
        continue;
      }
      if (scan.length === 0) {
        lines.push(`  ${name}:  (none detected)`);
        continue;
      }
      lines.push(`  ${name}:`);
      for (const off of scan) {
        lines.push(`    • ${off.name}`);
        lines.push(`      file:    ${off.file}`);
        lines.push(`      pattern: ${off.pattern}`);
        lines.push(`      effect:  ${off.effect}`);
        lines.push(`      patch:   ${off.patch}`);
      }
    }
  }

  return lines.join("\n") + "\n";
}

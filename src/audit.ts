// All audit logic in one module. Sections below are ordered:
// types → pure helpers → scanner → renderers → runner → entry.

import type { TokenUsage } from "./parsers.js";

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

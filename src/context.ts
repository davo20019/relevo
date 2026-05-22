import type { AgentSpec } from "./config.js";
import { loadSessions } from "./sessions.js";
import { readLastTurns } from "./transcripts.js";

export function buildContext(
  targetAgent: string,
  agentSpecs: Record<string, AgentSpec>,
  nTurns: number,
): string {
  // For agents with an active native session (resume_template + saved session_id),
  // skip their own turns since the agent will remember them natively. Otherwise
  // include them so the agent has self-continuity via replay.
  const sessions = loadSessions();
  const chunks: string[] = [];
  for (const name of Object.keys(agentSpecs)) {
    if (name === targetAgent) {
      const spec = agentSpecs[name] ?? ({} as AgentSpec);
      const hasNative = Boolean(spec.resume_template) && Boolean(sessions[name]);
      if (hasNative) continue;
    }
    const recent = readLastTurns(name, nTurns);
    if (recent.trim()) {
      const label = name === targetAgent ? "your own prior turns" : `@${name}`;
      chunks.push(`--- Recent activity from ${label} ---\n${recent}`);
    }
  }
  if (chunks.length === 0) return "";
  return (
    "You are part of a multi-agent workflow. The following is recent activity " +
    "in this shared workspace. Use it as context for your task.\n\n" +
    chunks.join("\n\n") +
    "\n\n--- End of recent activity ---\n\n"
  );
}

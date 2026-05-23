import type { AgentSpec } from "./config.js";
import type { ContextCompactionConfig } from "./compaction.js";
import { compactContextBlock } from "./compaction.js";
import { loadSessions } from "./sessions.js";
import { readLastTurns } from "./transcripts.js";

/** How many recent turns to inject from explicitly requested peer agents. */
export const PEER_CONTEXT_TURNS = 1;

export type BuildContextOptions = {
  peerAgents?: readonly string[];
  contextCompaction?: ContextCompactionConfig;
};

export function buildContext(
  targetAgent: string,
  agentSpecs: Record<string, AgentSpec>,
  nTurns: number,
  options: BuildContextOptions = {},
): string {
  // For agents with an active native session (resume_template + saved session_id),
  // skip their own turns since the agent will remember them natively. Otherwise
  // include them so the agent has self-continuity via replay.
  const sessions = loadSessions();
  const requestedPeers = new Set(options.peerAgents ?? []);
  const chunks: string[] = [];
  for (const name of Object.keys(agentSpecs)) {
    if (name === targetAgent) {
      const spec = agentSpecs[name] ?? ({} as AgentSpec);
      const hasNative = Boolean(spec.resume_template) && Boolean(sessions[name]);
      if (hasNative) continue;
    } else if (!requestedPeers.has(name)) {
      continue;
    }
    const turns = name === targetAgent ? nTurns : PEER_CONTEXT_TURNS;
    const recent = readLastTurns(name, turns);
    if (recent.trim()) {
      const label = name === targetAgent ? "your own prior turns" : `@${name}`;
      const compacted = compactContextBlock(recent, options.contextCompaction);
      chunks.push(`--- Recent activity from ${label} ---\n${compacted}`);
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

import path from "node:path";
import type { AgentSpec } from "./config.js";
import type { ContextCompactionConfig } from "./compaction.js";
import { compactContextBlock } from "./compaction.js";
import { loadSessions } from "./sessions.js";
import { readLastTurns } from "./transcripts.js";
import {
  readDependencyTurnSync,
  transcriptTurnPath,
  type TurnDependency,
} from "./transcriptStore.js";

/** How many recent turns to inject from explicitly requested peer agents. */
export const PEER_CONTEXT_TURNS = 1;

export type BuildContextOptions = {
  peerAgents?: readonly string[];
  contextCompaction?: ContextCompactionConfig;
};

export type BuildAgentPromptOptions = BuildContextOptions & {
  handoff?: string | null;
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

// Composes the final prompt sent to an agent: optional `/after` handoff,
// followed by the cross-agent context block, followed by the user prompt.
// Called both at initial dispatch and after a session-invalid retry — on the
// retry, `clearAgentSession` has already deleted the saved id, so this call
// will include self-history that the initial call deliberately suppressed
// (see buildContext's hasNative branch above).
export function buildAgentPrompt(
  agent: string,
  agentSpecs: Record<string, AgentSpec>,
  contextTurns: number,
  userPrompt: string,
  options: BuildAgentPromptOptions = {},
): string {
  const ctx = buildContext(agent, agentSpecs, contextTurns, {
    peerAgents: options.peerAgents,
    contextCompaction: options.contextCompaction,
  });
  const parts = [options.handoff ?? null, ctx, userPrompt].filter(
    (p): p is string => Boolean(p),
  );
  return parts.join("");
}

// Renders the Phase 2 `/after` handoff. The dependency is resolved by exact
// `run_id` (with `turn_id` as a direct-read optimization), so a later turn from
// the same agent cannot displace the upstream this dispatch was queued behind.
// Returns null when the upstream turn cannot be found — caller falls back to no
// handoff block and logs.
export function buildHandoffBlock(dep: TurnDependency): string | null {
  const turn = readDependencyTurnSync(dep);
  if (!turn) return null;
  const full = path.resolve(transcriptTurnPath(dep.agent, turn.turn_id));
  const files = turn.files_edited.length ? turn.files_edited.join(", ") : "(none)";
  const preview = turn.response_preview ?? "(no response preview)";
  return (
    `You were dispatched after @${dep.agent} finished run ${dep.run_id}.\n` +
    `Their exact upstream turn:\n` +
    `  ts: ${turn.ts}   files: ${files}\n` +
    `  preview: ${JSON.stringify(preview)}\n` +
    `           [bounded handoff only — read the full turn for complete details]\n` +
    `  full turn: ${full}\n`
  );
}

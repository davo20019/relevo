// Decision and rendering helpers for the prompt queue.
//
// While a dispatch is running, relevo accepts further typed prompts and
// either queues them (regular prompts) or rejects them (slash commands,
// because they mutate state the in-flight run reads — active task,
// transcripts dir, sessions — and queuing them would corrupt or
// misattribute the running turn).

export type QueueDecision = "dispatch" | "queue" | "reject-slash";

export type QueueDependency = { agent: string; runId: string };

export function dependencyKey(dep: QueueDependency): string {
  return `${dep.agent}:${dep.runId}`;
}

export function parseDependencyKey(key: string): QueueDependency | null {
  const i = key.indexOf(":");
  if (i < 0) return null;
  return { agent: key.slice(0, i), runId: key.slice(i + 1) };
}

export function dependencySatisfied(
  dep: QueueDependency | undefined,
  completed: ReadonlySet<string>,
): boolean {
  return dep === undefined || completed.has(dependencyKey(dep));
}

export type ActiveRunSnapshot = {
  id: string;
  agentName: string;
  running: boolean;
  start: number;
};

export type AfterTarget = { runId: string; ambiguous: boolean };

/**
 * Resolve which run a `/after @agent: ...` should wait on.
 * Returns null when there is no in-flight or terminal run for the agent.
 *
 * Order (first match wins):
 *  1. Exactly one in-flight run for that agent → use its id.
 *  2. Multiple in-flight runs → most recently *started* one, ambiguous=true.
 *  3. Otherwise, most recent terminal run in completedRunOrder (walk back).
 *  4. None → null.
 */
export function resolveAfterTarget(
  targetAgent: string,
  activeRuns: ReadonlyArray<ActiveRunSnapshot>,
  completedRunOrder: readonly string[],
): AfterTarget | null {
  const inFlight = activeRuns.filter((r) => r.agentName === targetAgent && r.running);
  if (inFlight.length === 1) {
    return { runId: inFlight[0]!.id, ambiguous: false };
  }
  if (inFlight.length > 1) {
    let latest = inFlight[0]!;
    for (const r of inFlight) if (r.start > latest.start) latest = r;
    return { runId: latest.id, ambiguous: true };
  }
  for (let i = completedRunOrder.length - 1; i >= 0; i--) {
    const dep = parseDependencyKey(completedRunOrder[i]!);
    if (dep && dep.agent === targetAgent) {
      return { runId: dep.runId, ambiguous: false };
    }
  }
  return null;
}

export type PromptQueueBatch<T extends { agent: string }> = {
  line: string;
  items: T[];
  delivered: Set<string>;
};

export const COMPLETED_RUN_HISTORY_LIMIT = 256;

/**
 * Record a terminal run key in a bounded LRU. Idempotent — repeat keys are no-ops.
 * Evicts the oldest entry once `limit` is exceeded.
 */
export function recordCompletedRunKey(
  keys: Set<string>,
  order: string[],
  key: string,
  limit: number = COMPLETED_RUN_HISTORY_LIMIT,
): void {
  if (keys.has(key)) return;
  keys.add(key);
  order.push(key);
  if (order.length > limit) {
    const oldest = order.shift()!;
    keys.delete(oldest);
  }
}

export function classifySubmit(line: string, busy: boolean): QueueDecision {
  if (!busy) return "dispatch";
  if (line.trimStart().startsWith("/")) return "reject-slash";
  return "queue";
}

export function shouldDisablePromptInput(preparing: boolean, inFlightCount: number): boolean {
  return preparing && inFlightCount === 0;
}

export function queuedLines<T extends { agent: string }>(
  queue: readonly PromptQueueBatch<T>[],
): string[] {
  return queue.map((b) => b.line);
}

export function pruneDeliveredBatches<T extends { agent: string }>(
  queue: PromptQueueBatch<T>[],
): void {
  for (let i = queue.length - 1; i >= 0; i--) {
    const batch = queue[i]!;
    if (batch.delivered.size >= batch.items.length) {
      queue.splice(i, 1);
    }
  }
}

export function formatQueuePreview(line: string, width: number): string[] {
  const oneLine = line.replace(/\s+/g, " ").trim();
  const max = Math.max(1, width);
  if (oneLine.length <= max) return [oneLine];

  const rows: string[] = [];
  let rest = oneLine;
  while (rows.length < 2 && rest.length > 0) {
    if (rest.length <= max) {
      rows.push(rest);
      rest = "";
      break;
    }

    const chunk = rest.slice(0, max + 1);
    const breakAt = chunk.lastIndexOf(" ", max);
    const take = breakAt > 0 ? breakAt : max;
    rows.push(rest.slice(0, take));
    rest = rest.slice(take).trimStart();
  }

  if (rest.length > 0 && rows.length > 0) {
    const last = rows[rows.length - 1] ?? "";
    rows[rows.length - 1] = last.length >= max
      ? last.slice(0, max - 1) + "…"
      : last + "…";
  }

  return rows;
}

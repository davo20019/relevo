// Decision and rendering helpers for the prompt queue.
//
// While a dispatch is running, relevo accepts further typed prompts and
// either queues them (regular prompts) or rejects them (slash commands,
// because they mutate state the in-flight run reads — active task,
// transcripts dir, sessions — and queuing them would corrupt or
// misattribute the running turn).

export type QueueDecision = "dispatch" | "queue" | "reject-slash";

export function classifySubmit(line: string, busy: boolean): QueueDecision {
  if (!busy) return "dispatch";
  if (line.trimStart().startsWith("/")) return "reject-slash";
  return "queue";
}

export function formatQueuePreview(line: string, max: number): string {
  const oneLine = line.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + "…";
}

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

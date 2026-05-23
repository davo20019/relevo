export type ContextCompactionConfig = {
  enabled?: boolean;
  maxCharsPerBlock?: number;
  maxLineLength?: number;
};

export const DEFAULT_CONTEXT_COMPACTION: Required<ContextCompactionConfig> = {
  enabled: true,
  maxCharsPerBlock: 24_000,
  maxLineLength: 700,
};

export function normalizeContextCompaction(
  config?: ContextCompactionConfig,
): Required<ContextCompactionConfig> {
  return {
    enabled: config?.enabled ?? DEFAULT_CONTEXT_COMPACTION.enabled,
    maxCharsPerBlock: config?.maxCharsPerBlock ?? DEFAULT_CONTEXT_COMPACTION.maxCharsPerBlock,
    maxLineLength: config?.maxLineLength ?? DEFAULT_CONTEXT_COMPACTION.maxLineLength,
  };
}

export function compactContextBlock(text: string, config?: ContextCompactionConfig): string {
  const opts = normalizeContextCompaction(config);
  if (!opts.enabled) return text;

  const normalized = text.replace(/\n{4,}/g, "\n\n\n");
  const lineCompacted = compactLongLines(normalized, opts.maxLineLength);
  if (lineCompacted.text.length <= opts.maxCharsPerBlock) {
    return lineCompacted.text;
  }

  return keepEdges(lineCompacted.text, opts.maxCharsPerBlock);
}

function compactLongLines(
  text: string,
  maxLineLength: number,
): { text: string; compactedLines: number } {
  let compactedLines = 0;
  const lines = text.split("\n").map((line) => {
    if (line.length <= maxLineLength) return line;
    compactedLines++;
    const head = line.slice(0, Math.max(0, maxLineLength - 80));
    const omitted = line.length - head.length;
    return `${head} [relevo compacted ${omitted} chars from this line]`;
  });
  return { text: lines.join("\n"), compactedLines };
}

function keepEdges(text: string, maxChars: number): string {
  const marker = "\n[relevo compacted middle of oversized context block]\n";
  const budget = Math.max(0, maxChars - marker.length);
  const headBudget = Math.floor(budget * 0.6);
  const tailBudget = budget - headBudget;
  const head = text.slice(0, headBudget).replace(/\n[^\n]*$/, "\n");
  const tail = text.slice(Math.max(head.length, text.length - tailBudget)).replace(/^[^\n]*\n/, "");
  return `${head}${marker}${tail}`;
}

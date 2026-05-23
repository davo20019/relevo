import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { historyFile } from "./paths.js";

const MAX_ENTRIES = 500;

// History is stored as JSONL so multi-line prompts survive a round trip.
// Most recent entry is the last line.
export function loadPromptHistory(): string[] {
  try {
    const raw = readFileSync(historyFile(), "utf8");
    const out: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const v = JSON.parse(line);
        if (typeof v === "string" && v.length > 0) out.push(v);
      } catch {
        // tolerate corrupt lines: skip them
      }
    }
    if (out.length > MAX_ENTRIES) return out.slice(out.length - MAX_ENTRIES);
    return out;
  } catch {
    return [];
  }
}

export function appendPromptHistory(entry: string): void {
  const trimmed = entry.replace(/\s+$/, "");
  if (!trimmed) return;
  const file = historyFile();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(trimmed) + "\n", "utf8");
    // Best-effort trim: rewrite the file if it grew well past the cap so it
    // doesn't bloat indefinitely.
    const current = loadPromptHistory();
    if (current.length > MAX_ENTRIES + 100) {
      const kept = current.slice(current.length - MAX_ENTRIES);
      writeFileSync(file, kept.map((s) => JSON.stringify(s) + "\n").join(""), "utf8");
    }
  } catch {
    // history is best-effort; ignore write failures
  }
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { dispatchStatsFile } from "./paths.js";

type DispatchCounter = { total: number };
type DispatchStats = {
  v: 1;
  agents: Record<string, DispatchCounter>;
  parsers: Record<string, DispatchCounter>;
};

function emptyStats(): DispatchStats {
  return { v: 1, agents: {}, parsers: {} };
}

function bump(map: Record<string, DispatchCounter>, key: string): void {
  map[key] = { total: (map[key]?.total ?? 0) + 1 };
}

export function recordDispatch(agent: string, parser: string | undefined): void {
  try {
    const file = dispatchStatsFile();
    let stats: DispatchStats = emptyStats();
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as DispatchStats & { v?: number };
      if (typeof parsed.v === "number" && parsed.v > 1) return;
      stats = {
        v: 1,
        agents: parsed.agents ?? {},
        parsers: parsed.parsers ?? {},
      };
    }
    bump(stats.agents, agent);
    bump(stats.parsers, parser ?? "raw");
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(stats, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // Dispatch stats are observational only and must never break a run.
  }
}

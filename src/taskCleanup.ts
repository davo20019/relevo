import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { sessionsFile, transcriptDir } from "./paths.js";
import { clearSessions } from "./sessions.js";

export type ClearTaskContextResult = {
  transcriptsCleared: number;
  sessionsCleared: boolean;
};

export function clearTaskContext(): ClearTaskContextResult {
  let transcriptsCleared = 0;
  const dir = transcriptDir();

  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      const target = path.join(dir, f);
      let stat;
      try {
        stat = statSync(target);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        rmSync(target, { recursive: true, force: true });
        transcriptsCleared++;
        continue;
      }
      if (!f.endsWith(".md") && !f.endsWith(".index.jsonl")) continue;
      unlinkSync(target);
      transcriptsCleared++;
    }
  }

  const hadSessions = existsSync(sessionsFile());
  clearSessions();

  return { transcriptsCleared, sessionsCleared: hadSessions };
}

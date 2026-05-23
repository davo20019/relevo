import { existsSync, readdirSync, unlinkSync } from "node:fs";
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
      if (!f.endsWith(".md")) continue;
      unlinkSync(path.join(dir, f));
      transcriptsCleared++;
    }
  }

  const hadSessions = existsSync(sessionsFile());
  clearSessions();

  return { transcriptsCleared, sessionsCleared: hadSessions };
}

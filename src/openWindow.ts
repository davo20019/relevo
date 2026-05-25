import { spawn } from "node:child_process";

// macOS-only: open a new Terminal/iTerm window running `cmd` from `cwd`.
// Returns { ok, error } so callers can surface errors in the UI.
export function openInNewTerminal(cmd: string, cwd: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const termProgram = process.env.TERM_PROGRAM ?? "";
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(cmd) || cmd.includes("\n")) {
      resolve({ ok: false, error: "command contains control characters" });
      return;
    }
    const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    // Run cmd via `/bin/sh -c <single-quoted cmd>` so the outer shell that
    // AppleScript spawns treats cmd as a single argument and cannot be tricked
    // by an unbalanced quote in cmd. The inner shell still interprets cmd
    // normally (which is required — cmd is a shell command template).
    const full = `cd ${shellQuote(cwd)} && exec /bin/sh -c ${shellQuote(cmd)}`;
    const fullEscaped = full.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = termProgram.includes("iTerm")
      ? `tell application "iTerm" to create window with default profile command "${fullEscaped}"`
      : `tell application "Terminal" to do script "${fullEscaped}"`;
    let proc;
    try {
      proc = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ ok: false, error: "osascript not found (macOS only)" });
      return;
    }
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += String(d)));
    proc.on("error", (e) => resolve({ ok: false, error: e.message }));
    proc.on("close", (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: stderr.trim() || `exit ${code}` });
    });
  });
}

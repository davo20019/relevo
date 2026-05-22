import { spawn } from "node:child_process";

// macOS-only: open a new Terminal/iTerm window running `cmd` from `cwd`.
// Returns { ok, error } so callers can surface errors in the UI.
export function openInNewTerminal(cmd: string, cwd: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const termProgram = process.env.TERM_PROGRAM ?? "";
    const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const full = `cd ${shellQuote(cwd)} && exec ${cmd}`;
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

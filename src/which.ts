import { existsSync, statSync } from "node:fs";
import path from "node:path";

// Minimal which() to avoid an extra dep. Walks $PATH, returns the first
// executable hit or null. Mirrors shutil.which() for the lookup cases relevo
// actually needs (agent CLIs with no special PATHEXT handling).
export default function which(name: string): string | null {
  if (!name) return null;
  if (name.includes(path.sep)) {
    return existsSync(name) && isExecutable(name) ? name : null;
  }
  const pathEnv = process.env.PATH || "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (existsSync(candidate) && isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutable(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    if (process.platform === "win32") return true;
    // Owner/group/world execute bit. We don't check uid/gid match — shutil.which
    // doesn't either; it just checks the X_OK access bit. Close enough.
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

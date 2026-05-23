import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import which from "./which.js";
import { projectDir } from "./paths.js";

export const IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
  ".heic",
]);

// Matches drag-and-drop shapes on macOS terminals: double-quoted, single-quoted,
// or bare-with-backslash-escaped-spaces image paths.
export const IMAGE_TOKEN = new RegExp(
  String.raw`"([^"]+?\.(?:png|jpe?g|gif|webp|bmp|tiff|heic))"` +
    `|` +
    String.raw`'([^']+?\.(?:png|jpe?g|gif|webp|bmp|tiff|heic))'` +
    `|` +
    String.raw`((?:[^ \t\r\n\\]|\\.)+\.(?:png|jpe?g|gif|webp|bmp|tiff|heic))`,
  "gi",
);

function expandHome(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}

/** Turn a dropped/pasted path token into a local filesystem path when possible. */
export function resolveImagePathCandidate(raw: string): string {
  const unescaped = raw.replace(/\\(.)/g, "$1");
  if (/^file:\/\//i.test(unescaped)) {
    try {
      return fileURLToPath(unescaped);
    } catch {
      return unescaped;
    }
  }
  return expandHome(unescaped);
}

/** Normalize a terminal drop/paste chunk (often a single file URI) before compaction. */
export function normalizeDroppedInput(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (/^file:\/\//i.test(trimmed) && !/[\r\n]/.test(trimmed)) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return rawInput;
    }
  }
  return rawInput;
}

export function extractImagePaths(text: string): { images: string[]; cleaned: string } {
  const images: string[] = [];
  const spans: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  IMAGE_TOKEN.lastIndex = 0;
  while ((m = IMAGE_TOKEN.exec(text))) {
    const dq = m[1];
    const sq = m[2];
    const bare = m[3];
    const raw = dq ?? sq ?? bare;
    if (!raw) continue;
    const resolved = resolveImagePathCandidate(raw);
    try {
      if (!existsSync(resolved) || !statSync(resolved).isFile()) continue;
    } catch {
      continue;
    }
    images.push(path.resolve(resolved));
    spans.push([m.index, IMAGE_TOKEN.lastIndex]);
  }
  if (images.length === 0) return { images: [], cleaned: text };

  let result = text;
  for (const [start, end] of [...spans].sort((a, b) => b[0] - a[0])) {
    result = result.slice(0, start) + " " + result.slice(end);
  }
  return { images, cleaned: result.replace(/\s+/g, " ").trim() };
}

export function formatPromptWithImages(prompt: string, imagePaths: string[]): string {
  if (imagePaths.length === 0) return prompt;
  const listing = imagePaths.join("\n");
  const header = `Attached images:\n${listing}\n\n`;
  return prompt ? header + prompt : header.trimEnd() + "\n";
}

export function formatPromptForAgentImages(
  agentName: string,
  prompt: string,
  imagePaths: string[],
): string {
  if (agentName !== "cursor") return formatPromptWithImages(prompt, imagePaths);
  if (imagePaths.length === 0) return prompt;
  const suffix = imagePaths.join(" ");
  return prompt ? `${prompt} ${suffix}` : suffix;
}

type CacheRootOptions = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir?: string;
  platform?: NodeJS.Platform;
};

export function defaultImageCacheRoot(options: CacheRootOptions = {}): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const xdg = env.XDG_CACHE_HOME?.trim();
  if (xdg) return path.join(expandHome(xdg), "relevo");
  if (platform === "darwin") return path.join(homeDir, "Library", "Caches", "relevo");
  if (platform === "win32" && env.LOCALAPPDATA?.trim()) {
    return path.join(env.LOCALAPPDATA, "relevo", "Cache");
  }
  return path.join(homeDir, ".cache", "relevo");
}

export function imageCacheDir(cacheRoot = defaultImageCacheRoot()): string {
  return path.join(cacheRoot, "images");
}

export function cleanupStagedImageCache(
  cacheRoot = defaultImageCacheRoot(),
  retentionDays = 30,
  now = new Date(),
): number {
  const dir = imageCacheDir(cacheRoot);
  if (!existsSync(dir)) return 0;
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      if (st.mtimeMs >= cutoff) continue;
      rmSync(p, { force: true });
      removed++;
    } catch {
      // Best-effort cleanup; ignore races with other processes.
    }
  }
  return removed;
}

/** True when the path is likely to vanish or be unreadable by agents in the project cwd. */
export function imagePathNeedsStaging(resolved: string, projectRoot = projectDir()): boolean {
  const abs = path.resolve(resolved);
  const project = path.resolve(projectRoot);
  if (/\/TemporaryItems(\/|$)/i.test(abs)) return true;
  const rel = path.relative(project, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    const taskImages = path.join(project, ".relay", "tasks");
    if (abs.includes(`${path.sep}images${path.sep}`) && abs.includes(taskImages)) {
      return false;
    }
    return true;
  }
  return false;
}

function uniqueStagedPath(destDir: string, source: string, id: number): string {
  const ext = path.extname(source) || ".png";
  const stem =
    path
      .basename(source, ext)
      .replace(/[^\w.-]+/g, "_")
      .slice(0, 48) || "image";
  const ts = Date.now();
  let dest = path.join(destDir, `dropped-${stem}-${ts}-${id}${ext}`);
  let n = 0;
  while (existsSync(dest)) {
    n += 1;
    dest = path.join(destDir, `dropped-${stem}-${ts}-${id}-${n}${ext}`);
  }
  return dest;
}

export async function stageImagePaths(
  sources: string[],
  destDir?: string,
  cacheRoot?: string,
): Promise<string[]> {
  if (sources.length === 0) return [];
  const targetDir = destDir ?? imageCacheDir(cacheRoot);
  mkdirSync(targetDir, { recursive: true });
  const staged: string[] = [];
  for (let i = 0; i < sources.length; i++) {
    const abs = path.resolve(sources[i]!);
    if (!imagePathNeedsStaging(abs)) {
      staged.push(abs);
      continue;
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new Error(`image not found or not readable: ${abs}`);
    }
    const dest = uniqueStagedPath(targetDir, abs, i);
    await copyFile(abs, dest);
    staged.push(dest);
  }
  return staged;
}

/** Ephemeral staging when no task exists yet (e.g. early /image queue). */
export function relevoTempImageDir(): string {
  return imageCacheDir();
}

export async function pasteClipboardImage(): Promise<{ path?: string; error?: string }> {
  if (!which("pngpaste")) {
    return {
      error:
        "pngpaste not found. Install with `brew install pngpaste`, " +
        "or use `/image <path>` to attach a file directly.",
    };
  }
  await mkdir(imageCacheDir(), { recursive: true });
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "-");
  const out = path.join(imageCacheDir(), `clipboard-${ts}.png`);
  const result = spawnSync("pngpaste", [out], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "").trim() || "no image on clipboard";
    return { error: err };
  }
  if (!existsSync(out) || statSync(out).size === 0) {
    return { error: "pngpaste produced no output (clipboard may not contain an image)" };
  }
  return { path: out };
}

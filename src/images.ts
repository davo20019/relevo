import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import which from "./which.js";
import { imagesDir } from "./paths.js";

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
const IMAGE_TOKEN = new RegExp(
  String.raw`"([^"]+?\.(?:png|jpe?g|gif|webp|bmp|tiff|heic))"` +
    `|` +
    String.raw`'([^']+?\.(?:png|jpe?g|gif|webp|bmp|tiff|heic))'` +
    `|` +
    String.raw`((?:[^\s\\]|\\.)+\.(?:png|jpe?g|gif|webp|bmp|tiff|heic))`,
  "gi",
);

function expandHome(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
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
    const candidate = bare ? raw.replace(/\\(.)/g, "$1") : raw;
    const resolved = expandHome(candidate);
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

export async function pasteClipboardImage(): Promise<{ path?: string; error?: string }> {
  if (!which("pngpaste")) {
    return {
      error:
        "pngpaste not found. Install with `brew install pngpaste`, " +
        "or use `/image <path>` to attach a file directly.",
    };
  }
  await mkdir(imagesDir(), { recursive: true });
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "-");
  const out = path.join(imagesDir(), `clipboard-${ts}.png`);
  // spawnSync uses argv (no shell), so the path arg can't be shell-interpreted.
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

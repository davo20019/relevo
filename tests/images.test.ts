import { describe, expect, it } from "vitest";
import {
  cleanupStagedImageCache,
  defaultImageCacheRoot,
  extractImagePaths,
  formatPromptForAgentImages,
  formatPromptWithImages,
  imagePathNeedsStaging,
  normalizeDroppedInput,
  resolveImagePathCandidate,
  stageImagePaths,
} from "../src/images.js";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync, utimesSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

describe("extractImagePaths", () => {
  it("picks up bare and quoted image paths that exist on disk", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "relevo-img-"));
    const png = path.join(dir, "shot.png");
    writeFileSync(png, "fake");
    const text = `compare ${png} please`;
    const { images, cleaned } = extractImagePaths(text);
    expect(images).toContain(path.resolve(png));
    expect(cleaned).not.toContain("shot.png");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the original text when no real files are referenced", () => {
    const { images, cleaned } = extractImagePaths("see image.png please");
    expect(images).toEqual([]);
    expect(cleaned).toBe("see image.png please");
  });

  it("resolves file:// URIs when the file exists", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "relevo-img-"));
    const png = path.join(dir, "uri.png");
    writeFileSync(png, "fake");
    const uri = `file://${png}`;
    const { images, cleaned } = extractImagePaths(`check ${uri}`);
    expect(images).toContain(path.resolve(png));
    expect(cleaned).not.toContain("file://");
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps narrow no-break spaces inside dropped macOS screenshot paths", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "relevo-img-"));
    const png = path.join(dir, "Screenshot 2026-05-23 at 5.26.53\u202fPM.png");
    writeFileSync(png, "fake");
    const dropped = png.replaceAll(" ", "\\ ");
    const { images, cleaned } = extractImagePaths(`${dropped} what do you see?`);
    expect(images).toEqual([path.resolve(png)]);
    expect(cleaned).toBe("what do you see?");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("normalizeDroppedInput", () => {
  it("converts a lone file:// URI to a filesystem path", () => {
    expect(normalizeDroppedInput("file:///tmp/a.png")).toBe("/tmp/a.png");
  });
});

describe("resolveImagePathCandidate", () => {
  it("maps file:// to a path", () => {
    expect(resolveImagePathCandidate("file:///var/x.png")).toBe("/var/x.png");
  });
});

describe("imagePathNeedsStaging", () => {
  it("flags macOS TemporaryItems screenshot paths", () => {
    const p =
      "/var/folders/xx/TemporaryItems/NSIRD_screencaptureui_XXX/Screenshot.png";
    expect(imagePathNeedsStaging(p, "/Users/me/proj")).toBe(true);
  });

  it("does not re-stage images already under the task images folder", () => {
    const project = "/Users/me/proj";
    const p = path.join(project, ".relay", "tasks", "t1", "images", "clipboard-1.png");
    expect(imagePathNeedsStaging(p, project)).toBe(false);
  });

  it("does not stage paths already inside the project", () => {
    const project = mkdtempSync(path.join(os.tmpdir(), "relevo-proj-"));
    const png = path.join(project, "shot.png");
    writeFileSync(png, "x");
    expect(imagePathNeedsStaging(png, project)).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });
});

describe("stageImagePaths", () => {
  it("copies unstable paths into the destination folder", async () => {
    const project = mkdtempSync(path.join(os.tmpdir(), "relevo-proj-"));
    const srcDir = mkdtempSync(path.join(os.tmpdir(), "relevo-src-"));
    const destDir = mkdtempSync(path.join(os.tmpdir(), "relevo-dest-"));
    const src = path.join(srcDir, "shot.png");
    writeFileSync(src, "pixels");
    expect(imagePathNeedsStaging(src, project)).toBe(true);
    const [staged] = await stageImagePaths([src], destDir);
    expect(staged.startsWith(destDir)).toBe(true);
    expect(readFileSync(staged, "utf8")).toBe("pixels");
    rmSync(destDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("copies unstable paths into the default Relevo cache", async () => {
    const srcDir = mkdtempSync(path.join(os.tmpdir(), "relevo-src-"));
    const cacheRoot = mkdtempSync(path.join(os.tmpdir(), "relevo-cache-"));
    const src = path.join(srcDir, "shot.png");
    writeFileSync(src, "pixels");
    const [staged] = await stageImagePaths([src], undefined, cacheRoot);
    expect(staged.startsWith(path.join(cacheRoot, "images"))).toBe(true);
    expect(readFileSync(staged, "utf8")).toBe("pixels");
    rmSync(cacheRoot, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });
});

describe("defaultImageCacheRoot", () => {
  it("uses XDG_CACHE_HOME when provided", () => {
    expect(defaultImageCacheRoot({ env: { XDG_CACHE_HOME: "/tmp/xdg" }, platform: "linux" }))
      .toBe("/tmp/xdg/relevo");
  });

  it("uses the macOS Caches directory on darwin", () => {
    expect(defaultImageCacheRoot({ env: {}, homeDir: "/Users/me", platform: "darwin" }))
      .toBe("/Users/me/Library/Caches/relevo");
  });
});

describe("cleanupStagedImageCache", () => {
  it("removes staged images older than the retention window", () => {
    const cacheRoot = mkdtempSync(path.join(os.tmpdir(), "relevo-cache-"));
    const imageDir = path.join(cacheRoot, "images");
    mkdirSync(imageDir, { recursive: true });
    const oldFile = path.join(imageDir, "old.png");
    const freshFile = path.join(imageDir, "fresh.png");
    writeFileSync(oldFile, "old");
    writeFileSync(freshFile, "fresh");
    const now = new Date("2026-05-23T12:00:00Z");
    const old = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, old, old);
    utimesSync(freshFile, now, now);

    const removed = cleanupStagedImageCache(cacheRoot, 30, now);

    expect(removed).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(freshFile)).toBe(true);
    rmSync(cacheRoot, { recursive: true, force: true });
  });
});

describe("formatPromptWithImages", () => {
  it("prefixes an Attached images: block", () => {
    const out = formatPromptWithImages("review", ["/tmp/a.png"]);
    expect(out.startsWith("Attached images:\n/tmp/a.png\n\n")).toBe(true);
    expect(out.endsWith("review")).toBe(true);
  });

  it("is a no-op without images", () => {
    expect(formatPromptWithImages("hello", [])).toBe("hello");
  });
});

describe("formatPromptForAgentImages", () => {
  it("keeps Cursor image paths inline instead of using an attachment block", () => {
    expect(formatPromptForAgentImages("cursor", "review", ["/tmp/a.png"])).toBe(
      "review /tmp/a.png",
    );
  });

  it("keeps the attachment block for other agents", () => {
    expect(formatPromptForAgentImages("codex", "review", ["/tmp/a.png"])).toBe(
      "Attached images:\n/tmp/a.png\n\nreview",
    );
  });
});

import { describe, expect, it } from "vitest";
import { extractImagePaths, formatPromptWithImages } from "../src/images.js";
import { mkdtempSync, writeFileSync } from "node:fs";
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
  });

  it("returns the original text when no real files are referenced", () => {
    const { images, cleaned } = extractImagePaths("see image.png please");
    expect(images).toEqual([]);
    expect(cleaned).toBe("see image.png please");
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

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearActiveTaskForTest,
  createTaskDir,
  getActiveTask,
  provisionalTaskName,
  renameTask,
  setActiveTask,
  slugFromPrompt,
} from "../src/tasks.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  clearActiveTaskForTest();
});

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relevo-lazy-"));
  created.push(dir);
  return dir;
}

describe("lazy-create + auto-rename flow", () => {
  it("first dispatch allocates a provisional task, then renames from prompt, and never renames again", () => {
    const project = tempProject();
    const tasksRoot = path.join(project, ".relay", "tasks");

    expect(getActiveTask()).toBeNull();
    const provisional = createTaskDir(tasksRoot, provisionalTaskName(new Date(), 12345));
    setActiveTask(provisional);
    let candidate: string | null = provisional;
    expect(provisional).toMatch(/^s-\d{8}-\d{6}-12345$/);
    expect(existsSync(path.join(tasksRoot, provisional))).toBe(true);

    const slug = slugFromPrompt("Fix the auth bug today")!;
    expect(slug).toBe("fix-the-auth-bug-today");
    const renamed = renameTask(tasksRoot, getActiveTask()!, slug);
    setActiveTask(renamed);
    candidate = null;
    expect(renamed).toBe(slug);
    expect(existsSync(path.join(tasksRoot, slug))).toBe(true);
    expect(existsSync(path.join(tasksRoot, provisional))).toBe(false);

    expect(candidate).toBeNull();
    expect(getActiveTask()).toBe(slug);
    expect(readdirSync(tasksRoot).sort()).toEqual([slug]);
  });

  it("auto-rename does not fire when the candidate ref is null (resumed task)", () => {
    const project = tempProject();
    const tasksRoot = path.join(project, ".relay", "tasks");
    const resumed = createTaskDir(tasksRoot, "s-20260101-000000-99");
    setActiveTask(resumed);
    const candidate: string | null = null;

    expect(candidate).toBeNull();
    expect(readdirSync(tasksRoot)).toEqual([resumed]);
  });

  it("auto-rename collides cleanly when the slug already exists", () => {
    const project = tempProject();
    const tasksRoot = path.join(project, ".relay", "tasks");
    createTaskDir(tasksRoot, "fix-the-auth-bug-today");
    const provisional = createTaskDir(tasksRoot, provisionalTaskName(new Date(), 7));
    setActiveTask(provisional);

    const slug = slugFromPrompt("Fix the auth bug today")!;
    const renamed = renameTask(tasksRoot, getActiveTask()!, slug);
    setActiveTask(renamed);
    expect(renamed).toBe("fix-the-auth-bug-today-2");
    expect(existsSync(path.join(tasksRoot, "fix-the-auth-bug-today-2"))).toBe(true);
    expect(existsSync(path.join(tasksRoot, provisional))).toBe(false);
  });
});

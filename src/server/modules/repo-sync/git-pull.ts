import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function hasGitDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

/**
 * 解析 git/npm 项目根。文档内容路径可能指向仓库内 `docs/`，只上溯一层，不误操作父级源码仓。
 */
export function resolveRepoProjectRoot(repoPath: string): string {
  const abs = path.resolve(repoPath);
  if (hasGitDir(abs)) return abs;
  const parent = path.dirname(abs);
  if (parent !== abs && path.basename(abs).toLowerCase() === "docs") {
    if (hasGitDir(parent) || fs.existsSync(path.join(parent, "package.json"))) return parent;
  }
  return abs;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  // porcelain 行首空格有语义（如 ` M file`），不能 trimStart
  return stdout.replace(/\s+$/u, "");
}

export async function readGitRev(repoPath: string): Promise<string | null> {
  const gitRoot = resolveRepoProjectRoot(repoPath);
  if (!hasGitDir(gitRoot)) return null;
  try {
    return await git(gitRoot, ["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
}

export function parseTrackedDirtyPaths(porcelain: string): string[] {
  return porcelain
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const rest = line.length >= 3 ? line.slice(3) : line;
      const arrow = rest.indexOf(" -> ");
      return (arrow >= 0 ? rest.slice(arrow + 4) : rest).replace(/\\/g, "/");
    })
    .filter(Boolean);
}

export function blockingDirtyPaths(dirtyPaths: string[], preserveLocalFiles: string[] = []): string[] {
  const preserve = new Set(preserveLocalFiles.map((item) => item.replace(/\\/g, "/")));
  return dirtyPaths.filter((item) => !preserve.has(item.replace(/\\/g, "/")));
}

function backupLocalFiles(gitRoot: string, relPaths: string[]): Map<string, Buffer> {
  const backups = new Map<string, Buffer>();
  for (const rel of relPaths) {
    const abs = path.join(gitRoot, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      backups.set(rel, fs.readFileSync(abs));
    }
  }
  return backups;
}

function restoreLocalFiles(gitRoot: string, backups: Map<string, Buffer>): string[] {
  const restored: string[] = [];
  for (const [rel, buf] of backups) {
    const abs = path.join(gitRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    restored.push(rel);
  }
  return restored;
}

/**
 * fetch + checkout + reset --hard origin/<branch>
 */
export async function hardResetPull(
  repoPath: string,
  branch: string,
  options?: { preserveLocalFiles?: string[] },
): Promise<{ before: string | null; after: string; preserved?: string[] }> {
  const gitRoot = resolveRepoProjectRoot(repoPath);
  if (!hasGitDir(gitRoot)) {
    throw new Error(`not_git_repo:${gitRoot}`);
  }
  const preserveLocalFiles = options?.preserveLocalFiles || [];
  const dirty = await git(gitRoot, ["status", "--porcelain", "--untracked-files=no"]);
  const blocking = blockingDirtyPaths(parseTrackedDirtyPaths(dirty), preserveLocalFiles);
  if (blocking.length) {
    throw new Error(
      `working_tree_dirty: 工作区有未提交的已跟踪改动，已拒绝 git reset --hard，以免覆盖本地开发 (${gitRoot})`,
    );
  }
  const backups = backupLocalFiles(gitRoot, preserveLocalFiles);
  const before = await readGitRev(gitRoot);
  await git(gitRoot, ["fetch", "origin", branch]);
  try {
    await git(gitRoot, ["checkout", branch]);
  } catch {
    await git(gitRoot, ["checkout", "-B", branch, `origin/${branch}`]);
  }
  await git(gitRoot, ["reset", "--hard", `origin/${branch}`]);
  const preserved = restoreLocalFiles(gitRoot, backups);
  const after = await git(gitRoot, ["rev-parse", "HEAD"]);
  return { before, after, preserved: preserved.length ? preserved : undefined };
}

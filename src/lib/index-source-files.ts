import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function isNestedGitRepo(dir: string) {
  try {
    await fs.access(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function listGitSourceFiles(repoRoot: string, roots: string[], extensions: string[]) {
  const extRe = extensions.length ? new RegExp(`\\.(${extensions.map((x) => x.replace(/^\./, "")).join("|")})$`, "i") : null;
  const gitArgs = ["-C", repoRoot, "ls-files", "--cached", "--others", "--exclude-standard", "--"];
  if (roots.length === 1 && roots[0] === ".") {
    gitArgs.push(".");
  } else {
    gitArgs.push(...roots);
  }
  const { stdout } = await execFileAsync("git", gitArgs, { maxBuffer: 64 * 1024 * 1024 });
  return stdout
    .split(/\r?\n/g)
    .map((x) => x.trim())
    .filter((x) => !!x && (!extRe || extRe.test(x)));
}

export async function collectSourceFiles(repoRoot: string, roots: string[], extensions = [".kt", ".java"]) {
  const out = new Set<string>();
  for (const root of roots) {
    const normalizedRoot = root.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || ".";
    const absRoot = normalizedRoot === "." ? repoRoot : path.join(repoRoot, normalizedRoot);
    if (normalizedRoot !== "." && (await isNestedGitRepo(absRoot))) {
      const nestedFiles = await listGitSourceFiles(absRoot, ["."], extensions);
      for (const rel of nestedFiles) out.add(`${normalizedRoot}/${rel.replace(/\\/g, "/")}`);
      continue;
    }
    const scanRoots = normalizedRoot === "." ? ["."] : [normalizedRoot];
    const files = await listGitSourceFiles(repoRoot, scanRoots, extensions);
    for (const rel of files) out.add(rel.replace(/\\/g, "/"));
  }
  return [...out];
}

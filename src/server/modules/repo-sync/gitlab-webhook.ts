import type { GitLabWebhookEvent } from "./types";

function normalizeRemoteKey(value: string): string {
  return value
    .trim()
    .replace(/\.git$/i, "")
    .replace(/^git@[^:]+:/, "")
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function branchFromRef(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const m = ref.match(/^refs\/heads\/(.+)$/);
  return m ? m[1] : ref;
}

function projectRemoteKey(body: Record<string, unknown>): string {
  const project = (body.project || {}) as Record<string, unknown>;
  const candidates = [
    project.path_with_namespace,
    project.path_with_namespace && project.name ? `${project.path_with_namespace}/${project.name}` : null,
    project.web_url,
    project.git_http_url,
    project.http_url,
    project.ssh_url,
    body.repository && (body.repository as Record<string, unknown>).url,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return normalizeRemoteKey(c);
  }
  return "";
}

/**
 * GitLab Push Hook + Merge Request Hook（merged）
 */
export function parseGitLabWebhook(body: Record<string, unknown>): GitLabWebhookEvent {
  const kind = String(body.object_kind || "").toLowerCase();
  const remoteKey = projectRemoteKey(body);

  if (kind === "push") {
    const branch = branchFromRef(body.ref);
    const after = typeof body.after === "string" ? body.after : "";
    if (!remoteKey) return { kind: "ignored", reason: "missing_remote" };
    if (!branch) return { kind: "ignored", reason: "missing_branch" };
    if (!after || after === "0000000000000000000000000000000000000000") {
      return { kind: "ignored", reason: "delete_push" };
    }
    return { kind: "push", remoteKey, branch, commitSha: after };
  }

  if (kind === "merge_request") {
    const attrs = (body.object_attributes || {}) as Record<string, unknown>;
    const action = String(attrs.action || "").toLowerCase();
    const state = String(attrs.state || "").toLowerCase();
    const merged = action === "merge" || state === "merged";
    if (!merged) return { kind: "ignored", reason: `mr_not_merged:${action || state || "unknown"}` };
    const branch = typeof attrs.target_branch === "string" ? attrs.target_branch : branchFromRef(body.ref);
    const commitSha =
      (typeof attrs.merge_commit_sha === "string" && attrs.merge_commit_sha) ||
      (typeof attrs.last_commit === "object" &&
        attrs.last_commit &&
        typeof (attrs.last_commit as Record<string, unknown>).id === "string" &&
        ((attrs.last_commit as Record<string, unknown>).id as string)) ||
      "";
    if (!remoteKey) return { kind: "ignored", reason: "missing_remote" };
    if (!branch) return { kind: "ignored", reason: "missing_branch" };
    return { kind: "merge", remoteKey, branch, commitSha };
  }

  return { kind: "ignored", reason: `unsupported_object_kind:${kind || "unknown"}` };
}

export function remoteMatches(repoPatterns: string[], remoteKey: string): boolean {
  const key = normalizeRemoteKey(remoteKey);
  if (!key) return false;
  return repoPatterns.some((pattern) => {
    const p = normalizeRemoteKey(pattern);
    return key === p || key.endsWith(`/${p}`) || key.includes(p);
  });
}

export { normalizeRemoteKey };

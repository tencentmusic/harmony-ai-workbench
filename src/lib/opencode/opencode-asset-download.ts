export type AssetAuthMode = "user" | "admin";

export function buildAssetAuthHeaders(authMode: AssetAuthMode = "user"): Record<string, string> | null {
  if (typeof window === "undefined") return null;
  if (authMode === "admin") {
    const secret = localStorage.getItem("hm_admin_secret") || "";
    if (!secret) return null;
    return { "x-admin-secret": secret };
  }
  const token = localStorage.getItem("hm_token") || "";
  if (!token) return null;
  return { Authorization: `Bearer ${token}` };
}

export function filenameFromAssetPath(path: string): string {
  const name = path.split("/").pop() || "image.webp";
  return name.replace(/[^\w.\-()+@]/g, "_");
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function fetchOpencodeAssetBlob(path: string, authMode: AssetAuthMode = "user"): Promise<Blob> {
  const headers = buildAssetAuthHeaders(authMode);
  if (!headers) throw new Error("unauthorized");
  const res = await fetch(`/api/opencode/asset?${new URLSearchParams({ path })}`, { headers });
  if (!res.ok) throw new Error(`asset_${res.status}`);
  return res.blob();
}

export async function downloadOpencodeAsset(path: string, authMode: AssetAuthMode = "user") {
  const blob = await fetchOpencodeAssetBlob(path, authMode);
  triggerBlobDownload(blob, filenameFromAssetPath(path));
}

function uniqueZipName(base: string, used: Set<string>) {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let idx = 2;
  while (used.has(`${stem}_${idx}${ext}`)) idx += 1;
  const next = `${stem}_${idx}${ext}`;
  used.add(next);
  return next;
}

function zipFilename() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `android-assets-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.zip`;
}

export async function downloadOpencodeAssetsZip(
  items: Array<{ path: string }>,
  authMode: AssetAuthMode = "user",
) {
  if (!items.length) return;
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const usedNames = new Set<string>();
  for (const item of items) {
    const blob = await fetchOpencodeAssetBlob(item.path, authMode);
    zip.file(uniqueZipName(filenameFromAssetPath(item.path), usedNames), blob);
  }
  const out = await zip.generateAsync({ type: "blob" });
  triggerBlobDownload(out, zipFilename());
}

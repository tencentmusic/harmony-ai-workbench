import { prisma } from "@/lib/prisma";

export type KbSyncRunReport = {
  domain: "l2_codegraph";
  mode: "check" | "sync";
  canonical_count: number;
  db_count: number;
  canonical_hash: string;
  db_catalog_hash: string;
  in_sync: boolean;
  summary: Record<string, number>;
  rows?: unknown[];
  kb_git_rev?: string | null;
  generated_at?: string | null;
};

export async function recordSyncRun(
  report: KbSyncRunReport,
  options: { operator?: string; mode?: "check" | "sync" } = {},
) {
  await prisma.kbSyncRun.create({
    data: {
      domain: report.domain,
      mode: options.mode || report.mode,
      operator: options.operator || null,
      kbGitRev: report.kb_git_rev || null,
      canonicalHash: report.canonical_hash,
      resultJson: JSON.stringify({
        in_sync: report.in_sync,
        summary: report.summary,
        canonical_count: report.canonical_count,
        db_count: report.db_count,
        db_catalog_hash: report.db_catalog_hash,
        generated_at: report.generated_at,
      }),
    },
  });
}

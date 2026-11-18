import { listAndroidAppScopes } from "@/lib/android-class-index";
import { eventInBucket, parseOverviewChartRange, resolveOverviewTimeWindow } from "@/lib/admin-overview-range";
import { countOpencodeRequestsByStatus, listOpencodeRequestsInWindow } from "@/lib/opencode-request-store";
import { countMigrationDocs } from "@/lib/phase2-docs";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

function forbid() {
  return new Response("Forbidden", { status: 403 });
}

function personLabel(personName: string | null | undefined, personCode: string | null | undefined) {
  return personName?.trim() || personCode?.trim() || "匿名用户";
}

function jobCreatedWhere(start: Date | null, end: Date) {
  const createdAt: { gte?: Date; lte?: Date } = { lte: end };
  if (start) createdAt.gte = start;
  return createdAt;
}

export async function GET(req: Request) {
  if (req.headers.get("x-admin-secret") !== process.env.ADMIN_SECRET) return forbid();

  const url = new URL(req.url);
  const chartRange = parseOverviewChartRange(url.searchParams.get("range"));
  const window = resolveOverviewTimeWindow(chartRange);

  const tokenWhere = { apiTokenId: { not: null as string | null } };
  const chartJobWhere = {
    ...tokenWhere,
    createdAt: jobCreatedWhere(window.start, window.end),
  };

  const [
    tokenCount,
    totalAllTime,
    opencodeAllTime,
    totalInRange,
    doneInRange,
    failedInRange,
    runningInRange,
    opencodeCountsInRange,
    opencodeRows,
    jobsInRange,
    tokens,
  ] = await Promise.all([
    prisma.apiToken.count(),
    prisma.conversionJob.count({ where: tokenWhere }),
    countOpencodeRequestsByStatus(),
    prisma.conversionJob.count({ where: chartJobWhere }),
    prisma.conversionJob.count({ where: { ...chartJobWhere, status: "done" } }),
    prisma.conversionJob.count({ where: { ...chartJobWhere, status: "failed" } }),
    prisma.conversionJob.count({ where: { ...chartJobWhere, status: "running" } }),
    countOpencodeRequestsByStatus({ startAt: window.start, endAt: window.end }),
    listOpencodeRequestsInWindow(window.start, window.end),
    prisma.conversionJob.findMany({
      where: chartJobWhere,
      select: {
        createdAt: true,
        apiTokenId: true,
        apiToken: {
          select: {
            personName: true,
            personCode: true,
          },
        },
      },
    }),
    prisma.apiToken.findMany({
      select: { id: true, personName: true, personCode: true },
    }),
  ]);

  const tokenMap = new Map(tokens.map((t) => [t.id, t]));

  const bucketCounts = window.lineBuckets.map((b) => ({ day: b.key, count: 0 }));
  const personMap = new Map<string, number>();
  const personRankMap = new Map<string, number>();

  const bumpDay = (createdAt: string | Date) => {
    for (let i = 0; i < window.lineBuckets.length; i += 1) {
      if (eventInBucket(createdAt, window.lineBuckets[i])) {
        bucketCounts[i].count += 1;
        break;
      }
    }
  };

  const bumpPerson = (person: string, forRank = false) => {
    personMap.set(person, (personMap.get(person) || 0) + 1);
    if (forRank) personRankMap.set(person, (personRankMap.get(person) || 0) + 1);
  };

  for (const row of jobsInRange) {
    bumpDay(row.createdAt);
    const person = personLabel(row.apiToken?.personName, row.apiToken?.personCode);
    bumpPerson(person, true);
  }
  for (const row of opencodeRows) {
    bumpDay(row.createdAt);
    const person = personLabel(row.personName, row.personCode);
    bumpPerson(person, true);
  }

  const person7d = [...personMap.entries()]
    .map(([person, count]) => ({ person, count }))
    .sort((a, b) => b.count - a.count || a.person.localeCompare(b.person, "zh-CN"));

  const personRank = [...personRankMap.entries()]
    .map(([person, count]) => ({ person, count }))
    .sort((a, b) => b.count - a.count || a.person.localeCompare(b.person, "zh-CN"))
    .slice(0, 10);

  const appCount = listAndroidAppScopes().filter((x) => x.id !== "all").length;
  let migrationDocCount = 0;
  try {
    migrationDocCount = countMigrationDocs();
  } catch {
    migrationDocCount = 0;
  }

  const taskTotalAllTime = totalAllTime + opencodeAllTime.total;

  return Response.json({
    tokenCount,
    appCount,
    migrationDocCount,
    taskTotalAllTime,
    chartRange,
    chartRangeLabel: window.label,
    usageSummary: {
      total: totalInRange + opencodeCountsInRange.total,
      done: doneInRange + opencodeCountsInRange.done,
      failed: failedInRange + opencodeCountsInRange.failed,
      running: runningInRange + opencodeCountsInRange.running,
    },
    line7d: bucketCounts,
    person7d,
    personRank,
  });
}

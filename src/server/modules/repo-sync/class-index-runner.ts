import { rebuildAndroidClassIndexSlices } from "@/lib/android-class-index";
import { describeClassIndexSlices, planClassIndexSlicesForRepos } from "@/lib/class-index-slices";
import { listConfiguredRepos } from "./config";

export type ClassIndexRunResult = {
  skipped?: boolean;
  reason?: string;
  count?: number;
  slices?: string;
};

export function resolveClassIndexSlices(repoIds: string[]) {
  const configured = listConfiguredRepos();
  const repos = repoIds
    .map((id) => configured.find((repo) => repo.id === id))
    .filter((repo): repo is NonNullable<typeof repo> => !!repo);
  return planClassIndexSlicesForRepos(repos);
}

export async function runClassIndexForRepos(
  repoIds: string[],
  changed: boolean,
): Promise<ClassIndexRunResult> {
  const slices = resolveClassIndexSlices(repoIds);
  if (!slices.length) return { skipped: true, reason: "no_class_index" };
  if (!changed) return { skipped: true, reason: "no_code_change" };
  const result = await rebuildAndroidClassIndexSlices(slices);
  return {
    count: result.count,
    slices: describeClassIndexSlices(slices),
  };
}

export const CHANGELOG_SEEN_STORAGE_KEY = "hm_changelog_seen_token";

export type ChangelogRelease = {
  version: string;
  date: string;
  latest?: boolean;
  items: string[];
};

export function latestRelease(
  releases: ChangelogRelease[],
): ChangelogRelease | null {
  return releases.find((release) => release.latest === true) ?? releases[0] ?? null;
}

export function changelogSeenToken(release: ChangelogRelease | null): string {
  if (!release) return "";
  return [release.version, release.date, ...release.items].join("\n");
}

export function isChangelogUnread(
  latestToken: string,
  seenToken: string | null | undefined,
): boolean {
  return Boolean(latestToken) && seenToken !== latestToken;
}

const PRODUCTION_BUILD_PHASE = 'phase-production-build'

export function shouldStartIntegrationWorker(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env.NEXT_PHASE !== PRODUCTION_BUILD_PHASE
}

export async function initServerSide() {
  const { triggerAndroidClassIndexWarmup } = await import("@/lib/android-class-index");
  const { failRunningOpencodeRequestsOnStartup } = await import("@/lib/opencode-request-store");
  await failRunningOpencodeRequestsOnStartup().catch(() => {});
  triggerAndroidClassIndexWarmup();
  if (shouldStartIntegrationWorker(process.env)) {
    const { startIntegrationWorker } = await import("@/server/modules/integration/public");
    startIntegrationWorker();
    const { startPackageWorker } = await import("@/lib/package-comparison/worker");
    startPackageWorker();
  }
}

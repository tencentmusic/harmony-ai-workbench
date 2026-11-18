export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initServerSide } = await import("@/lib/instrumentation-node");
    await initServerSide();
  }
}

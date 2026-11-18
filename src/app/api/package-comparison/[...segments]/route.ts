import { packageApi } from "@/lib/package-comparison/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
async function handle(
  req: Request,
  context: { params: Promise<{ segments: string[] }> },
) {
  const response = await packageApi(req, (await context.params).segments);
  response.headers.set("cache-control", "no-store");
  return response;
}
export { handle as GET, handle as POST };

import { compressionApi } from "@/lib/image-compression/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
async function handle(req: Request, context: { params: Promise<{ segments: string[] }> }) {
  return compressionApi(req, (await context.params).segments);
}
export { handle as GET, handle as POST };

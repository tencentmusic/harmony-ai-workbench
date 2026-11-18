import { NextRequest, NextResponse } from "next/server";

import { verifyBearer } from "@/lib/token";
import {
  OpencodeAssetError,
  readOpencodeAsset,
} from "@/server/modules/opencode-assets/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAdminAuthorized(req: NextRequest) {
  const secret = req.headers.get("x-admin-secret");
  return !!secret && !!process.env.ADMIN_SECRET && secret === process.env.ADMIN_SECRET;
}

export async function GET(req: NextRequest) {
  const admin = isAdminAuthorized(req);
  const token = admin ? null : await verifyBearer(req.headers.get("authorization"));
  if (!admin && !token) return new NextResponse("Unauthorized", { status: 401 });

  try {
    const asset = await readOpencodeAsset({
      path: req.nextUrl.searchParams.get("path") || "",
      allowedScopeIds: token?.appScopeIds || [],
      tokenId: token?.id,
      admin,
    });
    return new NextResponse(new Uint8Array(asset.bytes), {
      headers: {
        "Content-Type": asset.contentType,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof OpencodeAssetError) {
      return new NextResponse(error.message, { status: error.status });
    }
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}

// png is the legacy download key for the original-format variant.
export type Variant = "png" | "webp" | "smallest";
export type CompressionRow = {
  name: string; format: "PNG" | "JPEG" | "WEBP"; width: number; height: number; originalBytes: number;
  pngBytes: number; webpBytes: number; smallestBytes: number;
  webpName: string; outputName: string; verified: boolean; note: string;
};
export type CompressionReport = {
  count: number; verifiedCount: number; originalBytes: number;
  duplicates: string[][]; rows: CompressionRow[];
  variants: Record<Variant, { bytes: number; zipBytes: number }>;
};
export type CompressionTask = {
  id: string; status: "running" | "succeeded" | "failed";
  completed: number; total: number; error?: string; report?: CompressionReport;
};

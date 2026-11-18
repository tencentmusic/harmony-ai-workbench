import { defaultTelemetryQueryBase, readTelemetryApiKey } from "@/lib/kb-telemetry-endpoints";

export function readTelemetryConfig() {
  return {
    queryBase: defaultTelemetryQueryBase(),
    apiKey: readTelemetryApiKey(),
  };
}

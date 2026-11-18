export function workbenchPublicBase(env: NodeJS.ProcessEnv = process.env) {
  const explicit = String(env.WORKBENCH_PUBLIC_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const port = env.DEPLOY_PORT || env.WORKBENCH_PORT || env.PORT || "3100";
  return `http://127.0.0.1:${port}`;
}

export function defaultTelemetryEventsUrl(env: NodeJS.ProcessEnv = process.env) {
  const explicit = String(env.KB_TELEMETRY_ENDPOINT || "").trim();
  if (explicit) return explicit;
  return `${workbenchPublicBase(env)}/api/kb-telemetry/v1/events`;
}

export function defaultTelemetryQueryBase(env: NodeJS.ProcessEnv = process.env) {
  const explicit = String(env.KB_TELEMETRY_QUERY_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return `${workbenchPublicBase(env)}/api/kb-telemetry/v1`;
}

export function readTelemetryApiKey(env: NodeJS.ProcessEnv = process.env) {
  return String(env.KB_TELEMETRY_API_KEY || "").trim();
}

export function authorizeTelemetryRequest(req: Request, env: NodeJS.ProcessEnv = process.env) {
  const key = readTelemetryApiKey(env);
  if (!key) return true;
  return req.headers.get("x-kb-telemetry-key") === key;
}

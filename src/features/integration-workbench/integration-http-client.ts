export class IntegrationUnauthorizedError extends Error {
  constructor() {
    super("登录状态已失效");
    this.name = "IntegrationUnauthorizedError";
  }
}

type IntegrationRequestDependencies = {
  token: string;
  onUnauthorized: () => void;
  fetchImpl?: typeof fetch;
};

function describeRequestError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const row = payload as {
    error?: unknown;
    message?: unknown;
    code?: unknown;
  };
  if (typeof row.error === "string") return row.error;
  if (typeof row.message === "string") return row.message;
  if (typeof row.code === "string") return row.code;
  return fallback;
}

export async function requestIntegrationJson<T>(
  url: string,
  init: RequestInit | undefined,
  dependencies: IntegrationRequestDependencies,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${dependencies.token}`);
  if (init?.body) headers.set("Content-Type", "application/json");

  const fetchImpl = dependencies.fetchImpl || fetch;
  const response = await fetchImpl(url, { ...init, headers });
  if (response.status === 401 || response.status === 403) {
    dependencies.onUnauthorized();
    throw new IntegrationUnauthorizedError();
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(
      describeRequestError(payload, `请求失败（HTTP ${response.status}）`),
    );
  }
  return payload as T;
}

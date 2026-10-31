/** A request the server refused, with the status and body so callers can react to the reason. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null): void { csrfToken = token; }

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = { method, headers: {} };
  if (body) {
    (opts.headers as Record<string, string>)["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  if (!["GET", "HEAD"].includes(method) && csrfToken) {
    (opts.headers as Record<string, string>)["X-CSRF-Token"] = csrfToken;
  }
  const r = await fetch(path, opts);
  const text = await r.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Server error: ${r.status} ${r.statusText}`);
  }
  if (!r.ok) throw new ApiError((data as { error?: string }).error || "Request failed", r.status, data);
  return data as T;
}

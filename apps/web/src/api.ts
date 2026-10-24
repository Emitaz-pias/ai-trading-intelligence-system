export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const apiPath = path.startsWith('/api') ? path : `/api${path}`;
  const response = await fetch(`${apiBaseUrl}${apiPath}`, {
    ...init, credentials: 'include', headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body.error || `Request failed (${response.status})`);
  return body as T;
}

export function webSocketUrl(): string {
  const configuredUrl = import.meta.env.VITE_WS_URL?.trim();
  if (configuredUrl) return configuredUrl;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export const json = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value) });
export const patchJson = (value: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(value) });

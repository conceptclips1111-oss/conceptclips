export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { ...options, credentials: 'same-origin', headers: { ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const data: any = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.error || 'Unable to connect. Please try again.', response.status);
  return data as T;
}
export const send = (method: string, data: unknown): RequestInit => ({ method, body: JSON.stringify(data) });

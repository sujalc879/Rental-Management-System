import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';

export const auth = createAuthClient({ plugins: [twoFactorClient()] });
export const Organization = createContext('');
export function useOrg() { return useContext(Organization); }
export const orgPath = (org: string, path: string) => `/api/orgs/${org}/${path}`;

export class ApiError extends Error {
  constructor(message: string, public code?: string) { super(message); }
}

export async function api<T>(path: string, { input, method = input === undefined ? 'GET' : 'POST', signal }: {
  input?: unknown; method?: string; signal?: AbortSignal;
} = {}): Promise<T> {
  const response = await fetch(path, input === undefined ? { signal } : {
    method, signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.issues?.[0]?.message || data.error || `Request failed (${response.status})`, data.code);
  return data;
}

export function useRecords<T>(path: string, enabled = true) {
  const org = useOrg();
  return useQuery({ queryKey: ['organization', org, path], queryFn: ({ signal }) => api<T>(orgPath(org, path), { signal }), enabled: enabled && !!org, retry: false });
}

export function useWrite() {
  const org = useOrg();
  const query = useQueryClient();
  return async <T,>(path: string, input: unknown = {}, method?: string) => {
    const result = await api<T>(orgPath(org, path), { input, method });
    const scope = { queryKey: ['organization', org] };
    await query.cancelQueries(scope);
    await query.invalidateQueries(scope);
    return result;
  };
}

export function queryString(values: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') search.set(key, String(value));
  return search.size ? `?${search}` : '';
}

// Typed client for the six Phase-0 endpoints. Base URL is `import.meta.env.VITE_API_BASE`
// or '' (same-origin) — the deployed SPA reaches the API through CloudFront, and local
// dev goes through the Vite proxy (see vite.config.ts). All bodies are JSON.

import type { GmSnapshot, PlayerPresence, PlayerSnapshot } from '@domain';

/** Base for every request. Empty string = same-origin. */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? '';

/** Error thrown for any non-2xx (and non-304) response, carrying the HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** Stable machine code from the backend error body, when present. */
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  error?: string;
  message?: string;
}

async function request<T>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, headers, ...rest } = init;
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });

  if (!res.ok) {
    let body: ErrorBody = {};
    try {
      body = (await res.json()) as ErrorBody;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, body.error, body.message ?? body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

// ---- Session lifecycle -----------------------------------------------------

export interface CreateSessionInput {
  chapterName?: string;
  glory?: number;
  ruin?: number;
  showRuin?: boolean;
}

export interface CreateSessionResult {
  code: string;
  role: 'gm';
  gmToken: string;
  state: GmSnapshot;
}

/** POST /sessions — create a live session and mint the GM token. */
export function createSession(input: CreateSessionInput = {}): Promise<CreateSessionResult> {
  return request<CreateSessionResult>('/sessions', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export interface JoinResult {
  playerId: string;
  joinSecret: string;
}

/** POST /sessions/{code}/join — register a pending player, get a one-time join secret. */
export function joinSession(code: string, name: string): Promise<JoinResult> {
  return request<JoinResult>(`/sessions/${encodeURIComponent(code)}/join`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

/** POST /sessions/{code}/claim — poll with the join secret; token arrives once admitted. */
export type ClaimResult =
  | { presence: Exclude<PlayerPresence, 'admitted'> }
  | { presence: 'admitted'; playerToken: string; index: number };

export function claim(code: string, playerId: string, joinSecret: string): Promise<ClaimResult> {
  return request<ClaimResult>(`/sessions/${encodeURIComponent(code)}/claim`, {
    method: 'POST',
    body: JSON.stringify({ playerId, joinSecret }),
  });
}

/** POST /sessions/{code}/admit — GM admits a pending player (Bearer GM token). */
export function admit(
  code: string,
  playerId: string,
  gmToken: string,
): Promise<{ ok: true; index: number }> {
  return request(`/sessions/${encodeURIComponent(code)}/admit`, {
    method: 'POST',
    token: gmToken,
    body: JSON.stringify({ playerId }),
  });
}

/** POST /sessions/{code}/kick — GM ignores (pending) or removes (admitted) a player. */
export function kick(
  code: string,
  playerId: string,
  gmToken: string,
): Promise<{ ok: true; presence: 'ignored' | 'removed' }> {
  return request(`/sessions/${encodeURIComponent(code)}/kick`, {
    method: 'POST',
    token: gmToken,
    body: JSON.stringify({ playerId }),
  });
}

// ---- State (polled) --------------------------------------------------------

export interface StateResult<T extends GmSnapshot | PlayerSnapshot> {
  /** null when the server answered 304 Not Modified — keep the prior snapshot. */
  snapshot: T | null;
  /** ETag to send as If-None-Match on the next poll (echoed back on a 304). */
  etag: string | null;
  notModified: boolean;
}

/**
 * GET /state/{code} — hydrate the board for a GM or player token. Pass the previous
 * `etag` to enable conditional requests; a 304 returns `{ snapshot: null, notModified: true }`.
 * The generic `T` is the caller's assertion of which projection this token yields.
 */
export async function getState<T extends GmSnapshot | PlayerSnapshot = GmSnapshot | PlayerSnapshot>(
  code: string,
  token: string,
  etag?: string | null,
  signal?: AbortSignal,
): Promise<StateResult<T>> {
  const res = await fetch(`${API_BASE}/state/${encodeURIComponent(code)}`, {
    method: 'GET',
    signal,
    headers: {
      authorization: `Bearer ${token}`,
      ...(etag ? { 'if-none-match': etag } : {}),
    },
  });

  if (res.status === 304) {
    return { snapshot: null, etag: res.headers.get('etag') ?? etag ?? null, notModified: true };
  }
  if (!res.ok) {
    let body: ErrorBody = {};
    try {
      body = (await res.json()) as ErrorBody;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, body.error, body.message ?? body.error ?? `HTTP ${res.status}`);
  }
  const snapshot = (await res.json()) as T;
  return { snapshot, etag: res.headers.get('etag'), notModified: false };
}

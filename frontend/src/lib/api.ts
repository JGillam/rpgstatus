// Typed client for the six Phase-0 endpoints. Base URL is `import.meta.env.VITE_API_BASE`
// or '' (same-origin) — the deployed SPA reaches the API through CloudFront, and local
// dev goes through the Vite proxy (see vite.config.ts). All bodies are JSON.

import type {
  AppliedCondition,
  GmSnapshot,
  Mob,
  MobTier,
  Player,
  PlayerPresence,
  PlayerSnapshot,
  PlayerStatus,
  SessionMeta,
} from '@domain';

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

// ---- Player mutations (Phase 1) --------------------------------------------

/** Fields a player may PATCH on their own card (all optional; server clamps/validates). */
export interface PlayerPatch {
  /** Character-setup max (D16 range). Raising/lowering re-clamps the current track server-side. */
  maxWounds?: number;
  /** Character-setup max (D16 range). Raising/lowering re-clamps the current track server-side. */
  maxShock?: number;
  wounds?: number;
  shock?: number;
  wrath?: number;
  status?: PlayerStatus;
  actedThisRound?: boolean;
  conditions?: AppliedCondition[];
}

/** POST /sessions/{code}/glory — push (+) / pull (−) shared Glory. Returns the new total. */
export function adjustGlory(code: string, token: string, delta: number): Promise<{ glory: number }> {
  return request(`/sessions/${encodeURIComponent(code)}/glory`, {
    method: 'POST',
    token,
    body: JSON.stringify({ delta }),
  });
}

/** PATCH /sessions/{code}/players/{playerId} — edit one's own card (Bearer player token). */
export function updatePlayer(
  code: string,
  token: string,
  playerId: string,
  patch: PlayerPatch,
): Promise<{ player: Player }> {
  return request(`/sessions/${encodeURIComponent(code)}/players/${encodeURIComponent(playerId)}`, {
    method: 'PATCH',
    token,
    body: JSON.stringify(patch),
  });
}

// ---- GM mutations (Phase 2 — Bearer GM token) ------------------------------

/** Fields the GM may PATCH on session meta (all optional; server clamps/validates). */
export interface SessionPatch {
  glory?: number;
  ruin?: number;
  showRuin?: boolean;
  round?: number;
  chapterName?: string;
}

/** Fields the GM may PATCH on a mob (all optional; server clamps/validates). */
export interface MobPatch {
  label?: string;
  tier?: MobTier;
  maxHp?: number;
  hp?: number;
  revealed?: boolean;
  actedThisRound?: boolean;
  conditions?: AppliedCondition[];
}

/** Body for the add-mob dialog (POST /mobs). `count` mobs are created at once (D18). */
export interface AddMobsInput {
  label: string;
  tier: MobTier;
  maxHp: number;
  count: number;
  startsHidden: boolean;
}

/** POST /sessions/{code}/ruin — raise (+) / lower (−) Ruin. Returns the new total. */
export function adjustRuin(code: string, token: string, delta: number): Promise<{ ruin: number }> {
  return request(`/sessions/${encodeURIComponent(code)}/ruin`, {
    method: 'POST',
    token,
    body: JSON.stringify({ delta }),
  });
}

/** PATCH /sessions/{code} — set-value edits to session meta (glory/ruin/showRuin/round/…). */
export function updateSession(
  code: string,
  token: string,
  patch: SessionPatch,
): Promise<{ session: SessionMeta }> {
  return request(`/sessions/${encodeURIComponent(code)}`, {
    method: 'PATCH',
    token,
    body: JSON.stringify(patch),
  });
}

/** POST /sessions/{code}/round/next — bump the round and clear every acted flag (D15). */
export function nextRound(code: string, token: string): Promise<{ round: number }> {
  return request(`/sessions/${encodeURIComponent(code)}/round/next`, { method: 'POST', token });
}

/** POST /sessions/{code}/end — mark the session ended (D22). */
export function endSession(code: string, token: string): Promise<{ ok: true }> {
  return request(`/sessions/${encodeURIComponent(code)}/end`, { method: 'POST', token });
}

/** POST /sessions/{code}/mobs — create `count` mobs from a spec. Returns the new mobs. */
export function addMobs(code: string, token: string, spec: AddMobsInput): Promise<{ mobs: Mob[] }> {
  return request(`/sessions/${encodeURIComponent(code)}/mobs`, {
    method: 'POST',
    token,
    body: JSON.stringify(spec),
  });
}

/** PATCH /sessions/{code}/mobs/{mobId} — edit one mob (hp, label, revealed, …). */
export function updateMob(
  code: string,
  token: string,
  mobId: string,
  patch: MobPatch,
): Promise<{ mob: Mob }> {
  return request(`/sessions/${encodeURIComponent(code)}/mobs/${encodeURIComponent(mobId)}`, {
    method: 'PATCH',
    token,
    body: JSON.stringify(patch),
  });
}

/** DELETE /sessions/{code}/mobs/{mobId} — remove a mob from the board. */
export function deleteMob(code: string, token: string, mobId: string): Promise<{ ok: true }> {
  return request(`/sessions/${encodeURIComponent(code)}/mobs/${encodeURIComponent(mobId)}`, {
    method: 'DELETE',
    token,
  });
}

/** POST /sessions/{code}/mobs/{mobId}/duplicate — clone a mob (fresh id, full HP). */
export function duplicateMob(code: string, token: string, mobId: string): Promise<{ mob: Mob }> {
  return request(
    `/sessions/${encodeURIComponent(code)}/mobs/${encodeURIComponent(mobId)}/duplicate`,
    { method: 'POST', token },
  );
}

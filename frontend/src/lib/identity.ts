// Client identity persisted in localStorage. Two records:
//   wg:identity — the confirmed session identity (GM, or an admitted player + token).
//   wg:pending  — a join in flight (holds the one-time joinSecret) until the GM admits.
// The token is a bearer credential; localStorage is the intended store for this MVP.

import { useCallback, useState } from 'react';
import type { Role } from '@domain';

const IDENTITY_KEY = 'wg:identity';
const PENDING_KEY = 'wg:pending';

/** A confirmed identity. `playerId`/`index` are present for players, absent for the GM. */
export interface Identity {
  code: string;
  role: Role;
  token: string;
  playerId?: string;
  index?: number;
  name?: string;
}

/** A join awaiting GM admission — polled on /waiting via the claim endpoint. */
export interface PendingJoin {
  code: string;
  playerId: string;
  joinSecret: string;
  name: string;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full / unavailable — non-fatal */
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export const loadIdentity = (): Identity | null => read<Identity>(IDENTITY_KEY);
export const saveIdentity = (identity: Identity): void => write(IDENTITY_KEY, identity);
export const clearIdentity = (): void => remove(IDENTITY_KEY);

export const loadPending = (): PendingJoin | null => read<PendingJoin>(PENDING_KEY);
export const savePending = (pending: PendingJoin): void => write(PENDING_KEY, pending);
export const clearPending = (): void => remove(PENDING_KEY);

/**
 * Reactive access to the confirmed identity. Setters persist and update local state so
 * routed pages re-render. (localStorage does not fire `storage` in the same tab, so this
 * intentionally does not subscribe cross-tab — a page reload picks up any external change.)
 */
export function useIdentity() {
  const [identity, setIdentity] = useState<Identity | null>(() => loadIdentity());

  const save = useCallback((next: Identity) => {
    saveIdentity(next);
    setIdentity(next);
  }, []);

  const clear = useCallback(() => {
    clearIdentity();
    setIdentity(null);
  }, []);

  const reload = useCallback(() => {
    setIdentity(loadIdentity());
  }, []);

  return { identity, save, clear, reload };
}

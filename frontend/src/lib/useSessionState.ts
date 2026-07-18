// Polls GET /state on an interval with ETag revalidation. Keeps the last snapshot on a
// 304, pauses while the tab is hidden, and cancels the in-flight request on unmount or
// when the {code, token} identity changes. Foundation for the GM/player screens.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GmSnapshot, PlayerSnapshot } from '@domain';
import { ApiError, getState } from './api';

/**
 * Poll cadences (ms) — deliberately casual-table pace, not RTS sync (D27).
 * The GM console leads (admits and table control should feel responsive); player
 * boards trail. Mutations still `refresh()` immediately, so interactions reconcile
 * fast — only passive staleness grows. The waiting room keeps its own quicker
 * claim cadence so "the GM admitted you" lands promptly.
 */
export const POLL_GM_MS = 5000;
export const POLL_PLAYER_MS = 8000;
export const POLL_CLAIM_MS = 2500;

export interface SessionStateArgs {
  code: string;
  token: string;
  /** Poll interval for this screen — pass POLL_GM_MS or POLL_PLAYER_MS. */
  pollMs: number;
}

/**
 * Why the last poll landed where it did — lets callers render the right lifecycle
 * takeover (SPEC §7.10) without inspecting raw errors:
 *   loading      — no response yet on this identity
 *   ok           — last poll succeeded (200 or 304)
 *   unauthorized — 401/403: the token no longer opens this session (rejoin)
 *   gone         — 404/410: the session/code is retired (expired)
 *   offline      — a transient failure (network / 5xx): reconnecting, keep last snapshot
 */
export type PollStatus = 'loading' | 'ok' | 'unauthorized' | 'gone' | 'offline';

/** Map a caught poll error to its lifecycle-relevant kind. */
function classifyError(e: unknown): PollStatus {
  if (e instanceof ApiError) {
    if (e.status === 404 || e.status === 410) return 'gone';
    if (e.status === 401 || e.status === 403) return 'unauthorized';
  }
  return 'offline';
}

export interface UseSessionState<T> {
  snapshot: T | null;
  /** Epoch ms of the last successful sync (200 or 304), or null before the first. */
  updatedAt: number | null;
  /** Whole seconds since `updatedAt`, ticking every second for a freshness indicator. */
  secondsAgo: number;
  error: Error | null;
  /** Discriminated reason for the last poll's outcome (see PollStatus). */
  status: PollStatus;
  loading: boolean;
  /** Force an immediate poll (e.g. on a manual refresh or when the tab regains focus). */
  refresh: () => void;
}

export function useSessionState<T extends GmSnapshot | PlayerSnapshot = GmSnapshot | PlayerSnapshot>(
  args: SessionStateArgs | null,
): UseSessionState<T> {
  const [snapshot, setSnapshot] = useState<T | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const [status, setStatus] = useState<PollStatus>('loading');
  const [loading, setLoading] = useState(true);

  const etagRef = useRef<string | null>(null);
  const updatedAtRef = useRef<number | null>(null);
  const inFlightRef = useRef<AbortController | null>(null);
  const runRef = useRef<() => void>(() => {});

  const code = args?.code ?? null;
  const token = args?.token ?? null;
  const pollMs = args?.pollMs ?? null;

  useEffect(() => {
    if (!code || !token || !pollMs) {
      setLoading(false);
      return;
    }

    let active = true;
    etagRef.current = null;
    setSnapshot(null);
    setError(null);
    setStatus('loading');
    setLoading(true);

    const run = async () => {
      if (document.visibilityState === 'hidden') return;
      inFlightRef.current?.abort();
      const ac = new AbortController();
      inFlightRef.current = ac;
      try {
        const res = await getState<T>(code, token, etagRef.current, ac.signal);
        if (!active) return;
        if (!res.notModified && res.snapshot) setSnapshot(res.snapshot);
        if (res.etag) etagRef.current = res.etag;
        const now = Date.now();
        updatedAtRef.current = now;
        setUpdatedAt(now);
        setSecondsAgo(0);
        setError(null);
        setStatus('ok');
      } catch (e) {
        if (!active || ac.signal.aborted) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setStatus(classifyError(e));
      } finally {
        // Clear the ref once THIS request settles (unless a newer one already
        // superseded it) so the next tick's abort() only ever targets a genuinely
        // in-flight request — never a completed one (which Chrome would otherwise
        // retroactively flag as net::ERR_ABORTED).
        if (inFlightRef.current === ac) {
          inFlightRef.current = null;
          if (active) setLoading(false);
        }
      }
    };

    runRef.current = run;
    void run();
    const interval = window.setInterval(run, pollMs);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void run();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      inFlightRef.current?.abort();
    };
  }, [code, token, pollMs]);

  // Independent 1s ticker so "updated Ns ago" advances between polls.
  useEffect(() => {
    const t = window.setInterval(() => {
      if (updatedAtRef.current != null) {
        setSecondsAgo(Math.floor((Date.now() - updatedAtRef.current) / 1000));
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, []);

  const refresh = useCallback(() => runRef.current(), []);

  return { snapshot, updatedAt, secondsAgo, error, status, loading, refresh };
}

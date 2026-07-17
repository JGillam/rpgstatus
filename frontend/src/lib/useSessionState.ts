// Polls GET /state on an interval with ETag revalidation. Keeps the last snapshot on a
// 304, pauses while the tab is hidden, and cancels the in-flight request on unmount or
// when the {code, token} identity changes. Foundation for the GM/player screens.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GmSnapshot, PlayerSnapshot } from '@domain';
import { getState } from './api';

/** Poll cadence (ms). ~2.5s balances freshness against the create/join throttle budget. */
export const POLL_MS = 2500;

export interface SessionStateArgs {
  code: string;
  token: string;
}

export interface UseSessionState<T> {
  snapshot: T | null;
  /** Epoch ms of the last successful sync (200 or 304), or null before the first. */
  updatedAt: number | null;
  /** Whole seconds since `updatedAt`, ticking every second for a freshness indicator. */
  secondsAgo: number;
  error: Error | null;
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
  const [loading, setLoading] = useState(true);

  const etagRef = useRef<string | null>(null);
  const updatedAtRef = useRef<number | null>(null);
  const inFlightRef = useRef<AbortController | null>(null);
  const runRef = useRef<() => void>(() => {});

  const code = args?.code ?? null;
  const token = args?.token ?? null;

  useEffect(() => {
    if (!code || !token) {
      setLoading(false);
      return;
    }

    let active = true;
    etagRef.current = null;
    setSnapshot(null);
    setError(null);
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
      } catch (e) {
        if (!active || ac.signal.aborted) return;
        setError(e instanceof Error ? e : new Error(String(e)));
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
    const interval = window.setInterval(run, POLL_MS);
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
  }, [code, token]);

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

  return { snapshot, updatedAt, secondsAgo, error, loading, refresh };
}

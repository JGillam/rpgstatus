import { POLL_PLAYER_MS } from '@/lib/useSessionState';
import { cn } from '@/lib/utils';

// Thresholds track the player-screen cadence (D27): a healthy cycle (≤ poll + 1s of
// ticker skew) stays green; one missed poll goes amber; beyond that, orange.
const FRESH_S = POLL_PLAYER_MS / 1000 + 1;
const AGING_S = FRESH_S + POLL_PLAYER_MS / 1000;

interface FreshnessDotProps {
  secondsAgo: number;
  /** Epoch ms of the last successful sync, or null before the first one lands. */
  updatedAt: number | null;
  error?: boolean;
  className?: string;
}

/**
 * Sync-status dot for the polled session state. The light alone carries status —
 * green when fresh, amber/orange as polls go missing, pulsing amber before the
 * first sync. No timer text: players don't need the countdown, only that it IS
 * syncing — text appears only when the connection is actually lost.
 */
export function FreshnessDot({ secondsAgo, updatedAt, error, className }: FreshnessDotProps) {
  const connecting = updatedAt === null && !error;

  const color = error
    ? 'var(--color-wounds)'
    : connecting
      ? 'var(--color-minor)'
      : secondsAgo <= FRESH_S
        ? 'var(--color-status-active)'
        : secondsAgo <= AGING_S
          ? 'var(--color-minor)'
          : 'var(--color-gravely)';

  return (
    <span
      className={cn('inline-flex items-center gap-2 text-xs text-muted', className)}
      title={error ? undefined : `synced ${secondsAgo}s ago`}
    >
      <span
        className={cn('inline-block size-2 rounded-full', connecting && 'animate-pulse')}
        style={{ background: color, boxShadow: `0 0 7px ${color}` }}
        aria-hidden
      />
      {error ? (
        <span>connection lost</span>
      ) : (
        <span className="sr-only">{connecting ? 'connecting' : 'synced'}</span>
      )}
    </span>
  );
}

import { cn } from '@/lib/utils';

interface FreshnessDotProps {
  secondsAgo: number;
  /** Epoch ms of the last successful sync, or null before the first one lands. */
  updatedAt: number | null;
  error?: boolean;
  className?: string;
}

/**
 * Small status dot + caption for the polled session state.
 * Amber pulse before the first sync, green when fresh, amber/orange as it ages,
 * red when the last poll errored.
 */
export function FreshnessDot({ secondsAgo, updatedAt, error, className }: FreshnessDotProps) {
  const connecting = updatedAt === null && !error;

  const color = error
    ? 'bg-wounds'
    : connecting
      ? 'bg-minor animate-pulse'
      : secondsAgo <= 6
        ? 'bg-status-active'
        : secondsAgo <= 15
          ? 'bg-minor'
          : 'bg-gravely';

  const label = error ? 'connection lost' : connecting ? 'connecting…' : `updated ${secondsAgo}s ago`;

  return (
    <span className={cn('inline-flex items-center gap-2 text-xs text-muted', className)}>
      <span className={cn('inline-block size-2 rounded-full', color)} aria-hidden />
      <span>{label}</span>
    </span>
  );
}
